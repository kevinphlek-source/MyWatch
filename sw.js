// Mode hors ligne : l'app se charge même sans réseau, mais prend toujours la dernière version quand le réseau est là.
const CACHE = "mes-montres-v17";
const CORE = ["./", "index.html", "manifest.webmanifest", "colorways.js", "fonts/bodoni-moda-latin-500-normal.woff2", "fonts/bodoni-moda-latin-600-normal.woff2", "fonts/bodoni-moda-latin-700-normal.woff2", "fonts/manrope-latin-400-normal.woff2", "fonts/manrope-latin-500-normal.woff2", "fonts/manrope-latin-600-normal.woff2", "fonts/manrope-latin-700-normal.woff2", "fonts/manrope-latin-800-normal.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const fresh = (req, key) => fetch(req, { cache: "no-store" }).then(r => { if (r.ok){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(key || req, copy)); } return r; });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // page et scripts : toujours la version en ligne (sans cache du navigateur), copie locale si hors ligne
  if (req.mode === "navigate"){ e.respondWith(fresh(req, "index.html").catch(() => caches.match("index.html"))); return; }
  if (/\.(js|json|webmanifest|html)$/.test(url.pathname)){ e.respondWith(fresh(req).catch(() => caches.match(req))); return; }
  // polices et icônes : cache d'abord
  e.respondWith(caches.match(req).then(hit => hit || fresh(req)));
});
