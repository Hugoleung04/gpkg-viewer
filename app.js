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
    basemap: null,
    featureLimit: MAX_FEATURES_DEFAULT,
    showLabels: true,
    labelField: "",
    labelMinZoom: 0,
    markerSize: 4,
    labelSize: 9
  };

  try {
    const saved = JSON.parse(localStorage.getItem("gpkg-viewer-sizes") || "null");
    if (saved && saved.markerSize) state.markerSize = saved.markerSize;
    if (saved && saved.labelSize) state.labelSize = saved.labelSize;
  } catch (_) {}

  function persistSizes() {
    try {
      localStorage.setItem("gpkg-viewer-sizes", JSON.stringify({
        markerSize: state.markerSize,
        labelSize: state.labelSize
      }));
    } catch (_) {}
  }

  const $ = (id) => document.getElementById(id);

  // ---------- Map ----------
  const IS_TOUCH = window.matchMedia("(pointer: coarse)").matches ||
    "ontouchstart" in window;

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

  const blankPaneBg = document.querySelector(".leaflet-container");

  function setBasemap(mode) {
    if (state.basemap) {
      map.removeLayer(state.basemap);
      state.basemap = null;
    }
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
    }
    // blank: no tiles
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
  function setStatus(msg, kind) {
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + (kind || "");
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

  function styleFor(color, geomType) {
    const t = (geomType || "").toLowerCase();
    const r = state.markerSize;
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

  function applyMarkerSize() {
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (ly.kind !== "feature" || !ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          const st = styleFor(ly.color, ly.geomType);
          if (typeof l.setRadius === "function") l.setRadius(st.radius);
          if (typeof l.setStyle === "function") l.setStyle(st);
        });
      });
    });
    applyAllLabels();
  }

  function applyLabelSize() {
    document.documentElement.style.setProperty("--label-size", state.labelSize + "px");
    measureCtx.font = "700 " + state.labelSize + 'px "Segoe UI","PingFang HK","Noto Sans TC",system-ui,sans-serif';
    Object.keys(labelBoxCache).forEach((k) => { delete labelBoxCache[k]; });
    scheduleLabelUpdate();
  }

  function pointToLayer(color) {
    return function (feature, latlng) {
      return L.circleMarker(latlng, styleFor(color, "point"));
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

  if (!map.getPane("idLabels")) {
    map.createPane("idLabels");
    map.getPane("idLabels").style.zIndex = "650";
    map.getPane("idLabels").style.pointerEvents = "none";
  }
  const labelGroup = L.layerGroup().addTo(map);
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = "700 " + state.labelSize + 'px "Segoe UI","PingFang HK","Noto Sans TC",system-ui,sans-serif';
  const labelBoxCache = {};
  let labelUpdateTimer = null;
  let labelMarkersBuiltFor = "";

  function measureLabelBox(text) {
    if (labelBoxCache[text]) return labelBoxCache[text];
    const padX = Math.max(6, Math.round(state.labelSize * 0.7));
    const w = Math.ceil(measureCtx.measureText(text).width) + padX;
    const box = { w: w, h: Math.round(state.labelSize + 6) };
    labelBoxCache[text] = box;
    return box;
  }

  function boxesOverlap(a, b, pad) {
    return !(
      a.x + a.w + pad <= b.x ||
      b.x + b.w + pad <= a.x ||
      a.y + a.h + pad <= b.y ||
      b.y + b.h + pad <= a.y
    );
  }

  function collectLabelCandidates() {
    const field = state.labelField;
    const out = [];
    state.files.forEach((f) => {
      f.layers.forEach((ly) => {
        if (!ly.visible || ly.kind !== "feature" || !ly.leafletLayer) return;
        ly.leafletLayer.eachLayer((l) => {
          const text = labelText(l.feature, field);
          if (!text) return;
          let latlng = null;
          if (typeof l.getLatLng === "function") latlng = l.getLatLng();
          else if (typeof l.getBounds === "function") {
            const b = l.getBounds();
            if (b && b.isValid()) latlng = b.getCenter();
          }
          if (!latlng) return;
          out.push({ latlng: latlng, text: text });
        });
      });
    });
    return out;
  }

  function labelSignature() {
    return [
      state.showLabels ? "1" : "0",
      state.labelField,
      state.labelSize,
      state.markerSize,
      state.files.map((f) => f.id + ":" + f.layers.filter((l) => l.visible).map((l) => l.tableName).join(",")).join("|")
    ].join("/");
  }

  function rebuildLabelMarkers() {
    labelGroup.clearLayers();
    labelMarkersBuiltFor = labelSignature();
    if (!labelsShouldShow()) return;

    const gap = Math.max(5, state.markerSize + 2);
    const candidates = collectLabelCandidates();
    for (let i = 0; i < candidates.length; i++) {
      const box = measureLabelBox(candidates[i].text);
      const marker = L.marker(candidates[i].latlng, {
        interactive: false,
        keyboard: false,
        pane: "idLabels",
        zIndexOffset: 500,
        icon: L.divIcon({
          className: "map-id-label-wrap",
          html: '<div class="map-id-label">' + escapeHtml(candidates[i].text) + "</div>",
          iconSize: [box.w, box.h],
          iconAnchor: [-gap, Math.round(box.h / 2)]
        })
      });
      marker._labelW = box.w;
      marker._labelH = box.h;
      marker._labelGap = gap;
      labelGroup.addLayer(marker);
    }
    declutterLabelMarkers();
  }

  function declutterLabelMarkers() {
    if (!labelsShouldShow()) {
      labelGroup.eachLayer((m) => {
        if (m._icon) m._icon.style.visibility = "hidden";
      });
      return;
    }
    const size = map.getSize();
    const items = [];
    labelGroup.eachLayer((m) => {
      const pt = map.latLngToContainerPoint(m.getLatLng());
      const gap = m._labelGap || 6;
      const w = m._labelW || 24;
      const h = m._labelH || 14;
      const box = { x: pt.x + gap, y: pt.y - h / 2, w: w, h: h };
      const inView = box.x < size.x && box.y < size.y && box.x + box.w > 0 && box.y + box.h > 0;
      items.push({ marker: m, box: box, inView: inView });
    });

    const occupied = [];
    let shown = 0;
    let hidden = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let vis = item.inView;
      if (vis) {
        for (let o = 0; o < occupied.length; o++) {
          if (boxesOverlap(item.box, occupied[o], 1)) {
            vis = false;
            break;
          }
        }
      }
      if (vis) {
        occupied.push(item.box);
        shown += 1;
      } else if (item.inView) {
        hidden += 1;
      }
      if (item.marker._icon) {
        item.marker._icon.style.visibility = vis ? "visible" : "hidden";
      }
    }
    if (hidden > 0) {
      setStatus("Showing " + shown + " of " + (shown + hidden) + " IDs in view — zoom in to see the rest.", "");
    }
  }

  function updateDeclutteredLabels() {
    const sig = labelSignature();
    if (sig !== labelMarkersBuiltFor) rebuildLabelMarkers();
    else declutterLabelMarkers();
  }

  function scheduleLabelUpdate() {
    if (labelUpdateTimer) cancelAnimationFrame(labelUpdateTimer);
    labelUpdateTimer = requestAnimationFrame(updateDeclutteredLabels);
  }

  function applyLabelsToLayer() {
    labelMarkersBuiltFor = "";
    scheduleLabelUpdate();
  }

  function applyAllLabels() {
    labelMarkersBuiltFor = "";
    scheduleLabelUpdate();
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
        onEachFeature: (feat, lyr) => bindPopup(lyr, feat, tableName),
        renderer: L.canvas({ padding: 0.5 })
      }
    );
    leafletLayer.addTo(map);

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
      html += '<button type="button" class="danger" data-remove-file="' + f.id + '">Remove</button>';
      html += "</div></div>";
    });

    host.innerHTML = html;
    $("stats").textContent = state.files.length + " file" + (state.files.length === 1 ? "" : "s") +
      " · " + totalLayers + " layers · " + totalFeats.toLocaleString() + " features";
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
      Object.keys(ft.properties || {}).forEach((k) => colsSet.add(k));
    });
    const cols = Array.from(colsSet);
    const maxRows = Math.min(layer.features.length, 500);

    let html = "<table class='attr'><thead><tr><th>#</th>";
    cols.forEach((c) => { html += "<th>" + escapeHtml(c) + "</th>"; });
    html += "</tr></thead><tbody>";
    for (let i = 0; i < maxRows; i++) {
      const p = layer.features[i].properties || {};
      html += "<tr>";
      html += "<td>" + (i + 1) + "</td>";
      cols.forEach((c) => { html += "<td>" + escapeHtml(p[c]) + "</td>"; });
      html += "</tr>";
    }
    html += "</tbody></table>";
    if (layer.features.length > maxRows) {
      html += '<p class="empty-hint">Showing first ' + maxRows + " rows in the table.</p>";
    }
    wrap.innerHTML = html;
  }

  // ---------- Events ----------
  function handleFiles(fileList) {
    const raw = Array.from(fileList || []);
    if (!raw.length) {
      setStatus("No file selected.", "warn");
      return;
    }
    const preferred = raw.filter((f) => {
      const n = (f.name || "").toLowerCase();
      return n.endsWith(".gpkg") || n.endsWith(".gpkg.zip") || n.endsWith(".sqlite") ||
        f.type === "application/geopackage+sqlite3";
    });
    // iPhone Files often hides .gpkg from filtered pickers and may omit the extension.
    const files = preferred.length ? preferred : raw;
    files.reduce((p, f) => p.then(() => openGpkgFile(f)), Promise.resolve());
  }

  $("file-input").addEventListener("change", (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  });

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

  map.on("moveend zoomend resize", scheduleLabelUpdate);

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
    navigator.serviceWorker.register("sw.js?v=15").catch(() => {});
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
