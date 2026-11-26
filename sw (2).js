// HaulGo service worker v2: fast loading.
// - App page: network first, but falls back to the saved copy after 3s (slow data) or when offline.
// - Libraries, images, icons: saved copy first (instant), refreshed quietly in the background.
const C = "haulgo-v2";
const PRE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/vendor/leaflet.js", "/vendor/leaflet.css", "/vendor/supabase.js", "/img/login-bg.jpg"];
self.addEventListener("install", e => {
  // add one by one so a missing file never blocks installing
  e.waitUntil(caches.open(C).then(c => Promise.all(PRE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
const save = (r, res) => { if (res && res.ok && res.status === 200) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; };
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return; // never touch logins, payments or the AI check
  const isPage = r.mode === "navigate" || r.destination === "document";
  if (isPage) {
    e.respondWith(new Promise(resolve => {
      let done = false;
      const fallback = () => caches.match(r).then(m => m || caches.match("/")).then(m => { if (m && !done) { done = true; resolve(m); } });
      const t = setTimeout(fallback, 3000);
      fetch(r).then(res => { clearTimeout(t); save(r, res); if (!done) { done = true; resolve(res); } })
        .catch(() => { clearTimeout(t); fallback().then(() => { if (!done) { done = true; resolve(Response.error()); } }); });
    }));
    return;
  }
  e.respondWith(caches.match(r).then(m => {
    const net = fetch(r).then(res => save(r, res)).catch(() => m);
    return m || net;
  }));
});
