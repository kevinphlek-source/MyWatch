// Mode hors ligne : l'app se charge même sans réseau.
const CACHE = "mes-montres-v9";
const PHOTOS = "mes-montres-photos-v1";
const CORE = ["./", "index.html", "manifest.webmanifest", "colorways.js", "fonts/bodoni-moda-latin-500-normal.woff2", "fonts/bodoni-moda-latin-600-normal.woff2", "fonts/bodoni-moda-latin-700-normal.woff2", "fonts/manrope-latin-400-normal.woff2", "fonts/manrope-latin-500-normal.woff2", "fonts/manrope-latin-600-normal.woff2", "fonts/manrope-latin-700-normal.woff2", "fonts/manrope-latin-800-normal.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTOS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Page : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne
  if (req.mode === "navigate"){
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); return r; }).catch(() => caches.match("index.html")));
    return;
  }
  // Photos réelles (Wikimedia Commons) : gardées pour l'affichage hors ligne
  if (url.hostname === "upload.wikimedia.org"){
    e.respondWith(caches.open(PHOTOS).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }))));
    return;
  }
  // Polices Google et fichiers de l'app : cache d'abord
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === "opaque"){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })));
  }
});
