// PX POS service worker: app shell offline-capable, always fresh when online (network first).
const CACHE = "pxpos-v1";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/printer.js", "js/config.js", "vendor/supabase.js", "manifest.webmanifest", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // never cache Supabase calls
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
