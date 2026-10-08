// Chaty service worker: makes the web app installable and lets it open
// offline. Pages load network-first (always fresh when online); hashed
// assets and icons are served from the cache. API calls, the socket,
// uploads and downloads always go to the network.
const VERSION = '__CHATY_BUILD__';
const CACHE = `chaty-${VERSION}`;
const SHELL = ['/', '/app/', '/manifest.webmanifest', '/icon-192.png', '/icon.png', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chaty-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/(api|ws|uploads|download)(\/|$)/.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    const key = url.pathname.startsWith('/app') ? '/app/' : url.pathname;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(key, res.clone()));
          return res;
        })
        .catch(() => caches.match(key).then((hit) => hit || caches.match('/app/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
