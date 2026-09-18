/* Offline GeoPackage Viewer
   Uses locally vendored @ngageoint/geopackage + Leaflet.
   All processing stays in the browser. */

(function () {
  "use strict";

  const MAX_FEATURES_DEFAULT = 25000;
  const COLORS = [
    "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7",
    "#06b6d4", "#84cc16", "#f97316", "#ec4899", "#14b8a6"
  ];

  const state = {
    files: [], // { id, name, size, geoPackage, layers: [] }
    colorIndex: 0,
    selectedLayerKey: null,
    selectedMarker: null,
    moveMode: false,
    basemap: null,
    importedBasemaps: [],
    activeImportedId: null,
    featureLimit: MAX_FEATURES_DEFAULT,
    showLabels: true,
    labelField: "",
    labelMinZoom: 0,
    markerSize: 4,
    labelSize: 9,
    labelFrame: true,
    tableSortCol: "Tree ID",
    tableSortDir: 1,
    hiddenCols: (function () {
      try { return JSON.parse(localStorage.getItem("gpkg-viewer-hidden-cols") || "[]"); }
      catch (_) { return []; }
    })(),
    extraCols: (function () {
      try { return JSON.parse(localStorage.getItem("gpkg-viewer-extra-cols") || "[]"); }
      catch (_) { return []; }
    })(),
    addSpotMode: false,
    addSpotField: "",
    pdf: null,
    markerZoomRef: null
  };

  try {
    const saved = JSON.parse(localStorage.getItem("gpkg-viewer-sizes") || "null");
    if (saved && saved.markerSize) state.markerSize = saved.markerSize;
    if (saved && saved.labelSize) state.labelSize = saved.labelSize;
    if (saved && typeof saved.labelFrame === "boolean") state.labelFrame = saved.labelFrame;
  } catch (_) {}

  function persistSizes() {
    try {
      localStorage.setItem("gpkg-viewer-sizes", JSON.stringify({
        markerSize: state.markerSize,
        labelSize: state.labelSize,
        labelFrame: state.labelFrame
      }));
    } catch (_) {}
  }

  const $ = (id) => document.getElementById(id);

  // ---------- Map ----------
  const IS_TOUCH = window.matchMedia("(pointer: coarse)").matches ||
    "ontouchstart" in window;
  const IS_ANDROID = /Android/i.test(navigator.userAgent || "");
  if (IS_TOUCH) document.documentElement.classList.add("is-touch");
  if (IS_ANDROID) document.documentElement.classList.add("is-android");
  document.body.classList.toggle("is-touch", IS_TOUCH);
  document.body.classList.toggle("is-android", IS_ANDROID);

  const map = L.map("map", {
    worldCopyJump: false,
    minZoom: 0,
    maxZoom: 24,
    zoomControl: true,
    tap: true,
    tapTolerance: 25,
    bounceAtZoomLimits: false,
    preferCanvas: true,
    zoomAnimation: !IS_TOUCH,
    fadeAnimation: !IS_TOUCH,
    markerZoomAnimation: false,
    inertiaDeceleration: 3000
  }).setView([22.3193, 114.1694], 11); // Hong Kong default
  const markerRenderer = L.canvas({ padding: 0.6, tolerance: 4 });
  if (map.zoomControl) map.zoomControl.setPosition("topright");
  if (IS_TOUCH && map.doubleClickZoom) map.doubleClickZoom.disable();

  const blankPaneBg = document.querySelector(".leaflet-container");

  function setBasemap(mode) {
    if (state.basemap) {
      map.removeLayer(state.basemap);
      state.basemap = null;
    }
    if (state._offRoadZoom) {
      map.off("zoomend", state._offRoadZoom);
      state._offRoadZoom = null;
      state.offlineRoadCasing = null;
      state.offlineRoadFill = null;
    }
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.style.background = (mode === "hk-osm-off" || String(mode).indexOf("imp-") === 0) ? "#aad3df" : "";
    if (mode === "osm") {
      state.basemap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 24,
        maxNativeZoom: 19,
        attribution: "&copy; OpenStreetMap"
      });
      state.basemap.addTo(map);
      state.basemap.on("tileerror", () => {
        setStatus("Basemap tiles failed (offline?). Switch to Blank.", "warn");
      });
    } else if (mode === "carto") {
      state.basemap = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 24,
        maxNativeZoom: 20,
        attribution: "&copy; OSM &copy; CARTO"
      });
      state.basemap.addTo(map);
    } else if (mode === "esri") {
      state.basemap = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 24,
          maxNativeZoom: 19,
            attribution: "Tiles &copy; Esri"
        }
      );
      state.basemap.addTo(map);
    } else if (mode === "hk-imagery" || mode === "hk-map") {
      const attr = 'Map / Aerial Photograph from Lands Department';
      const baseUrl = mode === "hk-imagery"
        ? "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/imagery/WGS84/{z}/{x}/{y}.png"
        : "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png";
      const labelsUrl = "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/label/hk/tc/WGS84/{z}/{x}/{y}.png";
      const base = L.tileLayer(baseUrl, {
        maxZoom: 24,
        maxNativeZoom: 19,
        attribution: attr
      });
      const labels = L.tileLayer(labelsUrl, {
        maxZoom: 24,
        maxNativeZoom: 19,
        attribution: attr
      });
      base.on("tileerror", () => {
        setStatus("Hong Kong map tiles failed. Check the network.", "warn");
      });
      state.basemap = L.layerGroup([base, labels]);
      state.basemap.addTo(map);
    } else if (mode === "hk-osm-off") {
      state.activeImportedId = null;
      loadOfflineHkOsm("db", [[22.28536, 114.00084], [22.31340, 114.03096]], "Discovery Bay OSM extract");
    } else if (String(mode).indexOf("imp-") === 0) {
      const rec = (state.importedBasemaps || []).find((b) => b.id === mode);
      if (rec) {
        state.activeImportedId = rec.id;
        showOfflineOsmLayers(rec.layers, rec.bounds, rec.name);
      }
    }
    try { localStorage.setItem("gpkg-viewer-basemap", mode || "blank"); } catch (_) {}
    // blank: no tiles
  }

  async function gunzipJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Missing " + url);
    const buf = await res.arrayBuffer();
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot read the packed map. Update Safari / Chrome.");
    }
    const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  function emptyFc() {
    return { type: "FeatureCollection", features: [] };
  }

  function showOfflineOsmLayers(layers, fitBounds, label) {
    setStatus("Drawing " + (label || "OSM") + "…", "");
    if (!map.getPane("offlineBase")) {
      map.createPane("offlineBase");
      map.getPane("offlineBase").style.zIndex = "250";
      map.getPane("offlineBase").style.pointerEvents = "none";
    }
    const renderer = L.canvas({ pane: "offlineBase", padding: 0.4 });
    const group = L.layerGroup();
    const roadZoomScale = function () {
      const z = map.getZoom();
      return Math.max(0.75, Math.min(4.5, Math.pow(2, (z - 15) * 0.5)));
    };
    const roadStyle = function (feat, casing) {
      const s = roadZoomScale();
      const c = (feat.properties && feat.properties.c) || "";
      if (c === "motorway" || c === "motorway_link") return casing ? { color: "#dc2a67", weight: 5 * s, opacity: 1 } : { color: "#e892a2", weight: 3.2 * s, opacity: 1 };
      if (c === "trunk" || c === "trunk_link") return casing ? { color: "#c84e2f", weight: 4.5 * s, opacity: 1 } : { color: "#f9b29c", weight: 2.8 * s, opacity: 1 };
      if (c === "primary" || c === "primary_link") return casing ? { color: "#a06b00", weight: 4 * s, opacity: 1 } : { color: "#fcd6a4", weight: 2.4 * s, opacity: 1 };
      if (c === "secondary" || c === "secondary_link") return casing ? { color: "#707d05", weight: 3.6 * s, opacity: 1 } : { color: "#f7fabf", weight: 2.1 * s, opacity: 1 };
      if (c === "tertiary" || c === "tertiary_link") return casing ? { color: "#8f8f8f", weight: 3.2 * s, opacity: 1 } : { color: "#ffffff", weight: 1.8 * s, opacity: 1 };
      if (c === "residential" || c === "unclassified" || c === "living_street") return casing ? { color: "#8f8f8f", weight: 2.6 * s, opacity: 1 } : { color: "#ffffff", weight: 1.4 * s, opacity: 1 };
      if (c === "service" || c === "pedestrian") return casing ? { color: "#b0b0b0", weight: 2 * s, opacity: 1 } : { color: "#ffffff", weight: 1.1 * s, opacity: 1 };
      if (c === "footway" || c === "path" || c === "steps" || c === "cycleway") return casing ? { color: "#c97c5a", weight: 0, opacity: 0 } : { color: "#fa8072", weight: Math.max(1, 1.1 * s), opacity: 0.85, dashArray: "3,4" };
      return casing ? { color: "#ccc", weight: 2 * s, opacity: 1 } : { color: "#fff", weight: 1 * s, opacity: 1 };
    };
    try {
      const land = layers.land || emptyFc();
      group.addLayer(L.geoJSON(land, {
        renderer: renderer,
        interactive: false,
        style: (feat) => {
          const c = (feat.properties && feat.properties.c) || "";
          if (c === "forest" || c === "scrub" || c === "wood") return { color: "#9cba8e", weight: 0, fillColor: "#add19e", fillOpacity: 1 };
          if (c === "park" || c === "recreation_ground" || c === "grass" || c === "pitch" || c === "playground" || c === "grassland") return { color: "#8fd18c", weight: 0, fillColor: "#c8facc", fillOpacity: 1 };
          if (c === "beach") return { color: "#e8d9a0", weight: 0, fillColor: "#fff1ba", fillOpacity: 1 };
          if (c === "residential") return { color: "#d4d4d4", weight: 0, fillColor: "#e0dfdf", fillOpacity: 1 };
          if (c === "industrial" || c === "commercial" || c === "retail") return { color: "#e8dcd0", weight: 0, fillColor: "#ebd8c8", fillOpacity: 0.75 };
          if (c === "farmland") return { color: "#e6e6c8", weight: 0, fillColor: "#eef0d5", fillOpacity: 0.8 };
          return { color: "#ccc", weight: 0, fillColor: "#e8e4d8", fillOpacity: 0.7 };
        }
      }));
      const water = layers.water || emptyFc();
      group.addLayer(L.geoJSON(water, {
        renderer: renderer,
        interactive: false,
        style: { color: "#7eb4c7", weight: 0.4, fillColor: "#aad3df", fillOpacity: 1 }
      }));
      const buildings = layers.buildings || emptyFc();
      group.addLayer(L.geoJSON(buildings, {
        renderer: renderer,
        interactive: false,
        style: { color: "#c4b8a8", weight: 0.3, fillColor: "#d9d0c1", fillOpacity: 0.95 }
      }));
      const waterways = layers.waterways || emptyFc();
      group.addLayer(L.geoJSON(waterways, {
        renderer: renderer,
        interactive: false,
        style: { color: "#7eb4c7", weight: 1, opacity: 0.9 }
      }));
      const rail = layers.rail || emptyFc();
      group.addLayer(L.geoJSON(rail, {
        renderer: renderer,
        interactive: false,
        style: { color: "#707070", weight: 1.4, opacity: 0.9 }
      }));
      const roads = layers.roads || emptyFc();
      const roadCasing = L.geoJSON(roads, {
        renderer: renderer,
        interactive: false,
        style: (feat) => roadStyle(feat, true)
      });
      const roadFill = L.geoJSON(roads, {
        renderer: renderer,
        interactive: false,
        style: (feat) => roadStyle(feat, false)
      });
      group.addLayer(roadCasing);
      group.addLayer(roadFill);
      state.offlineRoadCasing = roadCasing;
      state.offlineRoadFill = roadFill;
      if (state._offRoadZoom) map.off("zoomend", state._offRoadZoom);
      state._offRoadZoom = function () {
        if (!state.offlineRoadCasing || IS_TOUCH) return;
        state.offlineRoadCasing.setStyle((feat) => roadStyle(feat, true));
        state.offlineRoadFill.setStyle((feat) => roadStyle(feat, false));
      };
      if (!IS_TOUCH) map.on("zoomend", state._offRoadZoom);
      const places = layers.places || emptyFc();
      group.addLayer(L.geoJSON(places, {
        pane: "offlineBase",
        interactive: false,
        pointToLayer: (feat, latlng) => L.circleMarker(latlng, {
          radius: 0,
          opacity: 0,
          fillOpacity: 0,
          renderer: renderer
        }),
        onEachFeature: (feat, layer) => {
          const n = feat.properties && feat.properties.n;
          if (n) layer.bindTooltip(n, { permanent: true, direction: "center", className: "offline-place", opacity: 0.9 });
        }
      }));
      if (state.basemap) map.removeLayer(state.basemap);
      state.basemap = group;
      group.addTo(map);
      if (fitBounds) map.fitBounds(fitBounds, { padding: [20, 20], maxZoom: 16 });
      setStatus((label || "Offline OSM") + " ready. © OpenStreetMap contributors.", "ok");
    } catch (err) {
      console.error(err);
      setStatus("Could not draw OSM basemap: " + (err && err.message ? err.message : err), "error");
    }
  }

  async function loadOfflineHkOsm(prefix, fitBounds, label) {
    prefix = prefix || "db";
    setStatus("Loading offline " + (label || "OSM") + "…", "");
    try {
      const layers = {
        land: await gunzipJson("offline/" + prefix + "-landuse.json.gz"),
        water: await gunzipJson("offline/" + prefix + "-water.json.gz"),
        buildings: await gunzipJson("offline/" + prefix + "-buildings.json.gz"),
        waterways: await gunzipJson("offline/" + prefix + "-waterways.json.gz"),
        rail: await gunzipJson("offline/" + prefix + "-rail.json.gz"),
        roads: await gunzipJson("offline/" + prefix + "-roads.json.gz"),
        places: await gunzipJson("offline/" + prefix + "-places.json.gz")
      };
      showOfflineOsmLayers(layers, fitBounds, label);
    } catch (err) {
      console.error(err);
      setStatus("Could not load offline OSM: " + (err && err.message ? err.message : err), "error");
    }
  }

  function osmTags(el) {
    const t = {};
    const kids = el.getElementsByTagName("tag");
    for (let i = 0; i < kids.length; i++) t[kids[i].getAttribute("k")] = kids[i].getAttribute("v");
    return t;
  }

  function parseOsmXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Not a valid OSM XML file");
    const nodes = {};
    let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    const nodeEls = doc.getElementsByTagName("node");
    const places = [];
    for (let i = 0; i < nodeEls.length; i++) {
      const el = nodeEls[i];
      const lat = parseFloat(el.getAttribute("lat"));
      const lon = parseFloat(el.getAttribute("lon"));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      nodes[el.getAttribute("id")] = [lon, lat];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      const tg = osmTags(el);
      if (tg.name && (tg.place || tg.amenity || tg.tourism || tg.highway === "bus_stop")) {
        places.push({ type: "Feature", properties: { n: tg.name, c: tg.place || tg.amenity || "" }, geometry: { type: "Point", coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] } });
      }
    }
    const boundsEl = doc.getElementsByTagName("bounds")[0];
    if (boundsEl) {
      minLat = parseFloat(boundsEl.getAttribute("minlat")) || minLat;
      minLon = parseFloat(boundsEl.getAttribute("minlon")) || minLon;
      maxLat = parseFloat(boundsEl.getAttribute("maxlat")) || maxLat;
      maxLon = parseFloat(boundsEl.getAttribute("maxlon")) || maxLon;
    }
    function lineOf(refs) {
      const pts = [];
      let last = "";
      for (let i = 0; i < refs.length; i++) {
        const p = nodes[refs[i]];
        if (!p) continue;
        const key = p[0].toFixed(6) + "," + p[1].toFixed(6);
        if (key === last) continue;
        pts.push([Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
        last = key;
      }
      return pts;
    }
    const roads = [], buildings = [], water = [], waterways = [], land = [], rail = [];
    const AREA_NAT = { water: 1, wood: 1, beach: 1, scrub: 1, grassland: 1, wetland: 1, bay: 1 };
    const wayEls = doc.getElementsByTagName("way");
    for (let i = 0; i < wayEls.length; i++) {
      const el = wayEls[i];
      const nds = el.getElementsByTagName("nd");
      const refs = [];
      for (let j = 0; j < nds.length; j++) refs.push(nds[j].getAttribute("ref"));
      const tg = osmTags(el);
      const pts = lineOf(refs);
      if (pts.length < 2) continue;
      if (tg.highway && tg.highway !== "bus_stop") {
        roads.push({ type: "Feature", properties: { c: tg.highway, n: tg.name || "" }, geometry: { type: "LineString", coordinates: pts } });
        continue;
      }
      if (tg.railway) {
        rail.push({ type: "Feature", properties: { c: tg.railway }, geometry: { type: "LineString", coordinates: pts } });
        continue;
      }
      if (tg.waterway && tg.waterway !== "riverbank") {
        waterways.push({ type: "Feature", properties: { c: tg.waterway }, geometry: { type: "LineString", coordinates: pts } });
        continue;
      }
      if (tg.natural === "coastline") {
        waterways.push({ type: "Feature", properties: { c: "coastline" }, geometry: { type: "LineString", coordinates: pts } });
        continue;
      }
      const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
      if (closed && (tg.building || tg.landuse || tg.leisure || AREA_NAT[tg.natural] || tg.area === "yes")) {
        const ring = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts : pts.concat([pts[0]]);
        if (ring.length < 4) continue;
        const geom = { type: "Polygon", coordinates: [ring] };
        if (tg.building) buildings.push({ type: "Feature", properties: {}, geometry: geom });
        else if (tg.natural === "water" || tg.natural === "wetland" || tg.natural === "bay" || tg.leisure === "swimming_pool" || tg.leisure === "marina") {
          water.push({ type: "Feature", properties: { c: tg.natural || tg.leisure }, geometry: geom });
        } else {
          land.push({ type: "Feature", properties: { c: tg.landuse || tg.natural || tg.leisure || "" }, geometry: geom });
        }
      }
    }
    return {
      layers: {
        land: { type: "FeatureCollection", features: land },
        water: { type: "FeatureCollection", features: water },
        buildings: { type: "FeatureCollection", features: buildings },
        waterways: { type: "FeatureCollection", features: waterways },
        rail: { type: "FeatureCollection", features: rail },
        roads: { type: "FeatureCollection", features: roads },
        places: { type: "FeatureCollection", features: places }
      },
      bounds: [[minLat, minLon], [maxLat, maxLon]]
    };
  }

  function defaultOsmName(fileName) {
    return String(fileName || "Imported OSM").replace(/\.osm(\.xml)?$/i, "").replace(/[_\-]+/g, " ").trim() || "Imported OSM";
  }

  function refreshImportedBasemapUi() {
    const sel = $("basemap");
    if (sel) {
      [...sel.querySelectorAll("option")].forEach((o) => {
        if (String(o.value).indexOf("imp-") === 0) o.remove();
      });
      let group = sel.querySelector("#imported-basemap-group");
      if (!state.importedBasemaps.length) {
        if (group) group.remove();
      } else {
        if (!group) {
          group = document.createElement("optgroup");
          group.id = "imported-basemap-group";
          group.label = "Imported (can rename / delete)";
          sel.appendChild(group);
        }
        group.innerHTML = "";
        state.importedBasemaps.forEach((b) => {
          const opt = document.createElement("option");
          opt.value = b.id;
          opt.textContent = b.name;
          group.appendChild(opt);
        });
      }
      if (state.activeImportedId) sel.value = state.activeImportedId;
    }
    const box = $("imported-basemap-list");
    if (!box) return;
    if (!state.importedBasemaps.length) {
      box.innerHTML = "";
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = state.importedBasemaps.map((b) => {
      const on = b.id === state.activeImportedId;
      return '<div class="import-row' + (on ? " on" : "") + '" data-id="' + escapeHtml(b.id) + '">' +
        '<span class="import-name" title="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + (on ? " (in use)" : "") + "</span>" +
        '<button type="button" class="btn" data-act="use">Use</button>' +
        '<button type="button" class="btn" data-act="rename">Rename</button>' +
        '<button type="button" class="btn danger-ghost" data-act="delete">Delete</button>' +
        "</div>";
    }).join("");
  }

  function renameImportedBasemap(id) {
    const rec = state.importedBasemaps.find((b) => b.id === id);
    if (!rec) return;
    const next = window.prompt("New name for this imported basemap:", rec.name);
    if (next == null) return;
    const name = String(next).trim();
    if (!name) {
      setStatus("Name cannot be empty.", "warn");
      return;
    }
    rec.name = name;
    refreshImportedBasemapUi();
    setStatus("Renamed imported basemap to “" + name + "”.", "ok");
  }

  function deleteImportedBasemap(id) {
    const rec = state.importedBasemaps.find((b) => b.id === id);
    if (!rec) return;
    if (!window.confirm("Delete imported basemap “" + rec.name + "”? Built-in maps are not affected.")) return;
    state.importedBasemaps = state.importedBasemaps.filter((b) => b.id !== id);
    if (state.activeImportedId === id) {
      state.activeImportedId = null;
      const sel = $("basemap");
      if (sel) sel.value = "blank";
      setBasemap("blank");
    }
    refreshImportedBasemapUi();
    idbDelete(id);
    setStatus("Deleted imported basemap “" + rec.name + "”.", "ok");
  }

  async function openOsmBasemap(file, opts) {
    opts = opts || {};
    setStatus("Reading " + file.name + "…", "");
    const buf = await file.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buf);
    const parsed = parseOsmXml(text);
    const rec = {
      id: opts.id || ("imp-" + Date.now() + "-" + Math.floor(Math.random() * 1000)),
      name: opts.title || defaultOsmName(file.name),
      layers: parsed.layers,
      bounds: parsed.bounds
    };
    state.importedBasemaps.push(rec);
    state.activeImportedId = rec.id;
    refreshImportedBasemapUi();
    const sel = $("basemap");
    if (sel) sel.value = rec.id;
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.style.background = "#aad3df";
    showOfflineOsmLayers(rec.layers, rec.bounds, rec.name);
    if (!opts.fromStore) persistOpenedFile("osm", rec.id, file, { bytes: new Uint8Array(buf), title: rec.name });
    try { localStorage.setItem("gpkg-viewer-basemap", rec.id); } catch (_) {}
  }

  setBasemap("blank");

  // ---------- GeoPackage library boot ----------
  function bootLibrary() {
    const GP = window.GeoPackage;
    if (!GP) {
      setStatus("Failed to load GeoPackage library (vendor/geopackage.min.js).", "error");
      return false;
    }
    if (typeof GP.setSqljsWasmLocateFile === "function") {
      GP.setSqljsWasmLocateFile((file) => "vendor/" + file);
    }
    return true;
  }

  function openGeoPackageBytes(bytes) {
    const GP = window.GeoPackage;
    const api = GP.GeoPackageAPI || GP.GeoPackageManager || GP;
    const opener = api && api.open;
    if (typeof opener !== "function") {
      throw new Error("GeoPackage open() API not found in vendor library");
    }
    return opener.call(api, bytes);
  }

  function skipGpkgReproject(gp, tableName) {
    try {
      const dao = gp.getFeatureDao(tableName);
      if (dao && dao.srs) {
        dao.srs.definition = undefined;
        dao.srs.organization_coordsys_id = 4326;
      }
    } catch (_) {}
  }

  function normalizePointFeature(ft) {
    if (!ft) return ft;
    if (!ft.geometry && ft.coordinates) {
      ft = { type: "Feature", properties: ft.properties || {}, geometry: { type: "Point", coordinates: ft.coordinates } };
    }
    const g = ft.geometry;
    if (!g || g.type !== "Point") return ft;
    let c = g.coordinates;
    if (c && !Array.isArray(c) && typeof c === "object") {
      c = [c.x != null ? c.x : c.lon != null ? c.lon : c.lng, c.y != null ? c.y : c.lat];
    }
    if (Array.isArray(c) && c.length >= 2) {
      let x = Number(c[0]);
      let y = Number(c[1]);
      if (x > 15 && x < 30 && y > 100 && y < 130) {
        const t = x; x = y; y = t;
      }
      g.coordinates = [x, y];
    }
    return ft;
  }

  function iterateFeatures(geoPackage, tableName) {
    skipGpkgReproject(geoPackage, tableName);
    if (typeof geoPackage.iterateGeoJSONFeatures === "function") {
      return geoPackage.iterateGeoJSONFeatures(tableName);
    }
    if (typeof geoPackage.queryForGeoJSONFeatures === "function") {
      return geoPackage.queryForGeoJSONFeatures(tableName);
    }
    if (typeof geoPackage.queryForGeoJSONFeaturesInTable === "function") {
      return geoPackage.queryForGeoJSONFeaturesInTable(tableName);
    }
    throw new Error("No GeoJSON query method on this GeoPackage build");
  }

  // ---------- UI helpers ----------
  let statusTimer = null;
  function setStatus(msg, kind) {
    const el = $("status");
    if (!el) return;
    el.hidden = false;
    el.textContent = msg || "";
    el.className = "status show " + (kind || "");
    if (statusTimer) clearTimeout(statusTimer);
    const ms = kind === "error" ? 6000 : 2800;
    statusTimer = setTimeout(function () {
      el.classList.remove("show");
    }, ms);
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function nextColor() {
    const c = COLORS[state.colorIndex % COLORS.length];
    state.colorIndex += 1;
    return c;
  }

  function layerKey(fileId, tableName) {
    return fileId + "::" + tableName;
  }

  const IDB_NAME = "gpkg-viewer-files";
  const IDB_STORE = "files";
  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("no idb"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function idbPut(rec) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(rec);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  async function idbDelete(id) {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (_) {}
  }
  async function idbClear() {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (_) {}
  }
  async function idbAll() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function persistOpenedFile(kind, id, file, extra) {
    try {
      const bytes = extra && extra.bytes ? extra.bytes : new Uint8Array(await file.arrayBuffer());
      await idbPut({
        id: id,
        kind: kind,
        name: file.name || (extra && extra.name) || "file",
        title: extra && extra.title,
        mime: file.type || "",
        bytes: bytes
      });
    } catch (err) {
      console.warn("Could not remember file", err);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function currentMarkerRadius() {
    const z = map.getZoom();
    const ref = state.markerZoomRef == null ? z : state.markerZoomRef;
    const scale = Math.pow(2, (z - ref) * 0.5);
    return Math.max(1.6, Math.min(32, state.markerSize * scale));
  }

  function styleFor(color, geomType) {
    const t = (geomType || "").toLowerCase();
    const r = currentMarkerRadius();
    if (t.includes("point")) {
      return {
        radius: r,
        color: "#0b1220",
        weight: r <= 3 ? 0.6 : 1,
        fillColor: color,
        fillOpacity: 0.88
      };
    }
    return {
      color: color,
      weight: t.includes("line") ? Math.max(1, r * 0.35) : Math.max(0.8, r * 0.25),
      opacity: 0.95,
      fillColor: color,
      fillOpacity: t.includes("line") ? 0 : 0.28
    };
  }

  function applyMarkerRadii() {
    const r = currentMarkerRadius();
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (ly.kind !== "feature" || !ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          if (typeof l.setRadius === "function") l.setRadius(r);
        });
      });
    });
    if (state.selectedMarker) updateFocusRing(state.selectedMarker);
  }

  function applyMarkerSize() {
    state.markerZoomRef = map.getZoom();
    applyMarkerRadii();
    applyAllLabels();
  }

  function applyLabelSize() {
    document.documentElement.style.setProperty("--label-size", state.labelSize + "px");
    syncMeasureFont();
    applyAllLabels();
  }

  function featureColor(layer, fallback) {
    const p = layer && layer.feature && layer.feature.properties;
    return (p && p._editColor) || fallback;
  }

  function applyFeatureStyle(layer, ly) {
    if (!layer || typeof layer.setStyle !== "function") return;
    const st = styleFor(featureColor(layer, ly.color), ly.geomType);
    if (state.selectedMarker === layer) {
      st.weight = 3;
      st.color = "#fbbf24";
    }
    layer.setStyle(st);
    if (typeof layer.setRadius === "function") layer.setRadius(st.radius);
    if (state.selectedMarker === layer) updateFocusRing(layer);
  }

  function pointToLayer(color) {
    return function (feature, latlng) {
      const c = (feature.properties && feature.properties._editColor) || color;
      const opt = styleFor(c, "point");
      opt.renderer = markerRenderer;
      opt.interactive = true;
      return L.circleMarker(latlng, opt);
    };
  }

  function bindPopup(layer, feature, tableName) {
    const props = (feature && feature.properties) || {};
    const keys = Object.keys(props);
    let html = '<div class="popup"><div class="popup-title">' + escapeHtml(tableName) + "</div>";
    if (!keys.length) {
      html += "<em>No attributes</em>";
    } else {
      html += "<table>";
      keys.forEach((k) => {
        html += "<tr><th>" + escapeHtml(k) + "</th><td>" + escapeHtml(props[k]) + "</td></tr>";
      });
      html += "</table>";
    }
    html += "</div>";
    layer.bindPopup(html, { maxWidth: 360, maxHeight: 280 });
  }

  function collectPropertyKeys(features) {
    const keys = [];
    const seen = {};
    features.forEach((ft) => {
      Object.keys((ft && ft.properties) || {}).forEach((k) => {
        if (!seen[k]) {
          seen[k] = true;
          keys.push(k);
        }
      });
    });
    return keys;
  }

  function guessLabelField(keys) {
    if (!keys || !keys.length) return "";
    const compact = (s) => String(s).toLowerCase().replace(/[\s_\-]/g, "");
    const prefs = [
      "treeid", "tree_id", "treeno", "treenumber", "tree_no", "tree_num",
      "plantid", "assetid", "featureid", "objectid", "fid", "gid", "id"
    ];
    for (const k of keys) {
      if (/樹|木|編號|编号/.test(k) && /id|no|num|編號|编号|碼|码/i.test(k + "id")) return k;
    }
    for (const k of keys) {
      if (/樹|木編號|树木编号|樹木/.test(k)) return k;
    }
    for (const p of prefs) {
      const hit = keys.find((k) => compact(k) === compact(p));
      if (hit) return hit;
    }
    const combo = keys.find((k) => /tree/i.test(k) && /id|no|num|code/i.test(k));
    if (combo) return combo;
    const anyId = keys.find((k) => /(^|_)id$/i.test(k) || /id$/i.test(k));
    return anyId || keys[0];
  }

  function labelText(feature, field) {
    if (!field || !feature) return "";
    const props = feature.properties || {};
    if (!Object.prototype.hasOwnProperty.call(props, field)) return "";
    const v = props[field];
    if (v == null || v === "") return "";
    return String(v);
  }

  function labelsShouldShow() {
    return !!(state.showLabels && map.getZoom() >= state.labelMinZoom);
  }

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  const labelBoxCache = {};

  function syncMeasureFont() {
    measureCtx.font = "700 " + state.labelSize + 'px "Segoe UI","PingFang HK","Noto Sans TC",system-ui,sans-serif';
    Object.keys(labelBoxCache).forEach((k) => { delete labelBoxCache[k]; });
  }
  syncMeasureFont();

  function bindFeatureLabel(layer) {
    if (!layer) return;
    try { if (layer.unbindTooltip) layer.unbindTooltip(); } catch (_) {}
    if (!labelsShouldShow()) return;
    const text = labelText(layer.feature, state.labelField);
    if (!text) return;
    layer.bindTooltip(escapeHtml(text), {
      permanent: true,
      direction: "right",
      offset: [Math.max(6, currentMarkerRadius() + 3), 0],
      className: "map-id-label" + (state.labelFrame ? "" : " no-frame"),
      opacity: 1,
      sticky: false
    });
  }

  function applyLabelsToLayer(ly) {
    if (!ly || !ly.leafletLayer || ly.kind !== "feature") return;
    ly.leafletLayer.eachLayer((l) => bindFeatureLabel(l));
  }

  function applyAllLabels() {
    state.files.forEach((f) => f.layers.forEach(applyLabelsToLayer));
  }

  function scheduleLabelUpdate() {}

  function parentLayerOf(marker) {
    let found = null;
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (ly.leafletLayer && ly.leafletLayer.hasLayer && ly.leafletLayer.hasLayer(marker)) {
          found = ly;
        }
      });
    });
    return found;
  }

  function loadColorEdits() {
    try { return JSON.parse(localStorage.getItem("gpkg-viewer-edits") || "{}"); }
    catch (_) { return {}; }
  }
  function persistColorEdits() {
    const edits = {};
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (!ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          if (!l.feature) return;
          const rec = {};
          const c = l.feature.properties && l.feature.properties._editColor;
          if (c) rec.color = c;
          if (typeof l.getLatLng === "function") {
            const ll = l.getLatLng();
            const orig = l.feature.properties && l.feature.properties._origLatLng;
            if (orig && (Math.abs(ll.lat - orig[0]) > 1e-8 || Math.abs(ll.lng - orig[1]) > 1e-8)) {
              rec.lat = ll.lat;
              rec.lng = ll.lng;
            }
          }
          const props = l.feature.properties || {};
          const orig = props._origProps;
          if (orig) {
            const changed = {};
            Object.keys(props).forEach((k) => {
              if (!k || k.charAt(0) === "_") return;
              if (String(props[k] == null ? "" : props[k]) !== String(orig[k] == null ? "" : orig[k])) {
                changed[k] = props[k];
              }
            });
            if (Object.keys(changed).length) rec.props = changed;
          }
          if (rec.color || rec.lat != null || rec.props) edits[featureKey(l, f.name)] = rec;
        });
      });
    });
    try { localStorage.setItem("gpkg-viewer-edits", JSON.stringify(edits)); } catch (_) {}
    persistAddedSpots();
  }
  function loadAddedSpots() {
    try { return JSON.parse(localStorage.getItem("gpkg-viewer-added") || "{}"); }
    catch (_) { return {}; }
  }
  function persistAddedSpots() {
    const out = loadAddedSpots();
    state.files.forEach((f) => {
      const list = [];
      f.layers.forEach((ly) => {
        (ly.features || []).forEach((ft) => {
          const p = ft.properties || {};
          if (!p._added) return;
          let lat = null;
          let lng = null;
          const marker = findMarkerForFeature(ly, ft);
          if (marker && typeof marker.getLatLng === "function") {
            const ll = marker.getLatLng();
            lat = ll.lat;
            lng = ll.lng;
          } else if (ft.geometry && ft.geometry.coordinates) {
            lng = ft.geometry.coordinates[0];
            lat = ft.geometry.coordinates[1];
          }
          const props = {};
          Object.keys(p).forEach((k) => {
            if (!k) return;
            if (k.charAt(0) === "_" && k !== "_addedId" && k !== "_editColor") return;
            props[k] = p[k];
          });
          list.push({ lat: lat, lng: lng, props: props });
        });
      });
      out[f.name] = list;
    });
    try { localStorage.setItem("gpkg-viewer-added", JSON.stringify(out)); } catch (_) {}
  }
  function persistExtraCols() {
    try { localStorage.setItem("gpkg-viewer-extra-cols", JSON.stringify(state.extraCols || [])); }
    catch (_) {}
  }
  function loadDeletedKeys() {
    try { return JSON.parse(localStorage.getItem("gpkg-viewer-deleted") || "{}"); }
    catch (_) { return {}; }
  }
  function persistDeletedKey(fileName, key) {
    if (!fileName || !key) return;
    const all = loadDeletedKeys();
    all[fileName] = all[fileName] || [];
    if (all[fileName].indexOf(key) < 0) all[fileName].push(key);
    try { localStorage.setItem("gpkg-viewer-deleted", JSON.stringify(all)); } catch (_) {}
  }
  function applyDeletedFeatures(fileRec, layer) {
    if (!fileRec || !layer || layer.kind !== "feature") return;
    const keys = loadDeletedKeys()[fileRec.name] || [];
    if (!keys.length) return;
    const set = {};
    keys.forEach((k) => { set[k] = true; });
    if (layer.leafletLayer) {
      const drop = [];
      layer.leafletLayer.eachLayer((l) => {
        if (set[featureKey(l, fileRec.name)] || (l.feature && l.feature.properties && set[l.feature.properties._origKey])) {
          drop.push(l);
        }
      });
      drop.forEach((l) => layer.leafletLayer.removeLayer(l));
    }
    layer.features = (layer.features || []).filter((ft) => {
      const k = featureKey({ feature: ft }, fileRec.name);
      const orig = ft.properties && ft.properties._origKey;
      return !set[k] && !set[orig];
    });
    layer.loaded = layer.features.length;
    if (layer.count != null) layer.count = layer.features.length;
  }
  function deleteCatalogItem(fileRec, layer, feat) {
    if (!layer || !feat) return;
    const marker = findMarkerForFeature(layer, feat);
    const label = labelText(feat, state.labelField) ||
      (feat.properties && (feat.properties["Tree ID"] || feat.properties.tree_no)) ||
      "this tree";
    if (!window.confirm("Delete “" + label + "”?\n\nThe spot on the map and this catalog row will both be removed.\nThis cannot be undone unless you re-open the original file from disk.")) {
      return;
    }
    if (marker && state.selectedMarker === marker) selectMarker(null);
    if (state.focusRing && marker) {
      map.removeLayer(state.focusRing);
      state.focusRing = null;
    }
    if (marker && layer.leafletLayer) layer.leafletLayer.removeLayer(marker);
    const idx = layer.features.indexOf(feat);
    if (idx >= 0) layer.features.splice(idx, 1);
    else {
      layer.features = layer.features.filter((ft) => ft !== feat);
    }
    layer.loaded = layer.features.length;
    if (layer.count != null) layer.count = Math.max(0, layer.count - 1);
    const key = featureKey(marker || { feature: feat }, fileRec && fileRec.name);
    persistDeletedKey(fileRec && fileRec.name, key);
    persistColorEdits();
    persistAddedSpots();
    renderSidebar();
    renderTable(layer);
    setStatus("Deleted “" + label + "” from map and catalog.", "ok");
  }
  function deleteSelectedSpot() {
    const marker = state.selectedMarker;
    if (!marker || !marker.feature) {
      setStatus("Select a spot first, then delete.", "warn");
      return;
    }
    const ly = parentLayerOf(marker);
    const fileRec = state.files.find((f) => (f.layers || []).indexOf(ly) >= 0);
    if (!ly) {
      setStatus("Could not find that catalog layer.", "warn");
      return;
    }
    deleteCatalogItem(fileRec, ly, marker.feature);
  }
  function allCatalogColumns(layer) {
    const set = new Set();
    ((layer && layer.columns) || []).forEach((k) => { if (k && k.charAt(0) !== "_") set.add(k); });
    (state.extraCols || []).forEach((k) => { if (k) set.add(k); });
    if (layer && layer.features) {
      layer.features.forEach((ft) => {
        Object.keys(ft.properties || {}).forEach((k) => {
          if (k && k.charAt(0) !== "_") set.add(k);
        });
      });
    }
    return Array.from(set);
  }
  function featureKey(marker, fileName) {
    const feat = marker.feature || {};
    const props = feat.properties || {};
    if (props._origKey) return props._origKey;
    const id = labelText(feat, state.labelField) || props.fid || props.id || "";
    const coords = (feat.geometry && feat.geometry.coordinates) || [];
    return (fileName || "") + "|" + id + "|" + coords.slice(0, 2).join(",");
  }
  function applySavedColor(marker, fileName) {
    if (!marker.feature) return;
    marker.feature.properties = marker.feature.properties || {};
    if (!marker.feature.properties._origKey) {
      marker.feature.properties._origKey = featureKey(marker, fileName);
    }
    if (!marker.feature.properties._origLatLng && typeof marker.getLatLng === "function") {
      const ll = marker.getLatLng();
      marker.feature.properties._origLatLng = [ll.lat, ll.lng];
    }
    if (!marker.feature.properties._origProps) {
      const snap = {};
      Object.keys(marker.feature.properties).forEach((k) => {
        if (k && k.charAt(0) !== "_") snap[k] = marker.feature.properties[k];
      });
      marker.feature.properties._origProps = snap;
    }
    const raw = loadColorEdits()[marker.feature.properties._origKey];
    const saved = typeof raw === "string" ? { color: raw } : (raw || null);
    if (!saved) return;
    if (saved.color) marker.feature.properties._editColor = saved.color;
    if (saved.lat != null && saved.lng != null && typeof marker.setLatLng === "function") {
      marker.setLatLng([saved.lat, saved.lng]);
      marker.feature.geometry = { type: "Point", coordinates: [saved.lng, saved.lat] };
    }
    if (saved.props && typeof saved.props === "object") {
      Object.keys(saved.props).forEach((k) => {
        marker.feature.properties[k] = saved.props[k];
      });
    }
  }
  function paintSpot(marker, color, save) {
    if (!marker || !marker.feature) return;
    marker.feature.properties = marker.feature.properties || {};
    if (color) marker.feature.properties._editColor = color;
    else delete marker.feature.properties._editColor;
    const ly = parentLayerOf(marker) || { color: color || "#3b82f6", geomType: "point" };
    applyFeatureStyle(marker, ly);
    if (save) persistColorEdits();
    refreshEditPanel();
    syncInspectChecks();
  }

  function focusRingSize() {
    return Math.round(Math.max(28, currentMarkerRadius() * 4 + 10));
  }

  function updateFocusRing(marker) {
    if (state.focusRing) {
      map.removeLayer(state.focusRing);
      state.focusRing = null;
    }
    if (!marker || typeof marker.getLatLng !== "function") return;
    const size = focusRingSize();
    const icon = L.divIcon({
      className: "focus-ring-icon",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: '<div class="focus-ring-dot"></div>'
    });
    state.focusRing = L.marker(marker.getLatLng(), {
      icon: icon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 600
    });
    state.focusRing.addTo(map);
  }

  function focusMarkerOnMap(marker) {
    if (!marker) {
      setStatus("Could not find that tree on the map.", "warn");
      return;
    }
    selectMarker(marker);
    if (typeof marker.getLatLng !== "function") return;
    const ll = marker.getLatLng();
    const wantZ = Math.max(map.getZoom(), 17);
    const tight = map.getBounds() && map.getBounds().pad(-0.28);
    if (tight && tight.contains(ll) && map.getZoom() >= 16) map.panTo(ll, { animate: !IS_TOUCH });
    else map.setView(ll, wantZ, { animate: !IS_TOUCH });
    updateFocusRing(marker);
    const id = labelText(marker.feature, state.labelField) || "tree";
    setStatus("Moved to " + id + ".", "ok");
  }

  function highlightCatalogRowByIndex(i) {
    const wrap = $("table-wrap");
    if (!wrap) return;
    wrap.querySelectorAll("tr.selected-row").forEach((tr) => tr.classList.remove("selected-row"));
    const tr = wrap.querySelector("tr[data-i='" + i + "']");
    if (tr) {
      tr.classList.add("selected-row");
      tr.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function highlightCatalogRowForMarker(marker) {
    if (!marker || !marker.feature) return;
    const ly = parentLayerOf(marker);
    if (!ly || !ly.features) return;
    let idx = -1;
    for (let i = 0; i < ly.features.length; i++) {
      if (ly.features[i] === marker.feature) { idx = i; break; }
    }
    if (idx < 0) {
      const key = (marker.feature.properties || {})._origKey;
      const fid = (marker.feature.properties || {}).fid;
      const tid = (marker.feature.properties || {})["Tree ID"] || (marker.feature.properties || {}).tree_no;
      for (let i = 0; i < ly.features.length; i++) {
        const p = ly.features[i].properties || {};
        if ((key && p._origKey === key) || (fid != null && p.fid === fid) || (tid && (p["Tree ID"] === tid || p.tree_no === tid))) {
          idx = i;
          break;
        }
      }
    }
    if (idx >= 0) highlightCatalogRowByIndex(idx);
  }

  function selectMarker(marker) {
    const prev = state.selectedMarker;
    state.selectedMarker = marker || null;
    if (prev) {
      const ly = parentLayerOf(prev);
      if (ly) applyFeatureStyle(prev, ly);
    }
    if (state.selectedMarker) {
      const ly = parentLayerOf(state.selectedMarker);
      if (ly) applyFeatureStyle(state.selectedMarker, ly);
      updateFocusRing(state.selectedMarker);
    } else if (state.focusRing) {
      map.removeLayer(state.focusRing);
      state.focusRing = null;
    }
    refreshEditPanel();
  }

  function refreshEditPanel() {
    const box = $("edit-panel");
    if (!box) return;
    const m = state.selectedMarker;
    if (!m || !m.feature) {
      box.hidden = true;
      if ($("edit-hint")) $("edit-hint").hidden = false;
      return;
    }
    box.hidden = false;
    if ($("edit-hint")) $("edit-hint").hidden = true;
    $("edit-id").textContent = labelText(m.feature, state.labelField) || "(no ID)";
    if ($("edit-coords")) {
      const p = m.feature.properties || {};
      const parts = [];
      const gf = findHkGridFields(p);
      if (gf.eKey && gf.nKey && p[gf.eKey] !== "" && p[gf.nKey] !== "") {
        parts.push(gf.eKey + " " + p[gf.eKey] + "  " + gf.nKey + " " + p[gf.nKey]);
      }
      if (typeof m.getLatLng === "function") {
        const ll = m.getLatLng();
        parts.push(ll.lat.toFixed(6) + ", " + ll.lng.toFixed(6) + " (WGS84)");
      }
      $("edit-coords").textContent = parts.join("  ·  ");
    }
    const ly = parentLayerOf(m);
    if ($("spot-color")) {
      $("spot-color").value = featureColor(m, (ly && ly.color) || "#3b82f6");
    }
  }

  let lastTap = { layer: null, t: 0 };
  let draggingMarker = null;
  let dragMoved = false;
  let touchHandledAt = 0;

  const INSPECT_RED = "#ef4444";

  function isInspectedColor(color) {
    return String(color || "").toLowerCase() === INSPECT_RED;
  }

  function markSpotRed(layer) {
    if (!layer) return;
    paintSpot(layer, INSPECT_RED, true);
    selectMarker(layer);
    setStatus("Marked " + (labelText(layer.feature, state.labelField) || "spot") + " inspected (red) and saved.", "ok");
  }

  function findMarkerForFeature(layer, feat) {
    if (!layer || !layer.leafletLayer || !feat) return null;
    let found = null;
    layer.leafletLayer.eachLayer((l) => {
      if (found || !l.feature) return;
      if (l.feature === feat) {
        found = l;
        return;
      }
      const a = l.feature.properties || {};
      const b = feat.properties || {};
      if ((a._origKey && b._origKey && a._origKey === b._origKey) ||
          (a["Tree ID"] && a["Tree ID"] === b["Tree ID"]) ||
          (a.fid != null && a.fid === b.fid)) {
        found = l;
      }
    });
    return found;
  }

  function syncInspectChecks() {
    const wrap = $("table-wrap");
    if (!wrap) return;
    wrap.querySelectorAll("input.inspect-ck").forEach((ck) => {
      const on = ck.getAttribute("data-on") === "1";
      const i = parseInt(ck.getAttribute("data-i"), 10);
      const found = findLayer(state.selectedLayerKey);
      const layer = found && found.layer;
      const feat = layer && layer.features && layer.features[i];
      const marker = feat ? findMarkerForFeature(layer, feat) : null;
      const inspected = !!(marker && marker.feature && isInspectedColor((marker.feature.properties || {})._editColor)) ||
        !!(feat && isInspectedColor((feat.properties || {})._editColor));
      ck.checked = inspected;
      const row = ck.closest("tr");
      if (row) row.classList.toggle("inspected", inspected);
    });
  }

  function nearestSpotAt(containerPoint) {
    let best = null;
    let bestD = Infinity;
    const tol = Math.max(30, currentMarkerRadius() + 18);
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (!ly.visible || !ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          if (typeof l.getLatLng !== "function") return;
          const p = map.latLngToContainerPoint(l.getLatLng());
          const d = p.distanceTo(containerPoint);
          if (d <= tol && d < bestD) {
            best = l;
            bestD = d;
          }
        });
      });
    });
    return best;
  }

  function handleSpotTap(layer) {
    if (!layer || dragMoved) {
      dragMoved = false;
      return;
    }
    const now = Date.now();
    if (lastTap.layer === layer && now - lastTap.t < 550) {
      lastTap = { layer: null, t: 0 };
      markSpotRed(layer);
      return;
    }
    lastTap = { layer: layer, t: now };
    selectMarker(layer);
    highlightCatalogRowForMarker(layer);
  }

  function attachEditHandlers(layer) {
    layer.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      if (Date.now() - touchHandledAt < 400) return;
      handleSpotTap(layer);
    });
    layer.on("dblclick", function (e) {
      L.DomEvent.stop(e);
      if (Date.now() - touchHandledAt < 400) return;
      markSpotRed(layer);
    });
    layer.on("mousedown", function (e) {
      if (!state.moveMode || state.selectedMarker !== layer || typeof layer.setLatLng !== "function") return;
      if (e.originalEvent && e.originalEvent.button != null && e.originalEvent.button !== 0) return;
      draggingMarker = layer;
      dragMoved = false;
      lastTap = { layer: null, t: 0 };
    });
  }

  function setMoveMode(on) {
    state.moveMode = !!on;
    document.body.classList.toggle("move-mode", state.moveMode);
    const btn = $("btn-move-spot");
    if (btn) {
      btn.classList.toggle("is-on", state.moveMode);
      btn.textContent = state.moveMode ? "Moving… tap again to stop" : "Move this spot";
    }
    if (!state.moveMode && draggingMarker) finishDrag();
    if (state.moveMode) {
      if (IS_TOUCH) setMenuOpen(false);
      setStatus("Move is on. Drag the yellow-ring spot. Tap Move again to stop.", "ok");
    }
  }

  const mapEl = map.getContainer();
  function touchPoint(ev) {
    const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]);
    if (!t) return null;
    const rect = mapEl.getBoundingClientRect();
    return L.point(t.clientX - rect.left, t.clientY - rect.top);
  }
  mapEl.addEventListener("touchstart", function (ev) {
    if (!state.moveMode || !state.selectedMarker || ev.touches.length !== 1) return;
    const pt = touchPoint(ev);
    if (!pt) return;
    const hit = nearestSpotAt(pt);
    if (hit !== state.selectedMarker) return;
    draggingMarker = hit;
    dragMoved = false;
    lastTap = { layer: null, t: 0 };
  }, { passive: true });
  mapEl.addEventListener("touchmove", function (ev) {
    if (!draggingMarker) return;
    ev.preventDefault();
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    draggingMarker.setLatLng(map.mouseEventToLatLng(t));
    dragMoved = true;
  }, { passive: false });
  function onTouchTap(ev) {
    if (draggingMarker) {
      ev.preventDefault();
      finishDrag();
      return;
    }
    if (!ev.changedTouches || ev.changedTouches.length !== 1) return;
    if (state.moveMode) return;
    const pt = touchPoint(ev);
    if (!pt) return;
    const hit = nearestSpotAt(pt);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    touchHandledAt = Date.now();
    handleSpotTap(hit);
  }
  mapEl.addEventListener("touchend", onTouchTap, { passive: false });
  map.on("mousemove", function (e) {
    if (!draggingMarker) return;
    if (!dragMoved) {
      map.dragging.disable();
      dragMoved = true;
    }
    draggingMarker.setLatLng(e.latlng);
    if (state.focusRing && typeof state.focusRing.setLatLng === "function") {
      state.focusRing.setLatLng(e.latlng);
    }
  });
  function finishDrag() {
    const m = draggingMarker;
    if (!m) {
      if (map.dragging && map.dragging.enable) map.dragging.enable();
      return;
    }
    if (typeof m.getLatLng === "function" && m.feature) {
      const ll = m.getLatLng();
      m.feature.geometry = { type: "Point", coordinates: [ll.lng, ll.lat] };
      m.feature.properties = m.feature.properties || {};
      let ly = null;
      state.files.forEach((f) => f.layers.forEach((layer) => {
        if (layer.leafletLayer && layer.leafletLayer.hasLayer && layer.leafletLayer.hasLayer(m)) ly = layer;
      }));
      writeCoordsToProps(m.feature.properties, ly, ll.lat, ll.lng);
      if (ly && ly.features) {
        ly.features.forEach((ft) => {
          if (ft === m.feature) writeCoordsToProps(ft.properties || (ft.properties = {}), ly, ll.lat, ll.lng);
        });
      }
      bindFeatureLabel(m);
      if (ly) renderTable(ly);
      persistColorEdits();
      refreshEditPanel();
      updateFocusRing(m);
      if (dragMoved) setStatus("Moved " + (labelText(m.feature, state.labelField) || "spot") + " and saved.", "ok");
    }
    draggingMarker = null;
    dragMoved = false;
    if (map.dragging && map.dragging.enable) map.dragging.enable();
  }
  map.on("mouseup", finishDrag);
  window.addEventListener("mouseup", finishDrag);
  window.addEventListener("pointerup", finishDrag);
  map.on("zoomstart", function () {
    if (draggingMarker && !dragMoved) {
      draggingMarker = null;
      if (map.dragging && map.dragging.enable) map.dragging.enable();
    }
  });
  map.on("click", function (ev) {
    if (state.treePlan && state.treePlan.pendingPdf) {
      onTreePlanMapClick(ev.latlng);
      return;
    }
    if (state.addSpotMode) {
      addSpotAt(ev.latlng);
      return;
    }
    if (draggingMarker || dragMoved) return;
    if (Date.now() - touchHandledAt < 400) return;
    const pt = ev.containerPoint || (ev.originalEvent && map.mouseEventToContainerPoint(ev.originalEvent));
    const hit = pt ? nearestSpotAt(pt) : null;
    if (hit) {
      handleSpotTap(hit);
      return;
    }
    if (state.moveMode) return;
    selectMarker(null);
  });

  function targetLayerForNewSpot() {
    const found = currentCatalogLayer ? currentCatalogLayer() : null;
    if (found && found.layer && found.file) return found;
    for (let i = 0; i < state.files.length; i++) {
      const f = state.files[i];
      const ly = (f.layers || []).find((l) => l.kind === "feature");
      if (ly) return { file: f, layer: ly };
    }
    return null;
  }

  function restoreAddedSpots(fileRec, layer) {
    if (!fileRec || !layer || layer.kind !== "feature") return;
    const list = (loadAddedSpots()[fileRec.name] || []);
    list.forEach((item) => {
      if (!item || item.lat == null || item.lng == null) return;
      const id = item.props && item.props._addedId;
      const exists = (layer.features || []).some((ft) => ft.properties && ft.properties._addedId && ft.properties._addedId === id);
      if (exists) return;
      const props = Object.assign({}, item.props || {});
      props._added = true;
      if (!props._addedId) props._addedId = "add-" + Date.now() + "-" + Math.floor(Math.random() * 9999);
      (state.extraCols || []).forEach((c) => { if (props[c] == null) props[c] = ""; });
      placeSpotOnLayer(fileRec, layer, item.lat, item.lng, props, true);
    });
  }

  function placeSpotOnLayer(fileRec, layer, lat, lng, props, silent) {
    const feat = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: props
    };
    layer.features = layer.features || [];
    layer.features.push(feat);
    layer.loaded = (layer.loaded || 0) + 1;
    layer.count = (layer.count || 0) + 1;
    if (layer.columns && props) {
      Object.keys(props).forEach((k) => {
        if (k && k.charAt(0) !== "_" && layer.columns.indexOf(k) < 0) layer.columns.push(k);
      });
    }
    if (!layer.leafletLayer) return null;
    const marker = L.circleMarker([lat, lng], styleFor(layer.color || "#3b82f6", "point"));
    marker.feature = feat;
    if (markerRenderer) marker.options.renderer = markerRenderer;
    bindPopup(marker, feat, layer.tableName);
    attachEditHandlers(marker);
    applySavedColor(marker, fileRec.name);
    applyFeatureStyle(marker, layer);
    bindFeatureLabel(marker);
    layer.leafletLayer.addLayer(marker);
    if (!silent) {
      persistAddedSpots();
      persistColorEdits();
    }
    return marker;
  }

  function setAddSpotMode(on) {
    state.addSpotMode = !!on;
    if (state.addSpotMode) setMoveMode(false);
    document.body.classList.toggle("add-spot-mode", state.addSpotMode);
    const btn = $("btn-add-spot");
    if (btn) {
      btn.classList.toggle("is-on", state.addSpotMode);
      btn.textContent = state.addSpotMode ? "Tap map to place… tap here to stop" : "Add spot on map";
    }
    if (state.addSpotMode) setStatus("Tap the map to add a named spot.", "ok");
  }

  function addSpotAt(latlng) {
    const found = targetLayerForNewSpot();
    if (!found) {
      setStatus("Open a catalog file first, then add a spot.", "warn");
      setAddSpotMode(false);
      return;
    }
    const fieldSel = $("add-spot-field");
    const field = (fieldSel && fieldSel.value) || state.addSpotField || state.labelField || "Tree No.";
    state.addSpotField = field;
    let name = $("add-spot-name") ? String($("add-spot-name").value || "").trim() : "";
    if (!name) name = window.prompt("Name for this spot (saved in “" + field + "”):", "") || "";
    name = String(name || "").trim();
    if (!name) {
      setStatus("Spot not added — name is empty.", "warn");
      return;
    }
    const props = { _added: true, _addedId: "add-" + Date.now() + "-" + Math.floor(Math.random() * 9999) };
    allCatalogColumns(found.layer).forEach((c) => { props[c] = props[c] || ""; });
    props[field] = name;
    writeCoordsToProps(props, found.layer, latlng.lat, latlng.lng);
    const marker = placeSpotOnLayer(found.file, found.layer, latlng.lat, latlng.lng, props, false);
    if ($("add-spot-name")) $("add-spot-name").value = "";
    refreshLabelFieldOptions();
    renderSidebar();
    if (state.selectedLayerKey !== found.layer.key) selectLayer(found.layer.key);
    else renderTable(found.layer);
    if (marker) {
      selectMarker(marker);
      focusMarkerOnMap(marker);
    }
    setStatus("Added “" + name + "” in column " + field + ".", "ok");
  }

  function addCatalogColumn() {
    const raw = window.prompt("New catalog column name:", "");
    const name = String(raw || "").trim();
    if (!name) return;
    if (name.charAt(0) === "_") {
      setStatus("Column name cannot start with _.", "warn");
      return;
    }
    const exists = (state.extraCols || []).some((c) => c.toLowerCase() === name.toLowerCase());
    if (exists) {
      setStatus("Column “" + name + "” already exists.", "warn");
      return;
    }
    state.extraCols = state.extraCols || [];
    state.extraCols.push(name);
    persistExtraCols();
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (ly.kind !== "feature") return;
        ly.columns = ly.columns || [];
        if (ly.columns.indexOf(name) < 0) ly.columns.push(name);
        (ly.features || []).forEach((ft) => {
          ft.properties = ft.properties || {};
          if (ft.properties[name] == null) ft.properties[name] = "";
        });
      });
    });
    refreshLabelFieldOptions();
    const found = currentCatalogLayer ? currentCatalogLayer() : findLayer(state.selectedLayerKey);
    renderTable(found && found.layer ? found.layer : (found));
    setStatus("Added column “" + name + "”. It will appear at the end of Excel export.", "ok");
  }

  function refreshLabelFieldOptions() {
    const sel = $("label-field");
    if (!sel) return;
    const keys = [];
    const seen = {};
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        (ly.columns || []).forEach((k) => {
          if (k && !seen[k]) {
            seen[k] = true;
            keys.push(k);
          }
        });
      });
    });
    (state.extraCols || []).forEach((k) => {
      if (k && !seen[k]) {
        seen[k] = true;
        keys.push(k);
      }
    });
    if (!state.labelField && keys.length) state.labelField = guessLabelField(keys);
    if (state.labelField && keys.indexOf(state.labelField) === -1 && keys.length) {
      state.labelField = guessLabelField(keys);
    }
    const prev = state.labelField;
    sel.innerHTML = keys.length
      ? keys.map((k) => '<option value="' + escapeHtml(k) + '"' + (k === prev ? " selected" : "") + ">" + escapeHtml(k) + "</option>").join("")
      : '<option value="">(no fields)</option>';
    if (prev) sel.value = prev;
    fillAddSpotFieldSelect(keys);
  }

  function fillAddSpotFieldSelect(keys) {
    const sel = $("add-spot-field");
    if (!sel) return;
    const list = (keys && keys.length) ? keys.slice() : [];
    (state.extraCols || []).forEach((k) => { if (k && list.indexOf(k) < 0) list.push(k); });
    if (!state.addSpotField) {
      const prefer = list.find((k) => /tree\s*(no|id|num|ref)/i.test(k)) || state.labelField || list[0] || "";
      state.addSpotField = prefer;
    }
    if (state.addSpotField && list.indexOf(state.addSpotField) < 0 && state.addSpotField) list.unshift(state.addSpotField);
    sel.innerHTML = list.length
      ? list.map((k) => '<option value="' + escapeHtml(k) + '"' + (k === state.addSpotField ? " selected" : "") + ">" + escapeHtml(k) + "</option>").join("")
      : '<option value="">(no columns)</option>';
    if (state.addSpotField) sel.value = state.addSpotField;
  }

  // ---------- Load file ----------
  async function openGpkgFile(file, opts) {
    opts = opts || {};
    if (!bootLibrary()) return;
    setStatus("Opening " + file.name + " …", "");
    $("dropzone").classList.add("busy");

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const geoPackage = await openGeoPackageBytes(bytes);

      const fileId = opts.id || ("f" + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
      const rec = {
        id: fileId,
        name: file.name,
        size: file.size,
        geoPackage: geoPackage,
        originalBytes: bytes,
        layers: []
      };

      const featureTables = geoPackage.getFeatureTables() || [];
      const tileTables = geoPackage.getTileTables() || [];

      for (const table of featureTables) {
        rec.layers.push(await buildFeatureLayer(rec, table));
      }
      for (const table of tileTables) {
        rec.layers.push(await buildTileLayer(rec, table));
      }

      state.files.push(rec);
      refreshLabelFieldOptions();
      applyAllLabels();
      renderSidebar();

      const firstVisible = rec.layers.find((l) => l.leafletLayer);
      if (firstVisible && firstVisible.leafletLayer.getBounds && firstVisible.leafletLayer.getBounds().isValid()) {
        map.fitBounds(firstVisible.leafletLayer.getBounds(), { padding: [28, 28], maxZoom: 16 });
      }

      const nFeat = featureTables.length;
      const nTile = tileTables.length;
      if (!opts.fromStore) persistOpenedFile("gpkg", fileId, file, { bytes: bytes });
      setStatus(
        "Loaded " + file.name + " — " + nFeat + " vector layer" + (nFeat === 1 ? "" : "s") +
          ", " + nTile + " tile layer" + (nTile === 1 ? "" : "s") + ".",
        "ok"
      );

      if (!nFeat && !nTile) {
        setStatus(file.name + " opened, but no feature or tile tables were found.", "warn");
      }
    } catch (err) {
      console.error(err);
      setStatus("Could not open " + file.name + ": " + (err && err.message ? err.message : err), "error");
    } finally {
      $("dropzone").classList.remove("busy");
      if (IS_TOUCH) setMenuOpen(false);
    }
  }

  function looksLikeHkGrid(e, n) {
    return e > 700000 && e < 900000 && n > 700000 && n < 900000;
  }

  function hk1980GridToWgs84(easting, northing) {
    const a = 6378388.0;
    const f = 1 / 297.0;
    const e2 = 2 * f - f * f;
    const lat0 = 22.3121333333333 * Math.PI / 180;
    const lon0 = 114.178555555556 * Math.PI / 180;
    const FE = 836694.05;
    const FN = 819069.80;
    const k0 = 1;
    function mer(phi) {
      const e4 = e2 * e2;
      const e6 = e4 * e2;
      const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
      const A2 = (3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128);
      const A4 = (15 / 256) * (e4 + 3 * e6 / 4);
      const A6 = 35 * e6 / 3072;
      return a * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
    }
    const E = easting - FE;
    const N = northing - FN;
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const M = mer(lat0) + N / k0;
    const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    const phi1 = mu
      + (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu)
      + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
      + (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu);
    const sinp = Math.sin(phi1);
    const cosp = Math.cos(phi1);
    const tanp = Math.tan(phi1);
    const ep2 = e2 / (1 - e2);
    const nu = a / Math.sqrt(1 - e2 * sinp * sinp);
    const rho = a * (1 - e2) / Math.pow(1 - e2 * sinp * sinp, 1.5);
    const T = tanp * tanp;
    const C = ep2 * cosp * cosp;
    const D = E / (nu * k0);
    const phi = phi1 - (nu * tanp / rho) * (
      D * D / 2
      - (5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * Math.pow(D, 4) / 24
      + (61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * Math.pow(D, 6) / 720
    );
    const lam = lon0 + (
      D
      - (1 + 2 * T + C) * Math.pow(D, 3) / 6
      + (5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * Math.pow(D, 5) / 120
    ) / cosp;
    const lon80 = lam * 180 / Math.PI;
    const lat80 = phi * 180 / Math.PI;
    return [lon80 + 8.8 / 3600, lat80 - 5.5 / 3600];
  }

  function wgs84ToHk1980Grid(lonWgs, latWgs) {
    const lon80 = lonWgs - 8.8 / 3600;
    const lat80 = latWgs + 5.5 / 3600;
    const a = 6378388.0;
    const f = 1 / 297.0;
    const e2 = 2 * f - f * f;
    const lat0 = 22.3121333333333 * Math.PI / 180;
    const lon0 = 114.178555555556 * Math.PI / 180;
    const FE = 836694.05;
    const FN = 819069.80;
    const k0 = 1;
    function mer(phi) {
      const e4 = e2 * e2;
      const e6 = e4 * e2;
      const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
      const A2 = (3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128);
      const A4 = (15 / 256) * (e4 + 3 * e6 / 4);
      const A6 = 35 * e6 / 3072;
      return a * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
    }
    const phi = lat80 * Math.PI / 180;
    const lam = lon80 * Math.PI / 180;
    const sinp = Math.sin(phi);
    const cosp = Math.cos(phi);
    const tanp = Math.tan(phi);
    const ep2 = e2 / (1 - e2);
    const nu = a / Math.sqrt(1 - e2 * sinp * sinp);
    const rho = a * (1 - e2) / Math.pow(1 - e2 * sinp * sinp, 1.5);
    const T = tanp * tanp;
    const C = ep2 * cosp * cosp;
    const A = (lam - lon0) * cosp;
    const M = mer(phi);
    const M0 = mer(lat0);
    const east = FE + k0 * nu * (
      A + (1 - T + C) * Math.pow(A, 3) / 6 +
      (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
    );
    const north = FN + k0 * (
      (M - M0) + nu * tanp * (
        A * A / 2 +
        (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24 +
        (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
      )
    );
    return [east, north];
  }

  function writeCoordsToProps(props, layer, lat, lng) {
    if (!props || !isFinite(lat) || !isFinite(lng)) return props;
    const sample = {};
    (layer && layer.columns || []).forEach((k) => { sample[k] = 1; });
    Object.keys(props).forEach((k) => { sample[k] = props[k]; });
    (layer && layer.features || []).slice(0, 8).forEach((ft) => {
      Object.keys(ft.properties || {}).forEach((k) => { if (sample[k] == null) sample[k] = ft.properties[k]; });
    });
    let fields = findHkGridFields(sample);
    if (!fields.eKey || !fields.nKey) {
      const cols = (layer && layer.columns) || [];
      const xCol = cols.find((k) => /^x$/i.test(k)) || cols.find((k) => /easting/i.test(k));
      const yCol = cols.find((k) => /^y$/i.test(k)) || cols.find((k) => /northing/i.test(k));
      if (xCol && yCol) fields = { eKey: xCol, nKey: yCol };
    }
    if (!fields.eKey || !fields.nKey) {
      fields = { eKey: "X", nKey: "Y" };
      if (layer) {
        layer.columns = layer.columns || [];
        if (layer.columns.indexOf("X") < 0) layer.columns.push("X");
        if (layer.columns.indexOf("Y") < 0) layer.columns.push("Y");
      }
    }
    const grid = wgs84ToHk1980Grid(lng, lat);
    props[fields.eKey] = Math.round(grid[0] * 1000) / 1000;
    props[fields.nKey] = Math.round(grid[1] * 1000) / 1000;
    const keys = Object.keys(sample);
    const latKey = keys.find((k) => /^(latitude|lat|wgs_?lat)$/i.test(String(k).trim()));
    const lonKey = keys.find((k) => /^(longitude|lon|lng|long|wgs_?lon)$/i.test(String(k).trim()));
    if (latKey) props[latKey] = Math.round(lat * 1e8) / 1e8;
    if (lonKey) props[lonKey] = Math.round(lng * 1e8) / 1e8;
    return props;
  }

  function findHkGridFields(props) {
    const keys = Object.keys(props || {});
    const skip = /lat|lon|lng|wgs|latu|long/i;
    const eKey = keys.find((k) => /^(easting|east|x|e|coordx|coord_x|hk_?e)$/i.test(String(k).trim()) && !skip.test(k))
      || keys.find((k) => /easting/i.test(k) && !skip.test(k));
    const nKey = keys.find((k) => /^(northing|north|y|n|coordy|coord_y|hk_?n)$/i.test(String(k).trim()) && !skip.test(k))
      || keys.find((k) => /northing/i.test(k) && !skip.test(k));
    if (eKey && nKey) return { eKey: eKey, nKey: nKey };
    const nums = keys.filter((k) => isFinite(parseFloat(props[k])));
    for (let i = 0; i < nums.length; i++) {
      for (let j = 0; j < nums.length; j++) {
        if (i === j) continue;
        const ev = parseFloat(props[nums[i]]);
        const nv = parseFloat(props[nums[j]]);
        if (looksLikeHkGrid(ev, nv)) return { eKey: nums[i], nKey: nums[j] };
      }
    }
    return { eKey: null, nKey: null };
  }

  function applyHk1980IfNeeded(features) {
    if (!features || !features.length) return 0;
    let n = 0;
    features.forEach((ft) => {
      const props = ft.properties || {};
      const fields = findHkGridFields(props);
      let e = null;
      let nn = null;
      if (fields.eKey && fields.nKey) {
        e = parseFloat(props[fields.eKey]);
        nn = parseFloat(props[fields.nKey]);
      }
      const g = ft.geometry;
      if ((!isFinite(e) || !isFinite(nn) || !looksLikeHkGrid(e, nn)) && g && g.type === "Point" && g.coordinates) {
        const x = g.coordinates[0];
        const y = g.coordinates[1];
        if (looksLikeHkGrid(x, y)) {
          e = x;
          nn = y;
        }
      }
      if (!isFinite(e) || !isFinite(nn) || !looksLikeHkGrid(e, nn)) return;
      const wgs = hk1980GridToWgs84(e, nn);
      ft.geometry = { type: "Point", coordinates: wgs };
      n += 1;
    });
    return n;
  }

  function detectGeomType(features) {
    for (let i = 0; i < features.length; i++) {
      const g = features[i] && features[i].geometry;
      if (g && g.type) return g.type;
    }
    return "Unknown";
  }

  async function buildFeatureLayer(fileRec, tableName) {
    const gp = fileRec.geoPackage;
    let count = null;
    let columns = [];
    let geomType = "";
    try {
      const dao = gp.getFeatureDao(tableName);
      const info = gp.getInfoForTable(dao);
      if (info) {
        count = info.count;
        columns = (info.columns || []).map((c) => c.name || c.columnName || c);
        if (info.geometryColumns) {
          geomType = info.geometryColumns.geometryTypeName || info.geometryColumns.geometryType || "";
        }
      }
    } catch (e) {
      console.warn("getInfoForTable failed", tableName, e);
    }

    const features = [];
    let truncated = false;
    const limit = state.featureLimit;
    try {
      const rs = iterateFeatures(gp, tableName);
      try {
        if (rs && typeof rs[Symbol.iterator] === "function") {
          for (const feat of rs) {
            if (feat && feat.type === "Feature") features.push(normalizePointFeature(feat));
            else if (feat && feat.geometry) features.push(normalizePointFeature(feat));
            else if (feat && feat.value && feat.value.geometry) features.push(normalizePointFeature(feat.value));
            if (features.length >= limit) {
              truncated = true;
              break;
            }
          }
        } else if (Array.isArray(rs)) {
          for (const feat of rs) {
            if (feat) features.push(normalizePointFeature(feat));
            if (features.length >= limit) {
              truncated = true;
              break;
            }
          }
        }
      } finally {
        if (rs && rs.close) rs.close();
      }
    } catch (e) {
      console.error("query features failed", tableName, e);
    }

    const hkFixed = applyHk1980IfNeeded(features);
    if (hkFixed) setStatus("Converted " + hkFixed + " spots from HK1980 Grid to WGS84.", "ok");
    if (!geomType) geomType = detectGeomType(features);
    const propKeys = collectPropertyKeys(features);
    if (propKeys.length) columns = propKeys;
    const color = nextColor();
    const leafletLayer = L.geoJSON(
      { type: "FeatureCollection", features: features },
      {
        style: () => styleFor(color, geomType),
        pointToLayer: pointToLayer(color),
        onEachFeature: (feat, lyr) => {
          bindPopup(lyr, feat, tableName);
          attachEditHandlers(lyr);
        }
      }
    );
    leafletLayer.addTo(map);
    leafletLayer.eachLayer((l) => {
      applySavedColor(l, fileRec.name);
      applyFeatureStyle(l, { color: color, geomType: geomType });
    });

    const layer = {
      key: layerKey(fileRec.id, tableName),
      tableName,
      kind: "feature",
      color,
      count: count != null ? count : features.length,
      loaded: features.length,
      truncated,
      geomType,
      columns,
      features,
      leafletLayer,
      visible: true
    };
    if (!state.labelField) state.labelField = guessLabelField(columns);
    applyLabelsToLayer(layer);
    restoreAddedSpots(fileRec, layer);
    applyDeletedFeatures(fileRec, layer);
    return layer;
  }

  async function buildTileLayer(fileRec, tableName) {
    const gp = fileRec.geoPackage;
    const GP = window.GeoPackage;
    let leafletLayer = null;
    let extra = "";
    try {
      const tileDao = gp.getTileDao(tableName);
      const Retriever = GP.GeoPackageTileRetriever;
      if (!Retriever) {
        extra = "Tile retriever API not available in this build.";
      } else {
        const retriever = new Retriever(tileDao);
        const minZoom = tileDao.minZoom != null ? tileDao.minZoom : 0;
        const maxZoom = tileDao.maxZoom != null ? tileDao.maxZoom : 18;

        leafletLayer = L.gridLayer({
          minZoom: 0,
          maxZoom: 22,
          minNativeZoom: minZoom,
          maxNativeZoom: maxZoom,
          tileSize: 256
        });

        leafletLayer.createTile = function (coords, done) {
          const tile = document.createElement("canvas");
          tile.width = 256;
          tile.height = 256;
          const z = coords.z;
          const x = coords.x;
          const y = coords.y;
          Promise.resolve(retriever.getTile(x, y, z))
            .then(async (gpTile) => {
              if (!gpTile) {
                done(null, tile);
                return;
              }
              let data = gpTile;
              if (gpTile && typeof gpTile.getData === "function") data = gpTile.getData();
              if (gpTile && typeof gpTile.getGeoPackageImage === "function") {
                try {
                  const img = await gpTile.getGeoPackageImage();
                  if (img && img.src) {
                    const im = new Image();
                    im.onload = () => {
                      tile.getContext("2d").drawImage(im, 0, 0, 256, 256);
                      done(null, tile);
                    };
                    im.onerror = () => done(null, tile);
                    im.src = img.src;
                    return;
                  }
                } catch (_) {}
              }
              if (!data) {
                done(null, tile);
                return;
              }
              const blob = data instanceof Blob ? data : new Blob([data], { type: "image/png" });
              const url = URL.createObjectURL(blob);
              const im = new Image();
              im.onload = () => {
                try { tile.getContext("2d").drawImage(im, 0, 0, 256, 256); } catch (_) {}
                URL.revokeObjectURL(url);
                done(null, tile);
              };
              im.onerror = () => {
                URL.revokeObjectURL(url);
                done(null, tile);
              };
              im.src = url;
            })
            .catch(() => done(null, tile));
          return tile;
        };

        leafletLayer.addTo(map);
      }
    } catch (e) {
      console.warn("tile layer failed", tableName, e);
      extra = e.message || String(e);
    }

    return {
      key: layerKey(fileRec.id, tableName),
      tableName,
      kind: "tile",
      color: "#64748b",
      count: null,
      loaded: null,
      truncated: false,
      geomType: "Raster tiles",
      columns: [],
      features: [],
      leafletLayer,
      visible: !!leafletLayer,
      note: extra
    };
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    const host = $("file-list");
    if (!state.files.length) {
      host.innerHTML = '<p class="empty-hint">No files loaded yet.</p>';
      $("stats").textContent = "";
      return;
    }

    let html = "";
    let totalLayers = 0;
    let totalFeats = 0;

    state.files.forEach((f) => {
      html += '<div class="file-card">';
      html += '<div class="file-head"><div class="file-name" title="' + escapeHtml(f.name) + '">' +
        escapeHtml(f.name) + '</div><div class="file-meta">' + formatBytes(f.size) +
        " · " + f.layers.length + " layer" + (f.layers.length === 1 ? "" : "s") + "</div></div>";

      f.layers.forEach((ly) => {
        totalLayers += 1;
        if (ly.kind === "feature") totalFeats += ly.count || 0;
        const checked = ly.visible ? "checked" : "";
        const active = state.selectedLayerKey === ly.key ? " active" : "";
        const badge = ly.kind === "tile" ? "tiles" : (ly.geomType || "vector");
        let countLabel = "";
        if (ly.kind === "feature") {
          countLabel = (ly.count != null ? ly.count : ly.loaded) + " features";
          if (ly.truncated) countLabel += " (showing " + ly.loaded + ")";
        }
        html += '<label class="layer-row' + active + '" data-key="' + escapeHtml(ly.key) + '">';
        html += '<input type="checkbox" data-toggle="' + escapeHtml(ly.key) + '" ' + checked + ">";
        html += '<span class="swatch" style="background:' + ly.color + '"></span>';
        html += '<span class="layer-text"><span class="layer-name">' + escapeHtml(ly.tableName) + "</span>";
        html += '<span class="layer-sub">' + escapeHtml(badge) + (countLabel ? " · " + countLabel : "") + "</span></span>";
        html += "</label>";
      });

      html += '<div class="file-actions">';
      html += '<button type="button" data-zoom-file="' + f.id + '">Zoom to file</button>';
      html += '<button type="button" data-iphone-copy="' + f.id + '">Save .sqlite for iPhone</button>';
      html += '<button type="button" class="danger" data-remove-file="' + f.id + '">Remove</button>';
      html += "</div></div>";
    });

    host.innerHTML = html;
    $("stats").textContent = state.files.length + " file" + (state.files.length === 1 ? "" : "s") +
      " · " + totalLayers + " layers · " + totalFeats.toLocaleString() + " features";
  }

  function downloadIphoneCopy(fileId) {
    const f = state.files.find((x) => x.id === fileId);
    if (!f || !f.originalBytes) {
      setStatus("Open the GeoPackage on this computer first, then save an iPhone copy.", "warn");
      return;
    }
    const base = String(f.name || "data").replace(/\.gpkg$/i, "");
    const blob = new Blob([f.originalBytes], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = base + ".sqlite";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
    setStatus("Saved " + base + ".sqlite — AirDrop / iCloud that file to the iPhone, then Open it there.", "ok");
  }

  function findLayer(key) {
    for (const f of state.files) {
      for (const ly of f.layers) {
        if (ly.key === key) return { file: f, layer: ly };
      }
    }
    return null;
  }

  function toggleLayer(key, on) {
    const found = findLayer(key);
    if (!found) return;
    found.layer.visible = on;
    if (found.layer.leafletLayer) {
      if (on) found.layer.leafletLayer.addTo(map);
      else map.removeLayer(found.layer.leafletLayer);
    }
    applyAllLabels();
  }

  function zoomToLayer(ly) {
    if (!ly || !ly.leafletLayer) return;
    if (ly.leafletLayer.getBounds) {
      const b = ly.leafletLayer.getBounds();
      if (b && b.isValid()) {
        map.fitBounds(b, { padding: [32, 32], maxZoom: 17 });
        return;
      }
    }
    setStatus("No extent available for this layer.", "warn");
  }

  function zoomToFile(fileId) {
    const f = state.files.find((x) => x.id === fileId);
    if (!f) return;
    const group = L.featureGroup(f.layers.filter((l) => l.leafletLayer && l.leafletLayer.getBounds).map((l) => l.leafletLayer));
    const b = group.getBounds();
    if (b && b.isValid()) map.fitBounds(b, { padding: [32, 32], maxZoom: 16 });
    else setStatus("Could not compute extent for this file.", "warn");
  }

  function removeFile(fileId) {
    const idx = state.files.findIndex((x) => x.id === fileId);
    if (idx < 0) return;
    const f = state.files[idx];
    f.layers.forEach((ly) => {
      if (ly.leafletLayer) map.removeLayer(ly.leafletLayer);
    });
    try {
      if (f.geoPackage && f.geoPackage.close) f.geoPackage.close();
    } catch (_) {}
    state.files.splice(idx, 1);
    if (state.selectedLayerKey && state.selectedLayerKey.startsWith(fileId)) {
      state.selectedLayerKey = null;
      renderTable(null);
    }
    refreshLabelFieldOptions();
    renderSidebar();
    idbDelete(fileId);
    setStatus("Removed " + f.name + ".", "ok");
  }

  function selectLayer(key) {
    state.selectedLayerKey = key;
    renderSidebar();
    const found = findLayer(key);
    renderTable(found ? found.layer : null);
  }

  // ---------- Attribute table ----------
  function renderTable(layer) {
    const wrap = $("table-wrap");
    const title = $("table-title");
    if (!layer || layer.kind !== "feature" || !layer.features.length) {
      title.textContent = layer && layer.kind === "tile" ? layer.tableName + " (raster — no attribute table)" : "Attributes";
      wrap.innerHTML = '<p class="empty-hint">Select a vector layer to inspect attributes.</p>';
      return;
    }
    title.textContent = layer.tableName + " — " + layer.loaded + " row" + (layer.loaded === 1 ? "" : "s") +
      (layer.truncated ? " of " + layer.count + " (truncated)" : "");

    const colsSet = new Set();
    layer.features.forEach((ft) => {
      Object.keys(ft.properties || {}).forEach((k) => {
        if (k && k.charAt(0) !== "_") colsSet.add(k);
      });
    });
    (state.extraCols || []).forEach((k) => { if (k) colsSet.add(k); });
    const allCols = Array.from(colsSet);
    const hidden = new Set(state.hiddenCols || []);
    const extras = state.extraCols || [];
    const cols = allCols.filter((c) => !hidden.has(c) && extras.indexOf(c) < 0)
      .concat(extras.filter((c) => !hidden.has(c)));
    fillColumnMenu(allCols);
    if (state.tableSortCol && cols.indexOf(state.tableSortCol) < 0) {
      state.tableSortCol = cols.indexOf("Tree ID") >= 0 ? "Tree ID" : (cols[0] || "");
    }
    const sortSel = $("table-sort-col");
    if (sortSel) {
      sortSel.innerHTML = cols.map((c) => {
        return "<option value=\"" + escapeHtml(c) + "\"" +
          (c === state.tableSortCol ? " selected" : "") + ">" + escapeHtml(c) + "</option>";
      }).join("");
    }
    const dirBtn = $("btn-sort-dir");
    if (dirBtn) dirBtn.textContent = state.tableSortDir < 0 ? "Z→A" : "A→Z";

    function sortVal(v) {
      if (v == null || v === "") return "";
      return String(v);
    }
    const idxs = layer.features.map((_, i) => i);
    if (state.tableSortCol) {
      const col = state.tableSortCol;
      const dir = state.tableSortDir || 1;
      idxs.sort((ia, ib) => {
        const av = sortVal((layer.features[ia].properties || {})[col]);
        const bv = sortVal((layer.features[ib].properties || {})[col]);
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
        return dir * (cmp || (ia - ib));
      });
    }
    const maxRows = idxs.length;

    let html = "<table class='attr'><thead><tr><th class='ck-col'>✓</th><th>#</th>";
    cols.forEach((c) => {
      const on = c === state.tableSortCol;
      const arrow = on ? (state.tableSortDir < 0 ? " ↓" : " ↑") : "";
      html += "<th class='sortable" + (on ? " sorted" : "") + "' data-col=\"" + escapeHtml(c) + "\">" +
        escapeHtml(c) + arrow + "</th>";
    });
    html += "</tr></thead><tbody>";
    for (let r = 0; r < maxRows; r++) {
      const i = idxs[r];
      const feat = layer.features[i];
      const p = feat.properties || {};
      const marker = findMarkerForFeature(layer, feat);
      const inspected = !!(marker && marker.feature && isInspectedColor((marker.feature.properties || {})._editColor)) ||
        isInspectedColor(p._editColor);
      const onRow = !!(marker && state.selectedMarker === marker);
      html += "<tr class='" + (inspected ? "inspected " : "") + (onRow ? "selected-row" : "") + "' data-i='" + i + "'>";
      html += "<td class='ck-col'><input type='checkbox' class='inspect-ck' data-i='" + i + "'" +
        (inspected ? " checked" : "") + " /></td>";
      html += "<td>" + (i + 1) + "</td>";
      cols.forEach((c) => {
        const changed = isCatalogChanged(p, c);
        html += "<td class='editable" + (changed ? " changed" : "") + "' data-i='" + i +
          "' data-col=\"" + escapeHtml(c) + "\">" + escapeHtml(p[c]) + "</td>";
      });
      html += "</tr>";
    }
    html += "</tbody></table>";
    if (layer.features.length > maxRows) {
      html += '<p class="empty-hint">Showing first ' + maxRows + " rows in the table.</p>";
    }
    wrap.innerHTML = html;
    wrap.onchange = function (e) {
      const ck = e.target && e.target.classList && e.target.classList.contains("inspect-ck") ? e.target : null;
      if (!ck) return;
      const i = parseInt(ck.getAttribute("data-i"), 10);
      const found = findLayer(state.selectedLayerKey);
      const layer = found && found.layer;
      if (!layer || !layer.features || !layer.features[i]) return;
      const marker = findMarkerForFeature(layer, layer.features[i]);
      if (!marker) {
        setStatus("Could not find that tree on the map.", "warn");
        ck.checked = false;
        return;
      }
      if (ck.checked) {
        paintSpot(marker, INSPECT_RED, true);
        if (layer.features[i].properties) layer.features[i].properties._editColor = INSPECT_RED;
        setStatus("Inspected " + (labelText(marker.feature, state.labelField) || "tree") + ".", "ok");
      } else {
        paintSpot(marker, null, true);
        if (layer.features[i].properties) delete layer.features[i].properties._editColor;
        setStatus("Cleared inspect mark for " + (labelText(marker.feature, state.labelField) || "tree") + ".", "ok");
      }
      const row = ck.closest("tr");
      if (row) row.classList.toggle("inspected", ck.checked);
    };
    wrap.onclick = function (e) {
      const th = e.target && e.target.closest ? e.target.closest("th.sortable") : null;
      if (th) {
        const col = th.getAttribute("data-col");
        if (!col) return;
        if (state.tableSortCol === col) state.tableSortDir = -(state.tableSortDir || 1);
        else {
          state.tableSortCol = col;
          state.tableSortDir = 1;
        }
        renderTable(layer);
        return;
      }
      if (e.target && e.target.closest && e.target.closest("input, button, .inspect-ck")) return;
      const tr = e.target && e.target.closest ? e.target.closest("tr[data-i]") : null;
      if (!tr) return;
      const i = parseInt(tr.getAttribute("data-i"), 10);
      if (!layer.features || !layer.features[i]) return;
      const marker = findMarkerForFeature(layer, layer.features[i]);
      wrap.querySelectorAll("tr.selected-row").forEach((row) => row.classList.remove("selected-row"));
      tr.classList.add("selected-row");
      focusMarkerOnMap(marker);
    };
    wrap.ondblclick = function (e) {
      const td = e.target && e.target.closest ? e.target.closest("td.editable") : null;
      if (td) startCellEdit(td, layer);
    };
    let lastCellTap = { el: null, t: 0 };
    wrap.addEventListener("touchend", function (e) {
      const td = e.target && e.target.closest ? e.target.closest("td.editable") : null;
      if (!td) return;
      const now = Date.now();
      if (lastCellTap.el === td && now - lastCellTap.t < 450) {
        lastCellTap = { el: null, t: 0 };
        e.preventDefault();
        startCellEdit(td, layer);
        return;
      }
      lastCellTap = { el: td, t: now };
    }, { passive: false });
  }

  function fillColumnMenu(allCols) {
    const menu = $("col-menu");
    if (!menu) return;
    const hidden = new Set(state.hiddenCols || []);
    menu.innerHTML = "<div class='hint' style='margin:0 0 6px'>Show columns</div>" +
      allCols.map((c) => {
        return "<label><input type='checkbox' data-col=\"" + escapeHtml(c) + "\"" +
          (hidden.has(c) ? "" : " checked") + "> " + escapeHtml(c) + "</label>";
      }).join("");
  }

  function persistHiddenCols() {
    try { localStorage.setItem("gpkg-viewer-hidden-cols", JSON.stringify(state.hiddenCols || [])); }
    catch (_) {}
  }

  function startCellEdit(td, layer) {
    if (!td || td.classList.contains("editing")) return;
    const col = td.getAttribute("data-col");
    const i = parseInt(td.getAttribute("data-i"), 10);
    if (!col || !layer || !layer.features || !layer.features[i]) return;
    const feat = layer.features[i];
    const old = feat.properties && feat.properties[col] != null ? String(feat.properties[col]) : "";
    td.classList.add("editing");
    td.innerHTML = "<input type='text' />";
    const inp = td.querySelector("input");
    inp.value = old;
    inp.focus();
    inp.select();
    function finish(ok) {
      if (!td.classList.contains("editing")) return;
      const text = inp.value;
      td.classList.remove("editing");
      if (!ok || text === old) {
        td.textContent = old;
        return;
      }
      applyCatalogValue(layer, i, col, text);
      td.textContent = text;
      td.classList.toggle("changed", isCatalogChanged(feat.properties, col));
    }
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  function isCatalogChanged(props, col) {
    if (!props || !props._origProps) return false;
    const a = props[col] == null ? "" : String(props[col]);
    const b = props._origProps[col] == null ? "" : String(props._origProps[col]);
    return a !== b;
  }

  function applyCatalogValue(layer, i, col, text) {
    const feat = layer.features[i];
    if (!feat) return;
    feat.properties = feat.properties || {};
    if (!feat.properties._origProps) {
      const snap = {};
      Object.keys(feat.properties).forEach((k) => {
        if (k && k.charAt(0) !== "_") snap[k] = feat.properties[k];
      });
      feat.properties._origProps = snap;
    }
    const orig = feat.properties._origProps ? feat.properties._origProps[col] : feat.properties[col];
    let next = text;
    if (typeof orig === "number") {
      const n = Number(text);
      if (Number.isFinite(n)) next = n;
    }
    feat.properties[col] = next;
    const marker = findMarkerForFeature(layer, feat);
    if (marker && marker.feature) {
      marker.feature.properties = marker.feature.properties || {};
      marker.feature.properties[col] = next;
      if (col === state.labelField) bindFeatureLabel(marker);
    }
    persistColorEdits();
    setStatus("Updated " + col + " and saved.", "ok");
  }

  // ---------- Events ----------
  async function openGeoJsonFile(file, opts) {
    opts = opts || {};
    openGeoJsonFile._fromStore = !!opts.fromStore;
    setStatus("Opening " + file.name + " …", "");
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let features = [];
      if (data && data.type === "FeatureCollection" && Array.isArray(data.features)) {
        features = data.features;
      } else if (data && data.type === "Feature") {
        features = [data];
      } else if (Array.isArray(data)) {
        features = data;
      }
      features = features.filter((ft) => ft && ft.geometry);
      if (!features.length) throw new Error("No features in this GeoJSON file.");
      applyHk1980IfNeeded(features);

      features.forEach((ft) => {
        const p = ft.properties || {};
        if (p.color && !p._editColor) p._editColor = p.color;
        ft.properties = p;
      });

      const fileId = opts.id || ("f" + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
      const rec = { id: fileId, name: file.name, size: file.size, geoPackage: null, layers: [] };
      const geomType = detectGeomType(features);
      const columns = collectPropertyKeys(features);
      const color = nextColor();
      const tableName = file.name.replace(/\.[^.]+$/, "") || "layer";
      const leafletLayer = L.geoJSON(
        { type: "FeatureCollection", features: features },
        {
          style: (feat) => styleFor((feat.properties && feat.properties._editColor) || color, geomType),
          pointToLayer: pointToLayer(color),
          onEachFeature: (feat, lyr) => {
            bindPopup(lyr, feat, tableName);
            attachEditHandlers(lyr);
          }
        }
      );
      leafletLayer.addTo(map);
      leafletLayer.eachLayer((l) => {
        applySavedColor(l, rec.name);
        applyFeatureStyle(l, { color: color, geomType: geomType });
      });
      rec.layers.push({
        key: layerKey(fileId, tableName),
        tableName: tableName,
        kind: "feature",
        color: color,
        count: features.length,
        loaded: features.length,
        truncated: false,
        geomType: geomType,
        columns: columns,
        features: features,
        leafletLayer: leafletLayer,
        visible: true
      });
      restoreAddedSpots(rec, rec.layers[rec.layers.length - 1]);
      applyDeletedFeatures(rec, rec.layers[rec.layers.length - 1]);
      state.files.push(rec);
      refreshLabelFieldOptions();
      applyAllLabels();
      renderSidebar();
      if (leafletLayer.getBounds && leafletLayer.getBounds().isValid()) {
        map.fitBounds(leafletLayer.getBounds(), { padding: [28, 28], maxZoom: 16 });
      }
      if (!openGeoJsonFile._fromStore) persistOpenedFile("geojson", rec.id, file);
      setStatus("Loaded " + file.name + " — " + features.length + " features.", "ok");
    } catch (err) {
      console.error(err);
      setStatus("Could not open " + file.name + ": " + (err && err.message ? err.message : err), "error");
    }
  }

  function openAnyFile(file) {
    const n = (file.name || "").toLowerCase();
    const t = (file.type || "").toLowerCase();
    if (n.endsWith(".pdf") || t === "application/pdf") return openPdfFile(file);
    if (n.endsWith(".osm") || n.endsWith(".osm.xml")) return openOsmBasemap(file);
    if (n.endsWith(".geojson") || n.endsWith(".json")) return openGeoJsonFile(file);
    if (n.endsWith(".csv") || n.endsWith(".tsv") || t === "text/csv") return openCsvPoints(file);
    return openGpkgFile(file);
  }

  async function openCsvPoints(file) {
    const text = await file.text();
    const raw = text.replace(/^\uFEFF/, "");
    const lines = raw.split(/\r?\n/).filter((ln) => ln.trim());
    if (lines.length < 2) throw new Error("CSV has no rows.");
    const delim = lines[0].indexOf("\t") >= 0 && lines[0].split("\t").length > lines[0].split(",").length ? "\t" : ",";
    const header = lines[0].split(delim).map((h) => h.trim().replace(/^;/, ""));
    const features = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(delim);
      const props = {};
      header.forEach((h, j) => { props[h] = String(parts[j] == null ? "" : parts[j]).trim().replace(/^;/, ""); });
      const fields = findHkGridFields(props);
      const e = fields.eKey ? parseFloat(props[fields.eKey]) : NaN;
      const nn = fields.nKey ? parseFloat(props[fields.nKey]) : NaN;
      if (!looksLikeHkGrid(e, nn)) continue;
      features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [e, nn] } });
    }
    if (!features.length) {
      setStatus("No HK1980 X/Y points found in this CSV.", "warn");
      return;
    }
    const json = new File([JSON.stringify({ type: "FeatureCollection", features: features })], file.name.replace(/\.[^.]+$/, "") + ".geojson", { type: "application/geo+json" });
    return openGeoJsonFile(json);
  }

  function fitAffine2d(points) {
    const n = points.length;
    if (n < 3) return null;
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Se = 0, Sn = 0, Sxe = 0, Sye = 0, Sxn = 0, Syn = 0;
    points.forEach((p) => {
      Sx += p.x; Sy += p.y; Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y;
      Se += p.E; Sn += p.N; Sxe += p.x * p.E; Sye += p.y * p.E; Sxn += p.x * p.N; Syn += p.y * p.N;
    });
    function solve(Sxz, Syz, Sz) {
      const M = [
        [Sxx, Sxy, Sx, Sxz],
        [Sxy, Syy, Sy, Syz],
        [Sx, Sy, n, Sz]
      ];
      for (let i = 0; i < 3; i++) {
        let p = i;
        for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        const tmp = M[i]; M[i] = M[p]; M[p] = tmp;
        const div = M[i][i] || 1e-12;
        for (let k = i; k < 4; k++) M[i][k] /= div;
        for (let r = 0; r < 3; r++) {
          if (r === i) continue;
          const f = M[r][i];
          for (let k = i; k < 4; k++) M[r][k] -= f * M[i][k];
        }
      }
      return [M[0][3], M[1][3], M[2][3]];
    }
    return { E: solve(Sxe, Sye, Se), N: solve(Sxn, Syn, Sn) };
  }

  function pageToGrid(fit, x, y) {
    return [
      fit.E[0] * x + fit.E[1] * y + fit.E[2],
      fit.N[0] * x + fit.N[1] * y + fit.N[2]
    ];
  }

  async function inflateZlibBytes(u8) {
    if (typeof DecompressionStream === "function") {
      try {
        const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (_) {}
    }
    throw new Error("Cannot decompress PDF attachment on this device.");
  }

  function extractArborMarkFromPdfBytes(u8) {
    const latin = new TextDecoder("latin1").decode(u8);
    if (latin.indexOf("tree_markers.json") < 0 && latin.indexOf("geo_controls") < 0) return null;
    const re = /\/Type\s*\/EmbeddedFile[\s\S]{0,400}\/Length\s+(\d+)[\s\S]{0,300}stream\r?\n/g;
    let m;
    const hits = [];
    while ((m = re.exec(latin))) {
      const start = m.index + m[0].length;
      const len = parseInt(m[1], 10);
      if (!len || start + len > u8.length) continue;
      hits.push({ start: start, len: len });
    }
    return hits;
  }

  async function readArborMarkPlan(file) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (window.pdfjsLib) {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
        const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
        if (typeof pdf.getAttachments === "function") {
          const atts = await pdf.getAttachments();
          const keys = atts ? Object.keys(atts) : [];
          for (let i = 0; i < keys.length; i++) {
            const rec = atts[keys[i]];
            const name = (rec.filename || keys[i] || "").toLowerCase();
            const content = rec.content || rec.data;
            if (!content) continue;
            if (name.indexOf("tree_markers") >= 0 || name.indexOf(".json") >= 0) {
              const text = new TextDecoder("utf-8").decode(content);
              const json = JSON.parse(text);
              if (json && (json.markers || json.geo_controls)) return json;
            }
          }
        }
      } catch (err) {
        console.warn("pdf.js attachments", err);
      }
    }
    const hits = extractArborMarkFromPdfBytes(u8);
    for (let i = 0; i < (hits || []).length; i++) {
      try {
        const slice = u8.subarray(hits[i].start, hits[i].start + hits[i].len);
        const raw = await inflateZlibBytes(slice);
        const json = JSON.parse(new TextDecoder("utf-8").decode(raw));
        if (json && (json.markers || json.geo_controls)) return json;
      } catch (_) {}
    }
    return null;
  }

  async function importTreePlanPdf(file) {
    setStatus("Reading tree plan PDF…", "");
    try {
      const plan = await readArborMarkPlan(file);
      if (!plan) {
        await startManualTreePlan(file);
        return;
      }
      const controls = (plan.geo_controls || []).filter((c) => isFinite(c.E) && isFinite(c.N) && isFinite(c.x) && isFinite(c.y));
      if (controls.length < 3) {
        setStatus("Need at least 3 E/N control points on the plan to place trees.", "warn");
        return;
      }
      const fit = fitAffine2d(controls);
      if (!fit) {
        setStatus("Could not georeference this plan.", "error");
        return;
      }
      const markers = plan.markers || [];
      const features = [];
      markers.forEach((mk) => {
        if (!isFinite(mk.x) || !isFinite(mk.y)) return;
        const grid = pageToGrid(fit, mk.x, mk.y);
        const E = Math.round(grid[0] * 1000) / 1000;
        const N = Math.round(grid[1] * 1000) / 1000;
        const wgs = hk1980GridToWgs84(E, N);
        features.push({
          type: "Feature",
          properties: {
            "Tree No": mk.id || "",
            X: E,
            Y: N,
            note: mk.note || "",
            _fromTreePlan: true
          },
          geometry: { type: "Point", coordinates: wgs }
        });
      });
      if (!features.length) {
        setStatus("No tree spots found in this plan.", "warn");
        return;
      }
      const json = new File(
        [JSON.stringify({ type: "FeatureCollection", features: features })],
        (file.name || "tree-plan").replace(/\.pdf$/i, "") + "-trees.geojson",
        { type: "application/geo+json" }
      );
      await openGeoJsonFile(json);
      setStatus("Imported " + features.length + " trees from the plan (HK1980 from control points).", "ok");
    } catch (err) {
      console.warn(err);
      setStatus("Could not import this tree plan PDF.", "error");
    }
  }

  function treeIdFromText(s) {
    const t = String(s || "").trim();
    if (/^T-?[0-9]+[A-Z]{0,2}$/i.test(t)) return t.toUpperCase();
    return "";
  }

  async function extractPdfTreeLabels(file) {
    if (!window.pdfjsLib) throw new Error("PDF engine missing");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    (tc.items || []).forEach((it) => {
      const id = treeIdFromText(it.str);
      if (!id) return;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      items.push({
        id: id,
        x: tr[4] + (it.width || 0) / 2,
        y: tr[5] + 4
      });
    });
    return { pdf: pdf, page: page, viewport: viewport, items: items, bytes: bytes };
  }

  function closeManualTreePlan() {
    state.treePlan = null;
    document.body.classList.remove("tree-plan-pick-map");
    const mask = $("tree-plan-mask");
    if (mask) mask.hidden = true;
  }

  function renderTreePlanPts() {
    const ol = $("tree-plan-pts");
    if (!ol || !state.treePlan) return;
    const pts = state.treePlan.controls || [];
    ol.innerHTML = pts.map((p, i) => {
      const mapBit = p.lat != null ? (p.lat.toFixed(5) + ", " + p.lng.toFixed(5)) : "tap the map…";
      return "<li>P" + (i + 1) + " on PDF → " + mapBit + "</li>";
    }).join("") || "<li>None yet</li>";
    const hint = $("tree-plan-hint");
    if (hint) {
      if (state.treePlan.pendingPdf) hint.textContent = "Now tap the same place on the map.";
      else if (pts.length < 3) hint.textContent = "Click a landmark on the PDF, then the same place on the map. Need " + (3 - pts.length) + " more pair(s).";
      else hint.textContent = "3 points set. Place trees, or add more pairs for a better fit.";
    }
  }

  async function startManualTreePlan(file) {
    setStatus("No ArborMark data. Extracting labels…", "");
    const extracted = await extractPdfTreeLabels(file);
    if (!extracted.items.length) {
      setStatus("No tree IDs (T1, T2…) found in this PDF.", "warn");
      return;
    }
    state.treePlan = {
      file: file,
      page: extracted.page,
      viewport: extracted.viewport,
      items: extracted.items,
      controls: [],
      pendingPdf: null,
      scale: 1
    };
    const mask = $("tree-plan-mask");
    const canvas = $("tree-plan-canvas");
    if (!mask || !canvas) {
      setStatus("Tree plan window missing.", "error");
      return;
    }
    const fitW = Math.min(520, (window.innerWidth || 600) - 48);
    const scale = Math.max(0.6, Math.min(1.6, fitW / extracted.viewport.width));
    state.treePlan.scale = scale;
    const vp = extracted.page.getViewport({ scale: scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await extracted.page.render({ canvasContext: ctx, viewport: vp }).promise;
    try { state.treePlan.snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (_) {}
    ctx.fillStyle = "rgba(220,38,38,0.9)";
    extracted.items.forEach((it) => {
      const x = it.x * scale;
      const y = (extracted.viewport.height - it.y) * scale;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    if ($("tree-plan-found")) {
      $("tree-plan-found").textContent = "Found " + extracted.items.length + " labels: " +
        extracted.items.slice(0, 12).map((it) => it.id).join(", ") + (extracted.items.length > 12 ? "…" : "");
    }
    mask.hidden = false;
    renderTreePlanPts();
    setStatus("Match 3 landmarks: PDF first, then the map.", "ok");
  }

  function treePlanCanvasToPdf(ev) {
    const canvas = $("tree-plan-canvas");
    const plan = state.treePlan;
    if (!canvas || !plan) return null;
    const r = canvas.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (canvas.width / r.width);
    const py = (ev.clientY - r.top) * (canvas.height / r.height);
    const scale = plan.scale || 1;
    return { x: px / scale, y: plan.viewport.height - py / scale };
  }

  function refreshTreePlanCanvas() {
    const canvas = $("tree-plan-canvas");
    const plan = state.treePlan;
    if (!canvas || !plan) return;
    const ctx = canvas.getContext("2d");
    if (plan.snapshot) ctx.putImageData(plan.snapshot, 0, 0);
    const scale = plan.scale || 1;
    ctx.fillStyle = "rgba(220,38,38,0.9)";
    (plan.items || []).forEach((it) => {
      const x = it.x * scale;
      const y = (plan.viewport.height - it.y) * scale;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    drawTreePlanControls();
  }

  function drawTreePlanControls() {
    const canvas = $("tree-plan-canvas");
    const plan = state.treePlan;
    if (!canvas || !plan) return;
    const ctx = canvas.getContext("2d");
    const scale = plan.scale || 1;
    (plan.controls || []).forEach((p, i) => {
      const x = p.x * scale;
      const y = (plan.viewport.height - p.y) * scale;
      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "11px sans-serif";
      ctx.fillText(String(i + 1), x + 6, y - 4);
    });
    if (plan.pendingPdf) {
      const x = plan.pendingPdf.x * scale;
      const y = (plan.viewport.height - plan.pendingPdf.y) * scale;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function onTreePlanPdfClick(ev) {
    if (!state.treePlan) return;
    const pt = treePlanCanvasToPdf(ev);
    if (!pt) return;
    state.treePlan.pendingPdf = pt;
    document.body.classList.add("tree-plan-pick-map");
    renderTreePlanPts();
    drawTreePlanControls();
    setStatus("Now tap the same place on the map.", "ok");
  }

  function onTreePlanMapClick(latlng) {
    if (!state.treePlan || !state.treePlan.pendingPdf) return false;
    state.treePlan.controls.push({
      x: state.treePlan.pendingPdf.x,
      y: state.treePlan.pendingPdf.y,
      lat: latlng.lat,
      lng: latlng.lng
    });
    state.treePlan.pendingPdf = null;
    document.body.classList.remove("tree-plan-pick-map");
    renderTreePlanPts();
    refreshTreePlanCanvas();
    setStatus("Control " + state.treePlan.controls.length + " saved.", "ok");
    return true;
  }

  async function placeManualTreePlan() {
    const plan = state.treePlan;
    if (!plan || (plan.controls || []).length < 3) {
      setStatus("Set at least 3 PDF ↔ map pairs.", "warn");
      return;
    }
    const fitPts = plan.controls.map((c) => ({ x: c.x, y: c.y, E: c.lng, N: c.lat }));
    const fit = fitAffine2d(fitPts);
    if (!fit) {
      setStatus("Could not fit those control points.", "error");
      return;
    }
    const features = plan.items.map((it) => {
      const lng = fit.E[0] * it.x + fit.E[1] * it.y + fit.E[2];
      const lat = fit.N[0] * it.x + fit.N[1] * it.y + fit.N[2];
      const props = { "Tree No": it.id, _fromTreePlan: true };
      writeCoordsToProps(props, null, lat, lng);
      return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lng, lat] } };
    });
    const json = new File(
      [JSON.stringify({ type: "FeatureCollection", features: features })],
      (plan.file.name || "tree-plan").replace(/\.pdf$/i, "") + "-trees.geojson",
      { type: "application/geo+json" }
    );
    closeManualTreePlan();
    await openGeoJsonFile(json);
    setStatus("Imported " + features.length + " trees from the PDF labels.", "ok");
  }

  function invalidateMapSoon() {
    setTimeout(() => {
      try { map.invalidateSize({ animate: false }); } catch (_) {}
    }, 80);
  }

  function setPdfVisible(on) {
    const panel = $("pdf-panel");
    const toggle = $("btn-toggle-pdf");
    if (!state.pdf) {
      document.body.classList.remove("pdf-open");
      if (panel) panel.hidden = true;
      if (toggle) toggle.hidden = true;
      invalidateMapSoon();
      return;
    }
    state.pdf.hidden = !on;
    if (on) {
      document.body.classList.add("pdf-open");
      if (!document.body.style.getPropertyValue("--pdf-w")) {
        document.body.style.setProperty("--pdf-w", Math.round(Math.min(420, window.innerWidth * 0.42)) + "px");
      }
      if (panel) panel.hidden = false;
      if (toggle) {
        toggle.hidden = false;
        toggle.textContent = "Hide PDF";
      }
    } else {
      document.body.classList.remove("pdf-open");
      if (panel) panel.hidden = true;
      if (toggle) {
        toggle.hidden = false;
        toggle.textContent = "Show PDF";
      }
    }
    invalidateMapSoon();
  }

  function closePdf(forget) {
    const frame = $("pdf-frame");
    if (state.pdf && state.pdf.url) {
      try { URL.revokeObjectURL(state.pdf.url); } catch (_) {}
    }
    if (forget && state.pdf && state.pdf.id) {
      idbDelete(state.pdf.id);
      try { localStorage.removeItem("gpkg-viewer-pdf-annos-" + state.pdf.id); } catch (_) {}
    }
    state.pdf = null;
    if (frame) frame.src = "about:blank";
    const host = $("pdf-pages");
    if (host) host.innerHTML = "";
    if ($("pdf-title")) $("pdf-title").textContent = "PDF";
    document.body.classList.remove("pdf-pan");
    setPdfVisible(false);
    setStatus("PDF closed.", "ok");
  }

  function loadPdfAnnos(id) {
    try { return JSON.parse(localStorage.getItem("gpkg-viewer-pdf-annos-" + id) || "[]"); }
    catch (_) { return []; }
  }
  function savePdfAnnos() {
    if (!state.pdf) return;
    try { localStorage.setItem("gpkg-viewer-pdf-annos-" + state.pdf.id, JSON.stringify(state.pdf.annos || [])); }
    catch (_) {}
  }
  function setPdfTool(tool) {
    if (!state.pdf) return;
    state.pdf.tool = tool || "pan";
    document.body.classList.toggle("pdf-pan", state.pdf.tool === "pan");
    document.body.classList.toggle("pdf-write-mode", state.pdf.tool !== "pan");
    document.querySelectorAll(".pdf-tool").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-pdf-tool") === state.pdf.tool);
    });
  }
  function drawAnnoOn(ctx, items, w, h) {
    ctx.clearRect(0, 0, w, h);
    (items || []).forEach((it) => {
      if (it.type === "path" && it.pts && it.pts.length) {
        ctx.strokeStyle = it.color || "#e11d48";
        ctx.lineWidth = (it.width || 2.4) * Math.max(1, w / 900);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(it.pts[0][0] * w, it.pts[0][1] * h);
        for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i][0] * w, it.pts[i][1] * h);
        ctx.stroke();
      } else if (it.type === "text") {
        ctx.fillStyle = it.color || "#111827";
        ctx.font = "bold " + Math.max(14, Math.round(h * 0.028)) + "px sans-serif";
        ctx.fillText(it.text || "", (it.x || 0) * w, (it.y || 0) * h);
      }
    });
  }
  function redrawPdfPage(pageNo) {
    if (!state.pdf) return;
    const wrap = document.querySelector('.pdf-page-wrap[data-page="' + pageNo + '"]');
    if (!wrap) return;
    const anno = wrap.querySelector(".pdf-anno");
    if (!anno) return;
    drawAnnoOn(anno.getContext("2d"), (state.pdf.annos || []).filter((a) => a.page === pageNo), anno.width, anno.height);
  }
  function isPencilEvent(ev) {
    if (!ev) return false;
    if (ev.pointerType === "pen") return true;
    const touches = ev.touches || ev.changedTouches;
    if (touches) {
      for (let i = 0; i < touches.length; i++) {
        if (touches[i].touchType === "stylus") return true;
      }
    }
    return false;
  }
  function isFingerEvent(ev) {
    if (!ev) return false;
    if (ev.pointerType === "pen") return false;
    if (isPencilEvent(ev)) return false;
    if (ev.pointerType === "touch") return true;
    const t = ev.touches && ev.touches[0];
    return !!(t && t.touchType === "direct");
  }
  function canWriteWith(ev) {
    if (!state.pdf || state.pdf.tool === "pan") return false;
    if (isPencilEvent(ev) || ev.pointerType === "pen") return true;
    if (isFingerEvent(ev)) return false;
    return ev.pointerType === "mouse" || !ev.pointerType;
  }
  function eventPosOnAnno(ev, anno) {
    const r = anno.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    return [(ev.clientX - r.left) / w, (ev.clientY - r.top) / h];
  }
  function pageWrapAtPoint(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (let i = 0; i < els.length; i++) {
      const wrap = els[i].closest && els[i].closest(".pdf-page-wrap");
      if (wrap) return wrap;
    }
    return null;
  }
  function bindPdfAnno(wrap, pageNo) {
    wrap._pdfPageNo = pageNo;
  }

  async function renderPdfPages(bytes) {
    const host = $("pdf-pages");
    if (!host) return;
    host.innerHTML = "";
    if (!window.pdfjsLib) {
      host.innerHTML = "<p class='empty-hint'>PDF engine missing. Use a computer browser to view.</p>";
      return;
    }
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      const task = window.pdfjsLib.getDocument({ data: bytes });
      const pdf = await task.promise;
      const max = Math.min(pdf.numPages, 40);
      const inner = document.createElement("div");
      inner.className = "pdf-zoom-inner";
      inner.id = "pdf-zoom-inner";
      host.appendChild(inner);
      const width = Math.max(240, (host.clientWidth || 340));
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      for (let n = 1; n <= max; n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const cssScale = width / base.width;
        const viewport = page.getViewport({ scale: Math.min(3.2, Math.max(1.2, cssScale * dpr)) });
        const wrap = document.createElement("div");
        wrap.className = "pdf-page-wrap";
        wrap.setAttribute("data-page", String(n));
        const pageCv = document.createElement("canvas");
        pageCv.width = viewport.width;
        pageCv.height = viewport.height;
        pageCv.style.width = "100%";
        pageCv.style.height = "auto";
        const anno = document.createElement("canvas");
        anno.className = "pdf-anno";
        anno.width = viewport.width;
        anno.height = viewport.height;
        anno.style.width = "100%";
        anno.style.height = "auto";
        wrap.appendChild(pageCv);
        wrap.appendChild(anno);
        inner.appendChild(wrap);
        const pctx = pageCv.getContext("2d", { alpha: false });
        pctx.imageSmoothingEnabled = true;
        pctx.imageSmoothingQuality = "high";
        await page.render({ canvasContext: pctx, viewport: viewport }).promise;
        bindPdfAnno(wrap, n);
        redrawPdfPage(n);
      }
      if (pdf.numPages > max) {
        const note = document.createElement("p");
        note.className = "empty-hint";
        note.textContent = "Showing first " + max + " of " + pdf.numPages + " pages.";
        inner.appendChild(note);
      }
    } catch (err) {
      console.warn(err);
      host.innerHTML = "<p class='empty-hint'>Could not draw this PDF. Try another file.</p>";
    }
  }

  async function openPdfFile(file, opts) {
    opts = opts || {};
    if (!file) return;
    const name = file.name || "document.pdf";
    const bytes = opts.bytes || new Uint8Array(await file.arrayBuffer());
    const blob = new Blob([bytes], { type: "application/pdf" });
    if (state.pdf && state.pdf.url) {
      try { URL.revokeObjectURL(state.pdf.url); } catch (_) {}
    }
    const url = URL.createObjectURL(blob);
    const id = opts.id || ("pdf-" + Date.now());
    state.pdf = {
      id: id,
      name: name,
      url: url,
      hidden: false,
      tool: "pen",
      viewZoom: 1,
      annos: opts.annos || loadPdfAnnos(id),
      bytes: bytes
    };
    if ($("pdf-title")) $("pdf-title").textContent = name;
    setPdfVisible(true);
    setPdfTool("pen");
    await renderPdfPages(bytes);
    setPdfZoom(state.pdf.viewZoom || 1);
    if (!opts.fromStore) persistOpenedFile("pdf", id, file, { bytes: bytes, name: name });
    setStatus("Opened PDF: " + name + ". Finger moves/zooms. Apple Pencil writes.", "ok");
  }

  function handleFiles(fileList) {
    const raw = Array.from(fileList || []);
    if (!raw.length) {
      setStatus("No file selected.", "warn");
      return;
    }
    const preferred = raw.filter((f) => {
      const n = (f.name || "").toLowerCase();
      return n.endsWith(".gpkg") || n.endsWith(".gpkg.zip") || n.endsWith(".sqlite") ||
        n.endsWith(".db") || n.endsWith(".zip") || n.endsWith(".geojson") || n.endsWith(".json") ||
        n.endsWith(".osm") || n.endsWith(".osm.xml") || n.endsWith(".pdf") || n.endsWith(".csv") || n.endsWith(".tsv") ||
        f.type === "application/geopackage+sqlite3" || f.type === "application/geo+json" ||
        f.type === "application/json" || f.type === "application/pdf";
    });
    const files = preferred.length ? preferred : raw;
    files.reduce((p, f) => p.then(() => openAnyFile(f)), Promise.resolve());
  }

  $("file-input").addEventListener("change", (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  });
  if ($("file-input-phone")) {
    $("file-input-phone").addEventListener("change", (e) => {
      handleFiles(e.target.files);
      e.target.value = "";
    });
  }
  if ($("btn-import-pdf") && $("pdf-input")) {
    $("btn-import-pdf").addEventListener("click", () => $("pdf-input").click());
    $("pdf-input").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) openPdfFile(f);
      e.target.value = "";
    });
  }
  if ($("btn-import-tree-plan") && $("tree-plan-input")) {
    $("btn-import-tree-plan").addEventListener("click", () => $("tree-plan-input").click());
    $("tree-plan-input").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importTreePlanPdf(f);
      e.target.value = "";
    });
  }
  if ($("tree-plan-canvas")) $("tree-plan-canvas").addEventListener("click", onTreePlanPdfClick);
  if ($("btn-tree-plan-cancel")) $("btn-tree-plan-cancel").addEventListener("click", closeManualTreePlan);
  if ($("btn-tree-plan-go")) $("btn-tree-plan-go").addEventListener("click", placeManualTreePlan);
  if ($("btn-tree-plan-undo")) $("btn-tree-plan-undo").addEventListener("click", () => {
    if (!state.treePlan) return;
    if (state.treePlan.pendingPdf) state.treePlan.pendingPdf = null;
    else state.treePlan.controls.pop();
    document.body.classList.remove("tree-plan-pick-map");
    renderTreePlanPts();
    refreshTreePlanCanvas();
  });
  if ($("btn-toggle-pdf")) {
    $("btn-toggle-pdf").addEventListener("click", () => {
      if (!state.pdf) {
        if ($("pdf-input")) $("pdf-input").click();
        return;
      }
      setPdfVisible(!!state.pdf.hidden);
    });
  }
  function canvasToJpegBytes(canvas) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob(function (blob) {
          if (!blob) { resolve(null); return; }
          const fr = new FileReader();
          fr.onload = function () { resolve(new Uint8Array(fr.result)); };
          fr.onerror = function () { resolve(null); };
          fr.readAsArrayBuffer(blob);
        }, "image/jpeg", 0.92);
      } catch (_) { resolve(null); }
    });
  }
  function buildImagesPdf(pages) {
    const enc = new TextEncoder();
    const objects = [];
    function add(str, bin) { objects.push({ str: str, bin: bin || null }); return objects.length; }
    const n = pages.length;
    const pageIds = [];
    const contentIds = [];
    const imgIds = [];
    add("<< /Type /Catalog /Pages 2 0 R >>");
    // placeholders filled after we know ids: page objs start at 3
    for (let i = 0; i < n; i++) pageIds.push(3 + i);
    for (let i = 0; i < n; i++) contentIds.push(3 + n + i);
    for (let i = 0; i < n; i++) imgIds.push(3 + 2 * n + i);
    add("<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") + "] /Count " + n + " >>");
    pages.forEach((p, i) => {
      add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w + " " + p.h + "] /Contents " + contentIds[i] + " 0 R /Resources << /XObject << /Im0 " + imgIds[i] + " 0 R >> >> >>");
    });
    pages.forEach((p) => {
      const stream = "q " + p.w + " 0 0 " + p.h + " 0 0 cm /Im0 Do Q\n";
      add("<< /Length " + enc.encode(stream).length + " >>\nstream\n" + stream + "endstream");
    });
    pages.forEach((p) => {
      add("<< /Type /XObject /Subtype /Image /Width " + p.iw + " /Height " + p.ih + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.jpeg.length + " >>\nstream\n", p.jpeg);
    });
    const header = enc.encode("%PDF-1.4\n");
    const chunks = [header];
    const offsets = [0];
    let pos = header.length;
    objects.forEach((obj, i) => {
      offsets.push(pos);
      const head = enc.encode((i + 1) + " 0 obj\n");
      const body = enc.encode(obj.str);
      const tail = enc.encode("\nendobj\n");
      const extra = obj.bin ? obj.bin.length + 10 : 0;
      chunks.push(head, body);
      if (obj.bin) chunks.push(obj.bin, enc.encode("\nendstream"));
      chunks.push(tail);
      pos += head.length + body.length + tail.length + extra;
    });
    let xref = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
    offsets.slice(1).forEach((off) => { xref += String(off).padStart(10, "0") + " 00000 n \n"; });
    xref += "trailer << /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + pos + "\n%%EOF";
    chunks.push(enc.encode(xref));
    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const out = new Uint8Array(total);
    let o = 0;
    chunks.forEach((c) => { out.set(c, o); o += c.length; });
    return out;
  }
  async function exportAnnotatedPdf() {
    if (!state.pdf) {
      setStatus("Open a PDF first.", "warn");
      return;
    }
    const wraps = document.querySelectorAll("#pdf-pages .pdf-page-wrap");
    if (!wraps.length) {
      setStatus("Nothing to export.", "warn");
      return;
    }
    setStatus("Building a high-resolution PDF…", "");
    const pages = [];
    try {
      if (window.pdfjsLib && state.pdf.bytes) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
        const src = await window.pdfjsLib.getDocument({ data: state.pdf.bytes }).promise;
        const count = Math.min(src.numPages, wraps.length);
        for (let n = 1; n <= count; n++) {
          const page = await src.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2.8, 2000 / base.width);
          const viewport = page.getViewport({ scale: scale });
          const out = document.createElement("canvas");
          out.width = Math.round(viewport.width);
          out.height = Math.round(viewport.height);
          const ctx = out.getContext("2d", { alpha: false });
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          await page.render({ canvasContext: ctx, viewport: viewport }).promise;
          drawAnnoOn(ctx, (state.pdf.annos || []).filter((a) => a.page === n), out.width, out.height);
          const jpeg = await canvasToJpegBytes(out);
          if (!jpeg) continue;
          const pt = 72 / 150;
          pages.push({
            jpeg: jpeg,
            iw: out.width,
            ih: out.height,
            w: Math.round(out.width * pt),
            h: Math.round(out.height * pt)
          });
        }
      }
    } catch (err) {
      console.warn(err);
    }
    if (!pages.length) {
      for (let i = 0; i < wraps.length; i++) {
        const wrap = wraps[i];
        const pageCv = wrap.querySelector("canvas:not(.pdf-anno)");
        const anno = wrap.querySelector("canvas.pdf-anno");
        if (!pageCv) continue;
        const out = document.createElement("canvas");
        out.width = pageCv.width;
        out.height = pageCv.height;
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(pageCv, 0, 0);
        if (anno) ctx.drawImage(anno, 0, 0);
        const jpeg = await canvasToJpegBytes(out);
        if (!jpeg) continue;
        const pt = 72 / 150;
        pages.push({ jpeg: jpeg, iw: out.width, ih: out.height, w: Math.round(out.width * pt), h: Math.round(out.height * pt) });
      }
    }
    if (!pages.length) {
      setStatus("Could not export this PDF.", "error");
      return;
    }
    const pdf = buildImagesPdf(pages);
    const blob = new Blob([pdf], { type: "application/pdf" });
    const base = (state.pdf.name || "document").replace(/\.pdf$/i, "");
    await downloadBlob(blob, base + "-marked.pdf", [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]);
  }
  if ($("btn-hide-pdf")) $("btn-hide-pdf").addEventListener("click", () => setPdfVisible(false));
  if ($("btn-close-pdf")) $("btn-close-pdf").addEventListener("click", () => closePdf(true));
  if ($("btn-export-pdf-file")) $("btn-export-pdf-file").addEventListener("click", exportAnnotatedPdf);
  document.querySelectorAll(".pdf-tool").forEach((btn) => {
    btn.addEventListener("click", () => setPdfTool(btn.getAttribute("data-pdf-tool")));
  });
  if ($("btn-pdf-undo")) {
    $("btn-pdf-undo").addEventListener("click", () => {
      if (!state.pdf || !state.pdf.annos || !state.pdf.annos.length) return;
      const last = state.pdf.annos.pop();
      savePdfAnnos();
      if (last) redrawPdfPage(last.page);
    });
  }

  function visiblePdfPage() {
    const host = $("pdf-pages");
    if (!host) return null;
    const pages = host.querySelectorAll(".pdf-page-wrap");
    if (!pages.length) return null;
    const mid = host.scrollTop + host.clientHeight * 0.35;
    let found = pages[0];
    pages.forEach((p) => { if (p.offsetTop <= mid) found = p; });
    return found;
  }
  function restorePdfPage(el) {
    const host = $("pdf-pages");
    if (!host || !el) return;
    host.scrollTop = el.offsetTop;
  }
  function setPdfZoom(z, focus) {
    if (!state.pdf) return;
    const host = $("pdf-pages");
    const inner = $("pdf-zoom-inner");
    const prev = state.pdf.viewZoom || 1;
    const next = Math.max(0.6, Math.min(3, Number(z) || 1));
    let fx = 0.5, fy = 0.5, cx = 0, cy = 0;
    if (host) {
      const r = host.getBoundingClientRect();
      if (focus && focus.clientX != null) {
        fx = (host.scrollLeft + (focus.clientX - r.left)) / prev;
        fy = (host.scrollTop + (focus.clientY - r.top)) / prev;
        cx = focus.clientX - r.left;
        cy = focus.clientY - r.top;
      } else if (focus && focus.contentX != null) {
        fx = focus.contentX;
        fy = focus.contentY;
        cx = focus.viewX != null ? focus.viewX : r.width / 2;
        cy = focus.viewY != null ? focus.viewY : r.height / 2;
      } else {
        fx = (host.scrollLeft + host.clientWidth / 2) / prev;
        fy = (host.scrollTop + host.clientHeight / 2) / prev;
        cx = host.clientWidth / 2;
        cy = host.clientHeight / 2;
      }
    }
    state.pdf.viewZoom = next;
    if (inner) {
      inner.style.transform = "scale(" + next + ")";
      inner.style.transformOrigin = "0 0";
      inner.style.width = "100%";
      const baseH = inner.offsetHeight || inner.scrollHeight || 0;
      const baseW = inner.offsetWidth || inner.scrollWidth || 0;
      inner.style.marginBottom = Math.max(0, baseH * (next - 1)) + "px";
      inner.style.marginRight = Math.max(0, baseW * (next - 1)) + "px";
    }
    if (host) {
      host.scrollLeft = fx * next - cx;
      host.scrollTop = fy * next - cy;
    }
    if ($("pdf-zoom-val")) $("pdf-zoom-val").textContent = Math.round(next * 100) + "%";
  }

  window.addEventListener("touchmove", function (ev) {
    if (state.pdf && state.pdf.inking) ev.preventDefault();
  }, { passive: false });

  if ($("btn-pdf-zoom-in")) $("btn-pdf-zoom-in").addEventListener("click", () => setPdfZoom((state.pdf && state.pdf.viewZoom || 1) + 0.25));
  if ($("btn-pdf-zoom-out")) $("btn-pdf-zoom-out").addEventListener("click", () => setPdfZoom((state.pdf && state.pdf.viewZoom || 1) - 0.25));

  (function setupPdfInteract() {
    const host = $("pdf-pages");
    if (!host) return;
    let drawing = null;
    let pan = null;
    let pinch = null;
    function touchDist(ev) {
      if (!ev.touches || ev.touches.length < 2) return 0;
      return Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
    }
    function beginWrite(ev, wrap) {
      const pageNo = Number(wrap.getAttribute("data-page"));
      const anno = wrap.querySelector(".pdf-anno");
      if (!anno) return;
      document.body.classList.add("pdf-inking");
      state.pdf.inking = true;
      const p = eventPosOnAnno(ev, anno);
      if (state.pdf.tool === "text") {
        const text = window.prompt("Write on the PDF:", "");
        if (text && text.trim()) {
          state.pdf.annos.push({ type: "text", page: pageNo, x: p[0], y: p[1], text: text.trim(), color: "#111827" });
          savePdfAnnos();
          redrawPdfPage(pageNo);
        }
        state.pdf.inking = false;
        document.body.classList.remove("pdf-inking");
        return;
      }
      if (state.pdf.tool === "eraser") {
        const hit = 0.03;
        state.pdf.annos = (state.pdf.annos || []).filter((a) => {
          if (a.page !== pageNo) return true;
          if (a.type === "text") return Math.hypot(a.x - p[0], a.y - p[1]) > hit;
          if (a.type === "path") return !(a.pts || []).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < hit);
          return true;
        });
        savePdfAnnos();
        redrawPdfPage(pageNo);
        state.pdf.inking = false;
        document.body.classList.remove("pdf-inking");
        return;
      }
      drawing = { type: "path", page: pageNo, color: "#e11d48", width: 2.6, pts: [p], wrap: wrap, anno: anno };
    }
    function moveWrite(ev) {
      if (!drawing) return;
      ev.preventDefault();
      drawing.pts.push(eventPosOnAnno(ev, drawing.anno));
      drawAnnoOn(drawing.anno.getContext("2d"), (state.pdf.annos || []).filter((a) => a.page === drawing.page).concat([drawing]), drawing.anno.width, drawing.anno.height);
    }
    function endWrite() {
      if (drawing && drawing.pts.length > 1) {
        const rec = { type: "path", page: drawing.page, color: drawing.color, width: drawing.width, pts: drawing.pts };
        state.pdf.annos.push(rec);
        savePdfAnnos();
        redrawPdfPage(drawing.page);
      }
      drawing = null;
      if (state.pdf) state.pdf.inking = false;
      document.body.classList.remove("pdf-inking");
    }
    host.addEventListener("pointerdown", (ev) => {
      if (!state.pdf) return;
      if (ev.pointerType === "touch" && !isPencilEvent(ev)) {
        pan = { id: ev.pointerId, y: ev.clientY, x: ev.clientX, top: host.scrollTop, left: host.scrollLeft };
        return;
      }
      if (!canWriteWith(ev)) return;
      const wrap = ev.target.closest(".pdf-page-wrap") || pageWrapAtPoint(ev.clientX, ev.clientY);
      if (!wrap) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { host.setPointerCapture(ev.pointerId); } catch (_) {}
      beginWrite(ev, wrap);
    }, { passive: false });
    host.addEventListener("pointermove", (ev) => {
      if (drawing) { moveWrite(ev); return; }
      if (pan && ev.pointerId === pan.id && ev.pointerType === "touch") {
        host.scrollTop = pan.top - (ev.clientY - pan.y);
        host.scrollLeft = pan.left - (ev.clientX - pan.x);
      }
    });
    function stopPan(ev) {
      if (pan && ev && ev.pointerId === pan.id) pan = null;
      if (drawing) endWrite();
    }
    host.addEventListener("pointerup", stopPan);
    host.addEventListener("pointercancel", (ev) => {
      if (drawing && (ev.pointerType === "pen" || isPencilEvent(ev))) {
        ev.preventDefault();
        return;
      }
      stopPan(ev);
    });
    host.addEventListener("touchstart", (ev) => {
      if (!state.pdf) return;
      if (ev.touches.length === 2) {
        ev.preventDefault();
        const z0 = state.pdf.viewZoom || 1;
        const r = host.getBoundingClientRect();
        const mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
        const my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        pinch = {
          d: touchDist(ev),
          z: z0,
          contentX: (host.scrollLeft + (mx - r.left)) / z0,
          contentY: (host.scrollTop + (my - r.top)) / z0
        };
        pan = null;
        return;
      }
      const stylus = ev.touches[0] && ev.touches[0].touchType === "stylus";
      if (stylus && canWriteWith(ev)) {
        ev.preventDefault();
        const t = ev.touches[0];
        const wrap = pageWrapAtPoint(t.clientX, t.clientY);
        if (wrap) beginWrite({ clientX: t.clientX, clientY: t.clientY, pointerType: "pen" }, wrap);
      }
    }, { passive: false });
    host.addEventListener("touchmove", (ev) => {
      if (pinch && ev.touches.length === 2) {
        ev.preventDefault();
        const r = host.getBoundingClientRect();
        const mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
        const my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        setPdfZoom(pinch.z * (touchDist(ev) / (pinch.d || 1)), {
          contentX: pinch.contentX,
          contentY: pinch.contentY,
          viewX: mx - r.left,
          viewY: my - r.top
        });
        return;
      }
      if (drawing && ev.touches[0] && ev.touches[0].touchType === "stylus") {
        ev.preventDefault();
        moveWrite({ clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY });
      }
    }, { passive: false });
    host.addEventListener("touchend", () => { pinch = null; if (drawing) endWrite(); });
    host.addEventListener("wheel", (ev) => {
      if (!state.pdf || !(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setPdfZoom((state.pdf.viewZoom || 1) + (ev.deltaY < 0 ? 0.12 : -0.12));
    }, { passive: false });
  })();

  (function setupPdfResizer() {
    const handle = $("pdf-resizer");
    const panel = $("pdf-panel");
    if (!handle) return;
    let startX = 0;
    let startW = 380;
    let lockPage = null;
    function widthNow() {
      if (panel && panel.offsetWidth) return panel.offsetWidth;
      const v = getComputedStyle(document.body).getPropertyValue("--pdf-w").trim();
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 360;
    }
    function applyW(next) {
      const w = Math.max(220, Math.min(window.innerWidth * 0.7, next));
      document.body.style.setProperty("--pdf-w", w + "px");
      if (panel) panel.style.width = "";
      if (lockPage) restorePdfPage(lockPage);
      invalidateMapSoon();
    }
    function onMove(ev) {
      const x = ev.clientX != null ? ev.clientX : (ev.touches && ev.touches[0] && ev.touches[0].clientX);
      if (x == null) return;
      applyW(startW + (startX - x));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      invalidateMapSoon();
    }
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startX = ev.clientX;
      startW = widthNow();
      lockPage = visiblePdfPage();
      if (handle.setPointerCapture) handle.setPointerCapture(ev.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  })();

  // Open is a <label for="file-input"> so iPhone Safari can show the Files picker.

  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove("drag");
    });
  });
  dz.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

  $("file-list").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.toggle) toggleLayer(t.dataset.toggle, t.checked);
  });
  $("file-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn && btn.dataset.zoomFile) {
      zoomToFile(btn.dataset.zoomFile);
      return;
    }
    if (btn && btn.dataset.removeFile) {
      removeFile(btn.dataset.removeFile);
      return;
    }
    if (btn && btn.dataset.iphoneCopy) {
      downloadIphoneCopy(btn.dataset.iphoneCopy);
      return;
    }
    const row = e.target.closest(".layer-row");
    if (row && row.dataset.key) {
      selectLayer(row.dataset.key);
    }
  });
  $("file-list").addEventListener("dblclick", (e) => {
    const row = e.target.closest(".layer-row");
    if (!row) return;
    const found = findLayer(row.dataset.key);
    if (found) zoomToLayer(found.layer);
  });

  $("basemap").addEventListener("change", (e) => setBasemap(e.target.value));
  if ($("table-sort-col")) {
    $("table-sort-col").addEventListener("change", (e) => {
      state.tableSortCol = e.target.value;
      state.tableSortDir = 1;
      const found = findLayer(state.selectedLayerKey);
      renderTable(found ? found.layer : null);
    });
  }
  if ($("btn-sort-dir")) {
    $("btn-sort-dir").addEventListener("click", () => {
      state.tableSortDir = -(state.tableSortDir || 1);
      const found = findLayer(state.selectedLayerKey);
      renderTable(found ? found.layer : null);
    });
  }
  if ($("btn-import-osm") && $("osm-input")) {
    $("btn-import-osm").addEventListener("click", () => $("osm-input").click());
    $("osm-input").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) openOsmBasemap(f);
    });
  }
  if ($("imported-basemap-list")) {
    $("imported-basemap-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".import-row");
      if (!btn || !row) return;
      const id = row.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if (act === "use") {
        const sel = $("basemap");
        if (sel) sel.value = id;
        setBasemap(id);
      } else if (act === "rename") {
        renameImportedBasemap(id);
      } else if (act === "delete") {
        deleteImportedBasemap(id);
      }
    });
  }
  if ($("btn-open-3d")) {
    $("btn-open-3d").addEventListener("click", () => {
      const c = map.getCenter();
      const url = "https://3d.map.gov.hk/";
      window.open(url, "_blank", "noopener");
      setStatus("Opened 3d.map.gov.hk. Current view is " + c.lat.toFixed(5) + ", " + c.lng.toFixed(5) + ".", "ok");
    });
  }

  function collectEditedCollection() {
    const features = [];
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (ly.kind !== "feature" || !ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          if (!l.feature) return;
          const props = Object.assign({}, l.feature.properties || {});
          delete props._origKey;
          delete props._origLatLng;
          if (props._editColor) {
            props.color = props._editColor;
          }
          let geometry = l.feature.geometry;
          if (typeof l.getLatLng === "function") {
            const ll = l.getLatLng();
            geometry = { type: "Point", coordinates: [ll.lng, ll.lat] };
          }
          features.push({ type: "Feature", properties: props, geometry: geometry });
        });
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  function suggestedSaveName() {
    const n = (state.files[0] && state.files[0].name) || "trees";
    return n.replace(/\.(gpkg|sqlite|db|geojson|json)$/i, "") + "-edited.geojson";
  }

  async function saveAsNewFile() {
    const fc = collectEditedCollection();
    if (!fc.features.length) {
      setStatus("Open a file first, then Save as.", "warn");
      return;
    }
    const name = suggestedSaveName();
    const text = JSON.stringify(fc, null, 2);
    const blob = new Blob([text], { type: "application/geo+json" });
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [
            { description: "GeoJSON", accept: { "application/geo+json": [".geojson"], "application/json": [".json"] } }
          ]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatus("Saved " + handle.name + " (" + fc.features.length + " spots).", "ok");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    setStatus("Downloaded " + name + " (" + fc.features.length + " spots).", "ok");
  }

  function catalogProp(props, aliases) {
    if (!props) return "";
    const keys = Object.keys(props);
    for (let a = 0; a < aliases.length; a++) {
      const want = aliases[a].toLowerCase().replace(/[\s_\-()]/g, "");
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!k || k.charAt(0) === "_") continue;
        const norm = k.toLowerCase().replace(/[\s_\-()]/g, "");
        if (norm === want || norm.indexOf(want) >= 0 || want.indexOf(norm) >= 0) {
          const v = props[k];
          if (v != null && String(v).trim() !== "") return v;
        }
      }
    }
    return "";
  }

  function currentCatalogLayer() {
    const found = findLayer(state.selectedLayerKey);
    if (found && found.layer && found.layer.kind === "feature") return found;
    for (let i = 0; i < state.files.length; i++) {
      const f = state.files[i];
      const ly = (f.layers || []).find((l) => l.kind === "feature" && l.features && l.features.length);
      if (ly) return { file: f, layer: ly };
    }
    return null;
  }

  function sortedCatalogIndexes(layer) {
    const idxs = layer.features.map((_, i) => i);
    if (!state.tableSortCol) return idxs;
    const col = state.tableSortCol;
    const dir = state.tableSortDir || 1;
    idxs.sort((ia, ib) => {
      const av = String((layer.features[ia].properties || {})[col] == null ? "" : (layer.features[ia].properties || {})[col]);
      const bv = String((layer.features[ib].properties || {})[col] == null ? "" : (layer.features[ib].properties || {})[col]);
      const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      return dir * (cmp || (ia - ib));
    });
    return idxs;
  }

  function mapFeatureToInventory(props) {
    const extras = {};
    (state.extraCols || []).forEach((c) => { extras[c] = props && props[c] != null ? props[c] : ""; });
    return {
      treeNo: catalogProp(props, ["tree no", "treeno", "tree id", "treeid", "tree_no", "tree_id", "tree_2025", "tree_ref", "tree number"]),
      scientific: catalogProp(props, ["scientific name", "scientific", "botanical", "species", "latin"]),
      chinese: catalogProp(props, ["chinese name", "chinese", "cn name", "中文"]),
      dbh: catalogProp(props, ["dbh mm", "dbh", "dbh_mm", "diameter"]),
      height: catalogProp(props, ["overall height", "height m", "height_m", "height"]),
      spread: catalogProp(props, ["crown spread", "spread m", "spread_m", "spread", "crown"]),
      health: catalogProp(props, ["health condition", "health", "condition"]),
      structural: catalogProp(props, ["structural condition", "structural", "structure"]),
      remarks: catalogProp(props, ["remarks", "remark", "notes", "note"]),
      mitigation: catalogProp(props, ["proposed mitigation measures", "proposed mitigation", "mitigation", "recommendation", "measures"]),
      emergency: catalogProp(props, ["emergency", "urgent"]),
      extras: extras
    };
  }

  function excelColLetter(n) {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function crc32Bytes(u8) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) {
      crc ^= u8[i];
      for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    function u16(n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }
    function u32(n) { return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]); }
    function concat(parts) {
      let n = 0;
      parts.forEach((p) => { n += p.length; });
      const out = new Uint8Array(n);
      let o = 0;
      parts.forEach((p) => { out.set(p, o); o += p.length; });
      return out;
    }
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32Bytes(data);
      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        name, data
      ]);
      const central = concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    });
    const centralAll = concat(centrals);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralAll.length), u32(offset), u16(0)
    ]);
    return concat(locals.concat([centralAll, end]));
  }

  function xmlEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inventoryCellXml(r, c, value, style) {
    if (value == null || value === "") {
      return '<c r="' + c + r + '" s="' + style + '"/>';
    }
    if (typeof value === "number" && isFinite(value)) {
      return '<c r="' + c + r + '" s="' + style + '" t="n"><v>' + value + "</v></c>";
    }
    const s = String(value);
    const num = Number(s);
    if (s.trim() !== "" && isFinite(num) && !/[^0-9.+-eE]/.test(s.trim())) {
      return '<c r="' + c + r + '" s="' + style + '" t="n"><v>' + num + "</v></c>";
    }
    return '<c r="' + c + r + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(s) + "</t></is></c>";
  }

  function buildInventoryXlsx(locationText, rows) {
    const extraNames = state.extraCols || [];
    const last = Math.max(5 + rows.length - 1, 5);
    const cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
    extraNames.forEach((_, i) => cols.push(excelColLetter(12 + i)));
    let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    sheet += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    sheet += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    sheet += '<sheetFormatPr defaultRowHeight="15"/>';
    sheet += '<cols>';
    sheet += '<col min="1" max="1" width="12" customWidth="1"/>';
    sheet += '<col min="2" max="2" width="28" customWidth="1"/>';
    sheet += '<col min="3" max="3" width="16" customWidth="1"/>';
    sheet += '<col min="4" max="4" width="12" customWidth="1"/>';
    sheet += '<col min="5" max="5" width="14" customWidth="1"/>';
    sheet += '<col min="6" max="6" width="14" customWidth="1"/>';
    sheet += '<col min="7" max="7" width="16" customWidth="1"/>';
    sheet += '<col min="8" max="8" width="18" customWidth="1"/>';
    sheet += '<col min="9" max="9" width="32" customWidth="1"/>';
    sheet += '<col min="10" max="10" width="34" customWidth="1"/>';
    sheet += '<col min="11" max="11" width="12" customWidth="1"/>';
    extraNames.forEach((_, i) => {
      sheet += '<col min="' + (12 + i) + '" max="' + (12 + i) + '" width="18" customWidth="1"/>';
    });
    sheet += "</cols><sheetData>";
    sheet += '<row r="1" ht="20"><c r="A1" s="1" t="inlineStr"><is><t>Tree Inventory</t></is></c></row>';
    sheet += '<row r="2" ht="18"><c r="A2" s="1" t="inlineStr"><is><t>' + xmlEsc(locationText) + "</t></is></c></row>";
    sheet += '<row r="3" ht="31.5">';
    sheet += '<c r="A3" s="2"/>';
    sheet += '<c r="B3" s="2" t="inlineStr"><is><t>Tree Species</t></is></c>';
    sheet += '<c r="D3" s="2" t="inlineStr"><is><t>Estimated Size</t></is></c>';
    sheet += '<c r="G3" s="2" t="inlineStr"><is><t>Health condition</t></is></c>';
    sheet += '<c r="H3" s="2" t="inlineStr"><is><t>Structural Condition</t></is></c>';
    sheet += '<c r="I3" s="2" t="inlineStr"><is><t>Remarks</t></is></c>';
    sheet += '<c r="J3" s="2" t="inlineStr"><is><t>Proposed Mitigation Measures</t></is></c>';
    sheet += '<c r="K3" s="2" t="inlineStr"><is><t>Emergency</t></is></c>';
    sheet += "</row>";
    sheet += '<row r="4" ht="57.75">';
    const h4 = [
      ["A", "Tree No."], ["B", "Scientific Name"], ["C", "Chinese Name"],
      ["D", "DBH (mm)"], ["E", "Overall Height (M)"], ["F", "Crown spread (M)"],
      ["G", "(Fair /Poor/  Dead)"], ["H", "(Fair /Poor/  Dead)"],
      ["I", ""], ["J", ""], ["K", ""]
    ];
    extraNames.forEach((name, i) => h4.push([excelColLetter(12 + i), name]));
    h4.forEach((h) => {
      sheet += '<c r="' + h[0] + '4" s="2"' + (h[1] ? ' t="inlineStr"><is><t>' + xmlEsc(h[1]) + "</t></is></c>" : "/>");
    });
    sheet += "</row>";
    rows.forEach((row, i) => {
      const r = 5 + i;
      const vals = [row.treeNo, row.scientific, row.chinese, row.dbh, row.height, row.spread, row.health, row.structural, row.remarks, row.mitigation, row.emergency];
      extraNames.forEach((name) => vals.push(row.extras && row.extras[name] != null ? row.extras[name] : ""));
      sheet += '<row r="' + r + '">';
      cols.forEach((col, ci) => { sheet += inventoryCellXml(r, col, vals[ci], 3); });
      sheet += "</row>";
    });
    sheet += "</sheetData>";
    sheet += '<mergeCells count="7">';
    sheet += '<mergeCell ref="A1:K1"/><mergeCell ref="A2:K2"/><mergeCell ref="B3:C3"/><mergeCell ref="D3:F3"/>';
    sheet += '<mergeCell ref="I3:I4"/><mergeCell ref="J3:J4"/><mergeCell ref="K3:K4"/>';
    sheet += "</mergeCells></worksheet>";

    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="14"/><name val="Calibri"/></font>' +
      "</fonts>" +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="2">' +
      "<border/><border>" +
      '<left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/>' +
      "</border></borders>" +
      '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      "<xf/>" +
      '<xf fontId="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      '<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      "</cellXfs></styleSheet>";

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Tree Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>";
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>";
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>";

    const bytes = zipStore([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: wbRels },
      { name: "xl/styles.xml", data: styles },
      { name: "xl/worksheets/sheet1.xml", data: sheet }
    ]);
    return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  async function downloadBlob(blob, name, types) {
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: types || [{ description: "Excel", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatus("Saved " + handle.name + ".", "ok");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    setStatus("Downloaded " + name + ".", "ok");
  }

  async function exportCatalogExcel() {
    const found = currentCatalogLayer();
    if (!found || !found.layer || !found.layer.features || !found.layer.features.length) {
      setStatus("Open a tree catalog first, then Export catalog.", "warn");
      return;
    }
    const layer = found.layer;
    const idxs = sortedCatalogIndexes(layer);
    const rows = idxs.map((i) => mapFeatureToInventory(layer.features[i].properties || {}));
    const locName = (found.file && found.file.name ? found.file.name.replace(/\.(gpkg|geojson|json)$/i, "") : "") || layer.tableName || "";
    const location = "Location: " + (locName || layer.tableName || "");
    const blob = buildInventoryXlsx(location, rows);
    const name = (locName || "tree-inventory") + "-inventory.xlsx";
    await downloadBlob(blob, name);
    setStatus("Exported " + rows.length + " trees to " + name + ".", "ok");
  }

  function catalogAllColumns(layer) {
    const set = new Set();
    (layer.columns || []).forEach((k) => { if (k && k.charAt(0) !== "_") set.add(k); });
    (layer.features || []).forEach((ft) => {
      Object.keys(ft.properties || {}).forEach((k) => { if (k && k.charAt(0) !== "_") set.add(k); });
    });
    (state.extraCols || []).forEach((k) => { if (k) set.add(k); });
    return Array.from(set);
  }

  function buildColumnsXlsx(headers, rows) {
    const lastCol = excelColLetter(Math.max(1, headers.length));
    const lastRow = Math.max(1, rows.length + 1);
    let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    sheet += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    sheet += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    sheet += "<cols>";
    headers.forEach((_, i) => {
      sheet += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="18" customWidth="1"/>';
    });
    sheet += "</cols><sheetData>";
    sheet += '<row r="1">';
    headers.forEach((h, i) => {
      sheet += inventoryCellXml(1, excelColLetter(i + 1), h, 1);
    });
    sheet += "</row>";
    rows.forEach((row, ri) => {
      const r = ri + 2;
      sheet += '<row r="' + r + '">';
      row.forEach((val, i) => {
        sheet += inventoryCellXml(r, excelColLetter(i + 1), val, 2);
      });
      sheet += "</row>";
    });
    sheet += "</sheetData>";
    sheet += '<autoFilter ref="A1:' + lastCol + lastRow + '"/></worksheet>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="2"><border/><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border></borders>' +
      '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf borderId="1" applyBorder="1"/></cellXfs></styleSheet>';
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Catalog" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>";
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>";
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>";
    const packed = zipStore([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: wbRels },
      { name: "xl/styles.xml", data: styles },
      { name: "xl/worksheets/sheet1.xml", data: sheet }
    ]);
    return new Blob([packed], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function closeColExport() {
    const mask = $("col-export-mask");
    if (mask) mask.hidden = true;
  }

  function openColExportPicker() {
    const found = currentCatalogLayer();
    if (!found || !found.layer || !found.layer.features || !found.layer.features.length) {
      setStatus("Open a catalog first, then export columns.", "warn");
      return;
    }
    const cols = catalogAllColumns(found.layer);
    if (!cols.length) {
      setStatus("No columns to export.", "warn");
      return;
    }
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem("gpkg-viewer-export-cols") || "[]"); } catch (_) {}
    const savedSet = new Set(Array.isArray(saved) ? saved : []);
    const list = $("col-export-list");
    const useSaved = saved.some((c) => cols.indexOf(c) >= 0);
    list.innerHTML = cols.map((c) => {
      const on = useSaved ? savedSet.has(c) : true;
      return "<label><input type='checkbox' value='" + escapeHtml(c) + "'" + (on ? " checked" : "") + "/> " + escapeHtml(c) + "</label>";
    }).join("");
    $("col-export-mask").hidden = false;
  }

  async function exportSelectedColumns() {
    const found = currentCatalogLayer();
    if (!found || !found.layer) {
      setStatus("Open a catalog first.", "warn");
      return;
    }
    const picks = Array.from(document.querySelectorAll("#col-export-list input[type=checkbox]:checked")).map((el) => el.value);
    if (!picks.length) {
      setStatus("Select at least one column.", "warn");
      return;
    }
    try { localStorage.setItem("gpkg-viewer-export-cols", JSON.stringify(picks)); } catch (_) {}
    const layer = found.layer;
    const idxs = sortedCatalogIndexes(layer);
    const rows = idxs.map((i) => {
      const props = layer.features[i].properties || {};
      return picks.map((col) => (props[col] == null ? "" : props[col]));
    });
    const blob = buildColumnsXlsx(picks, rows);
    const locName = (found.file && found.file.name ? found.file.name.replace(/\.(gpkg|geojson|json|csv)$/i, "") : "") || layer.tableName || "catalog";
    const name = locName + "-columns.xlsx";
    await downloadBlob(blob, name, [{ description: "Excel", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }]);
    closeColExport();
    setStatus("Exported " + picks.length + " columns × " + rows.length + " rows.", "ok");
  }

  if ($("btn-save-as")) $("btn-save-as").addEventListener("click", saveAsNewFile);
  if ($("btn-save-as-2")) $("btn-save-as-2").addEventListener("click", saveAsNewFile);
  if ($("btn-export-xlsx")) $("btn-export-xlsx").addEventListener("click", exportCatalogExcel);
  if ($("btn-export-xlsx-2")) $("btn-export-xlsx-2").addEventListener("click", exportCatalogExcel);
  if ($("btn-export-xlsx-3")) $("btn-export-xlsx-3").addEventListener("click", exportCatalogExcel);
  if ($("btn-export-cols")) $("btn-export-cols").addEventListener("click", openColExportPicker);
  if ($("btn-export-cols-2")) $("btn-export-cols-2").addEventListener("click", openColExportPicker);
  if ($("btn-col-export-all")) $("btn-col-export-all").addEventListener("click", () => {
    document.querySelectorAll("#col-export-list input[type=checkbox]").forEach((el) => { el.checked = true; });
  });
  if ($("btn-col-export-none")) $("btn-col-export-none").addEventListener("click", () => {
    document.querySelectorAll("#col-export-list input[type=checkbox]").forEach((el) => { el.checked = false; });
  });
  if ($("btn-col-export-cancel")) $("btn-col-export-cancel").addEventListener("click", closeColExport);
  if ($("btn-col-export-go")) $("btn-col-export-go").addEventListener("click", exportSelectedColumns);
  if ($("col-export-mask")) $("col-export-mask").addEventListener("click", (e) => {
    if (e.target.id === "col-export-mask") closeColExport();
  });
  if ($("btn-add-spot")) $("btn-add-spot").addEventListener("click", () => setAddSpotMode(!state.addSpotMode));
  if ($("add-spot-field")) {
    $("add-spot-field").addEventListener("change", (e) => {
      state.addSpotField = e.target.value;
    });
  }
  if ($("btn-add-col")) $("btn-add-col").addEventListener("click", addCatalogColumn);
  if ($("btn-add-col-2")) $("btn-add-col-2").addEventListener("click", addCatalogColumn);

  $("btn-fit").addEventListener("click", () => {
    const layers = [];
    state.files.forEach((f) => f.layers.forEach((l) => {
      if (l.visible && l.leafletLayer && l.leafletLayer.getBounds) layers.push(l.leafletLayer);
    }));
    if (!layers.length) {
      setStatus("Nothing to fit.", "warn");
      return;
    }
    const g = L.featureGroup(layers);
    const b = g.getBounds();
    if (b && b.isValid()) map.fitBounds(b, { padding: [28, 28], maxZoom: 16 });
  });

  function clearAllFiles() {
    if (state.pdf) closePdf(false);
    [...state.files].forEach((f) => removeFile(f.id));
    [...state.importedBasemaps].forEach((b) => idbDelete(b.id));
    state.importedBasemaps = [];
    state.activeImportedId = null;
    refreshImportedBasemapUi();
    idbClear();
    setStatus("Cleared.", "");
  }
  $("btn-clear").addEventListener("click", clearAllFiles);
  if ($("btn-clear-mobile")) $("btn-clear-mobile").addEventListener("click", clearAllFiles);

  function setMenuOpen(open) {
    document.body.classList.toggle("menu-open", open);
    const bd = $("backdrop");
    if (bd) bd.hidden = !open;
    setTimeout(() => map.invalidateSize(), 260);
  }
  $("btn-menu").addEventListener("click", () => setMenuOpen(!document.body.classList.contains("menu-open")));
  if ($("btn-close-menu")) $("btn-close-menu").addEventListener("click", () => setMenuOpen(false));
  if ($("backdrop")) $("backdrop").addEventListener("click", () => setMenuOpen(false));

  if (IS_TOUCH) document.body.classList.add("is-touch", "table-collapsed");

  (function setupTableResize() {
    const savedH = parseInt(localStorage.getItem("gpkg-viewer-table-h") || "", 10);
    if (savedH >= 90) document.documentElement.style.setProperty("--table-h", savedH + "px");
    const grip = $("table-resizer");
    if (!grip) return;
    let startY = 0, startH = 0, dragging = false;
    function heightNow() {
      const panel = $("table-panel");
      return panel ? panel.getBoundingClientRect().height : 240;
    }
    function applyH(h) {
      const max = Math.max(160, Math.round(window.innerHeight * 0.78));
      h = Math.max(90, Math.min(max, Math.round(h)));
      document.documentElement.style.setProperty("--table-h", h + "px");
      try { localStorage.setItem("gpkg-viewer-table-h", String(h)); } catch (_) {}
      if (map && map.invalidateSize) map.invalidateSize();
    }
    function onMove(ev) {
      if (!dragging) return;
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      applyH(startH + (startY - y));
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-table");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }
    function onDown(ev) {
      if (!isCatalogOpen()) setCatalogOpen(true);
      dragging = true;
      document.body.classList.add("resizing-table");
      startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      startH = heightNow();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
      ev.preventDefault();
    }
    grip.addEventListener("pointerdown", onDown);
    grip.addEventListener("touchstart", onDown, { passive: false });
  })();
  if ($("btn-cols") && $("col-menu")) {
    $("btn-cols").addEventListener("click", (e) => {
      e.stopPropagation();
      $("col-menu").hidden = !$("col-menu").hidden;
    });
    $("col-menu").addEventListener("change", (e) => {
      const ck = e.target;
      if (!ck || !ck.getAttribute("data-col")) return;
      const col = ck.getAttribute("data-col");
      const hidden = new Set(state.hiddenCols || []);
      if (ck.checked) hidden.delete(col);
      else hidden.add(col);
      state.hiddenCols = Array.from(hidden);
      persistHiddenCols();
      const found = findLayer(state.selectedLayerKey);
      renderTable(found ? found.layer : null);
      $("col-menu").hidden = false;
    });
    document.addEventListener("click", (e) => {
      if ($("col-menu").hidden) return;
      if (e.target.closest && (e.target.closest("#col-menu") || e.target.closest("#btn-cols"))) return;
      $("col-menu").hidden = true;
    });
  }
  function isCatalogOpen() {
    return !document.body.classList.contains("table-collapsed");
  }
  function setCatalogOpen(open) {
    document.body.classList.toggle("table-collapsed", !open);
    const btn = $("btn-toggle-table");
    if (btn) btn.textContent = open ? "Close catalog" : "Open catalog";
    const wrap = $("table-wrap");
    if (!open) {
      if (wrap) wrap.innerHTML = "";
      if ($("col-menu")) $("col-menu").hidden = true;
    } else {
      const found = findLayer(state.selectedLayerKey);
      renderTable(found ? found.layer : null);
    }
    setTimeout(function () {
      if (map && map.invalidateSize) map.invalidateSize();
    }, 60);
  }
  $("btn-toggle-table").addEventListener("click", () => {
    setCatalogOpen(!isCatalogOpen());
  });
  setCatalogOpen(isCatalogOpen());

  $("limit").addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v > 0) state.featureLimit = v;
  });

  $("show-labels").addEventListener("change", (e) => {
    state.showLabels = e.target.checked;
    applyAllLabels();
  });
  if ($("label-frame")) {
    $("label-frame").checked = state.labelFrame;
    $("label-frame").addEventListener("change", (e) => {
      state.labelFrame = e.target.checked;
      persistSizes();
      applyAllLabels();
    });
  }
  if ($("spot-color")) {
    $("spot-color").addEventListener("input", (e) => {
      paintSpot(state.selectedMarker, e.target.value, true);
    });
  }
  if ($("btn-move-spot")) {
    $("btn-move-spot").addEventListener("click", () => setMoveMode(!state.moveMode));
  }
  if ($("btn-mark-red")) {
    $("btn-mark-red").addEventListener("click", () => markSpotRed(state.selectedMarker));
  }
  if ($("btn-delete-spot")) $("btn-delete-spot").addEventListener("click", deleteSelectedSpot);
  if ($("btn-delete-row")) $("btn-delete-row").addEventListener("click", deleteSelectedSpot);
  if ($("btn-reset-spot")) {
    $("btn-reset-spot").addEventListener("click", () => {
      const m = state.selectedMarker;
      if (!m || !m.feature) return;
      const orig = m.feature.properties && m.feature.properties._origLatLng;
      if (orig && typeof m.setLatLng === "function") {
        m.setLatLng(orig);
        m.feature.geometry = { type: "Point", coordinates: [orig[1], orig[0]] };
        bindFeatureLabel(m);
      }
      paintSpot(m, null, true);
      setStatus("Restored original color and location.", "ok");
    });
  }

  function bindSizeSlider(id, key, valId, applyFn) {
    const el = $(id);
    const val = $(valId);
    if (!el) return;
    el.value = String(state[key]);
    if (val) val.textContent = String(state[key]);
    el.addEventListener("input", () => {
      state[key] = parseInt(el.value, 10);
      if (val) val.textContent = String(state[key]);
      persistSizes();
      applyFn();
    });
  }
  bindSizeSlider("marker-size", "markerSize", "marker-size-val", applyMarkerSize);
  bindSizeSlider("label-size", "labelSize", "label-size-val", applyLabelSize);
  applyLabelSize();

  $("label-field").addEventListener("change", (e) => {
    state.labelField = e.target.value;
    applyAllLabels();
  });

  function setTooltipPaneHidden(hidden) {
    const pane = map.getPane("tooltipPane");
    if (pane) pane.style.visibility = hidden ? "hidden" : "";
  }
  map.on("zoomstart", function () {
    setTooltipPaneHidden(true);
    const wrap = $("table-wrap");
    if (wrap && isCatalogOpen()) wrap.style.display = "none";
  });
  let zoomSizeTimer = null;
  map.on("zoomend", function () {
    if (zoomSizeTimer) clearTimeout(zoomSizeTimer);
    zoomSizeTimer = setTimeout(function () {
      applyMarkerRadii();
      setTooltipPaneHidden(false);
      const wrap = $("table-wrap");
      if (wrap && isCatalogOpen()) wrap.style.display = "";
    }, IS_TOUCH ? 220 : 40);
  });
  map.on("moveend resize", scheduleLabelUpdate);

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      $("file-input").click();
    }
  });

  // Resize map when sidebar changes
  window.addEventListener("resize", () => map.invalidateSize());

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js?v=72").catch(() => {});
  }

  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS && $("ios-help")) $("ios-help").hidden = false;

  if ($("btn-refresh-app")) {
    $("btn-refresh-app").addEventListener("click", async () => {
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch (_) {}
      location.reload();
    });
  }

  if (standalone && isIOS) {
    setStatus("iPhone Home Screen mode may block file picking. Open this page in Safari to load a .gpkg.", "warn");
  }

  setStatus("Ready. Open a .gpkg file to begin. Completely local — files never leave this device.", "ok");
  bootLibrary();

  (async function restoreSessionFiles() {
    try {
      const rows = await idbAll();
      if (!rows.length) return;
      setStatus("Restoring " + rows.length + " file" + (rows.length === 1 ? "" : "s") + " from last session…", "");
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bytes = row.bytes;
        const file = new File([bytes], row.name || "restored", { type: row.mime || "" });
        if (row.kind === "osm") await openOsmBasemap(file, { fromStore: true, id: row.id, title: row.title });
        else if (row.kind === "geojson") await openGeoJsonFile(file, { fromStore: true, id: row.id });
        else if (row.kind === "pdf") await openPdfFile(file, { fromStore: true, id: row.id, bytes: bytes });
        else await openGpkgFile(file, { fromStore: true, id: row.id });
      }
      const lastMap = localStorage.getItem("gpkg-viewer-basemap");
      if (lastMap) {
        const sel = $("basemap");
        if (sel) sel.value = lastMap;
        setBasemap(lastMap);
      }
      setStatus("Restored " + rows.length + " file" + (rows.length === 1 ? "" : "s") + " from last session.", "ok");
    } catch (err) {
      console.warn(err);
    }
  })();

  // Optional bundled sample: open with ?demo=1
  if (/\bdemo=1\b/.test(location.search)) {
    fetch("samples/rivers.gpkg")
      .then((r) => {
        if (!r.ok) throw new Error("sample missing");
        return r.arrayBuffer();
      })
      .then((buf) => {
        const file = new File([buf], "rivers.gpkg", { type: "application/geopackage+sqlite3" });
        handleFiles([file]);
      })
      .catch((e) => setStatus("Demo sample not available: " + e.message, "warn"));
  }
})();
