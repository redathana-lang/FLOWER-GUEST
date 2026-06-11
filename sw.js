/* Gonxhe PWA service worker — makes the dashboards installable & app-like.
   Network-first so dashboards always show live data when online; falls back
   to cache offline. API/auth requests are never cached. */
const CACHE = 'gonxhe-v1';
const SHELL = [
  '/dashboard', '/dashboard/hotel', '/dashboard/website',
  '/manifest.json', '/flower-logo.png', '/gonxhe-avatar.jpg',
  '/icon-180.png', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // leave cross-origin alone
  if (url.pathname.startsWith('/api/')) return;        // live data + auth: always network
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
