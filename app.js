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
    bounceAtZoomLimits: false
  }).setView([22.3193, 114.1694], 11); // Hong Kong default
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
        if (!state.offlineRoadCasing) return;
        state.offlineRoadCasing.setStyle((feat) => roadStyle(feat, true));
        state.offlineRoadFill.setStyle((feat) => roadStyle(feat, false));
      };
      map.on("zoomend", state._offRoadZoom);
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
    setStatus("Deleted imported basemap “" + rec.name + "”.", "ok");
  }

  async function openOsmBasemap(file) {
    setStatus("Reading " + file.name + "…", "");
    const text = await file.text();
    const parsed = parseOsmXml(text);
    const rec = {
      id: "imp-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
      name: defaultOsmName(file.name),
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

  function iterateFeatures(geoPackage, tableName) {
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
  }

  function pointToLayer(color) {
    return function (feature, latlng) {
      const c = (feature.properties && feature.properties._editColor) || color;
      return L.circleMarker(latlng, styleFor(c, "point"));
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
      L.DomEvent.stop(e);
      map.dragging.disable();
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
    ev.preventDefault();
    map.dragging.disable();
    draggingMarker = hit;
    dragMoved = false;
    lastTap = { layer: null, t: 0 };
  }, { passive: false });
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
    draggingMarker.setLatLng(e.latlng);
    dragMoved = true;
  });
  function finishDrag() {
    if (!draggingMarker) return;
    const m = draggingMarker;
    if (typeof m.getLatLng === "function" && m.feature) {
      const ll = m.getLatLng();
      m.feature.geometry = { type: "Point", coordinates: [ll.lng, ll.lat] };
      bindFeatureLabel(m);
      persistColorEdits();
      refreshEditPanel();
      if (dragMoved) setStatus("Moved " + (labelText(m.feature, state.labelField) || "spot") + " and saved.", "ok");
    }
    draggingMarker = null;
    map.dragging.enable();
  }
  map.on("mouseup", finishDrag);
  map.on("click", function () {
    if (state.moveMode || draggingMarker || dragMoved) return;
    selectMarker(null);
  });

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
    if (!state.labelField && keys.length) state.labelField = guessLabelField(keys);
    if (state.labelField && keys.indexOf(state.labelField) === -1 && keys.length) {
      state.labelField = guessLabelField(keys);
    }
    const prev = state.labelField;
    sel.innerHTML = keys.length
      ? keys.map((k) => '<option value="' + escapeHtml(k) + '"' + (k === prev ? " selected" : "") + ">" + escapeHtml(k) + "</option>").join("")
      : '<option value="">(no fields)</option>';
    if (prev) sel.value = prev;
  }

  // ---------- Load file ----------
  async function openGpkgFile(file) {
    if (!bootLibrary()) return;
    setStatus("Opening " + file.name + " …", "");
    $("dropzone").classList.add("busy");

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const geoPackage = await openGeoPackageBytes(bytes);

      const fileId = "f" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
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
            if (feat && feat.type === "Feature") features.push(feat);
            else if (feat && feat.geometry) features.push(feat);
            else if (feat && feat.value && feat.value.geometry) features.push(feat.value);
            if (features.length >= limit) {
              truncated = true;
              break;
            }
          }
        } else if (Array.isArray(rs)) {
          for (const feat of rs) {
            if (feat) features.push(feat);
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
    const allCols = Array.from(colsSet);
    const hidden = new Set(state.hiddenCols || []);
    const cols = allCols.filter((c) => !hidden.has(c));
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
    const maxRows = Math.min(idxs.length, 500);

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
      html += "<tr class='" + (inspected ? "inspected" : "") + "'>";
      html += "<td class='ck-col'><input type='checkbox' class='inspect-ck' data-i='" + i + "'" +
        (inspected ? " checked" : "") + " /></td>";
      html += "<td>" + (i + 1) + "</td>";
      cols.forEach((c) => {
        html += "<td class='editable' data-i='" + i + "' data-col=\"" + escapeHtml(c) + "\">" +
          escapeHtml(p[c]) + "</td>";
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
      if (!th) return;
      const col = th.getAttribute("data-col");
      if (!col) return;
      if (state.tableSortCol === col) state.tableSortDir = -(state.tableSortDir || 1);
      else {
        state.tableSortCol = col;
        state.tableSortDir = 1;
      }
      renderTable(layer);
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
    }
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
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
  async function openGeoJsonFile(file) {
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

      features.forEach((ft) => {
        const p = ft.properties || {};
        if (p.color && !p._editColor) p._editColor = p.color;
        ft.properties = p;
      });

      const fileId = "f" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
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
      state.files.push(rec);
      refreshLabelFieldOptions();
      applyAllLabels();
      renderSidebar();
      if (leafletLayer.getBounds && leafletLayer.getBounds().isValid()) {
        map.fitBounds(leafletLayer.getBounds(), { padding: [28, 28], maxZoom: 16 });
      }
      setStatus("Loaded " + file.name + " — " + features.length + " features.", "ok");
    } catch (err) {
      console.error(err);
      setStatus("Could not open " + file.name + ": " + (err && err.message ? err.message : err), "error");
    }
  }

  function openAnyFile(file) {
    const n = (file.name || "").toLowerCase();
    if (n.endsWith(".osm") || n.endsWith(".osm.xml")) return openOsmBasemap(file);
    if (n.endsWith(".geojson") || n.endsWith(".json")) return openGeoJsonFile(file);
    return openGpkgFile(file);
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
        n.endsWith(".osm") || n.endsWith(".osm.xml") ||
        f.type === "application/geopackage+sqlite3" || f.type === "application/geo+json" ||
        f.type === "application/json";
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

  if ($("btn-save-as")) $("btn-save-as").addEventListener("click", saveAsNewFile);
  if ($("btn-save-as-2")) $("btn-save-as-2").addEventListener("click", saveAsNewFile);

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
    [...state.files].forEach((f) => removeFile(f.id));
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
      if (document.body.classList.contains("table-collapsed")) return;
      dragging = true;
      document.body.classList.remove("table-collapsed");
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
  $("btn-toggle-table").addEventListener("click", () => {
    document.body.classList.toggle("table-collapsed");
    setTimeout(() => map.invalidateSize(), 220);
  });

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

  let zoomSizeTimer = null;
  map.on("zoomend", function () {
    if (zoomSizeTimer) clearTimeout(zoomSizeTimer);
    zoomSizeTimer = setTimeout(function () {
      applyMarkerRadii();
      if (!IS_TOUCH) applyAllLabels();
    }, IS_TOUCH ? 80 : 0);
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
    navigator.serviceWorker.register("sw.js?v=41").catch(() => {});
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
