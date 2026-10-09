// Chaty service worker: makes the web app installable and lets it open
// offline, and shows push notifications. Pages load network-first (always
// fresh when online); hashed assets and icons are served from the cache. API
// calls, the socket, uploads and downloads always go to the network.
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

// ---------- push notifications (Firebase Cloud Messaging data messages) ----------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json()?.data ?? {};
  } catch {
    /* not ours */
  }
  event.waitUntil(showPush(data));
});

async function showPush(d) {
  const tag = d.tag || 'chaty';
  if (d.type === 'call-end') {
    // The call stopped ringing: take its notification down ("missed call" replaces it).
    for (const n of await self.registration.getNotifications({ tag })) n.close();
    if (!d.title) return;
  }
  return self.registration.showNotification(d.title || 'Chaty', {
    body: d.body || '',
    tag,
    renotify: d.type !== 'call-end',
    requireInteraction: d.type === 'call',
    vibrate: d.type === 'call' ? [400, 200, 400, 200, 400] : [120],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/app/' },
  });
}

// Tapping a notification opens the chat: in an open app window if there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/app/', location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = wins.find((w) => new URL(w.url).pathname.startsWith('/app'));
      if (!app) return self.clients.openWindow(url);
      app.postMessage({ type: 'open', url });
      return app.focus();
    })(),
  );
});

