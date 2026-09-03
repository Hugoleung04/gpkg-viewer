const CACHE = "gpkg-viewer-v42";
const ASSETS = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/geopackage.min.js",
  "./vendor/sql-wasm.wasm",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./offline/db-roads.json.gz",
  "./offline/db-water.json.gz",
  "./offline/db-waterways.json.gz",
  "./offline/db-landuse.json.gz",
  "./offline/db-buildings.json.gz",
  "./offline/db-rail.json.gz",
  "./offline/db-places.json.gz"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Always try the network first for app files so updates actually appear.
  const isAppFile = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith("/");
  if (isAppFile) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
