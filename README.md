# Offline GeoPackage Viewer

A small, fully local app for opening and inspecting OGC GeoPackage (`.gpkg`) files.

- No install of QGIS / ArcGIS
- Files are read in your browser — they are never uploaded
- Works offline for vector layers (and GPKG raster tiles)
- Optional online basemap if you have internet

## Requirements

- A modern browser (Chrome, Edge, Firefox, Safari)
- Python 3 (only used to serve the page on `localhost`)

Why Python? The GeoPackage engine uses WebAssembly. Browsers block that from `file://` pages, so a tiny local web server is needed. The server does not talk to the internet.

## Start

### Windows

Double-click `start.bat`, or in a terminal:

```bat
python start.py
```

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

Your browser should open `http://127.0.0.1:8765/`. Leave the terminal window open while you use the viewer. Press `Ctrl+C` to stop.

## Use on a phone

This is a mobile web app (PWA), not a store APK/IPA. Same folder, phone-sized layout.

### Option A — same Wi-Fi as your computer

1. Start the viewer on the computer (`start.bat` / `start.sh`).
2. The terminal prints a phone address, for example `http://192.168.1.23:8765/`.
3. On the phone, open that address in Chrome or Safari.
4. Tap **Open** and pick a `.gpkg` from Files / Drive / Downloads.
5. Optional: browser menu → **Add to Home Screen** for an app-like icon.

Windows may ask to allow Python through the firewall the first time.

### Option B — GitHub Pages

Upload this folder to GitHub and enable Pages. Open the Pages URL on the phone, then Add to Home Screen. After the first visit the app caches itself and can reopen offline. You still pick `.gpkg` files from the phone.

A sample file is included. After the viewer starts you can open `http://127.0.0.1:8765/?demo=1` to load `samples/rivers.gpkg`.

## Use

1. Click **Open .gpkg** or drop one or more `.gpkg` files onto the left panel.
2. Toggle layers with the checkboxes.
3. Click a layer to see its attribute table.
4. Double-click a layer (or use **Zoom to file** / **Fit all**) to frame it.
5. Click a feature on the map for a popup of its attributes.
6. Keep **Basemap = Blank** for fully offline use. OSM / Carto need internet.

Large layers: by default only the first 25,000 features of each table are drawn so the browser stays responsive. Raise **Feature cap** before opening a file if you need more.

## What it can show

| Contents of the GPKG | Support |
|---|---|
| Vector features (points, lines, polygons) | Yes — drawn on the map + attribute table |
| Multiple layers in one file | Yes |
| Multiple files at once | Yes |
| Raster / tile pyramids stored in the GPKG | Best-effort (XYZ tiles) |
| Editing, styling, analysis, export | No — this is a viewer |

If you later need editing, printing, or analysis, install [QGIS](https://qgis.org/) (free). This app is only for quick local viewing.

## Folder layout

```
gpkg-viewer/
  start.py          launcher
  start.bat         Windows launcher
  start.sh          macOS / Linux launcher
  index.html
  app.js
  styles.css
  vendor/           Leaflet + GeoPackage JS + sql-wasm.wasm
```

## Credits

- [NGA GeoPackage JS](https://github.com/ngageoint/geopackage-js) (`@ngageoint/geopackage`)
- [Leaflet](https://leafletjs.com/)
