// Service worker: appka sa otvorí aj pri slabom signáli. Vlastné súbory network-first (vždy čerstvé, offline z cache);
// Google Maps a live dáta z čipu (/clax/) idú vždy priamo na sieť.
const VERSION = '__BUILD__';
const CACHE = 'maraton-' + VERSION;
const SHELL = ['/', 'route.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/clax/') || url.pathname.startsWith('/api/')) return;
  const key = url.pathname === '/index.html' ? '/' : url.pathname === '/' ? '/' : e.request;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }))
  );
});
