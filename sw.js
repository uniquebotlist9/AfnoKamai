/* AfnoKamai minimal service worker — cache-first for static assets,
   network-first for pages. Kept deliberately simple; the app is
   online-first because it is a real-money platform. */
const CACHE = 'afnokamai-v7';
const ASSETS = [
  'assets/icon.svg',
  'css/global.css?v=3',
  'css/auth.css',
  'css/app.css?v=3',
  'css/chat.css?v=2',
  'css/admin.css'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Never cache an error response — a cached 500/404 would survive the
  // outage and keep serving bad HTML/JS after the server recovered.
  const putIfOk = (cache, res) => { if (res && res.ok && res.type === 'basic') cache.put(e.request, res.clone()); };

  // Pages: network first, fall back to cache.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => putIfOk(c, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // JS: network first — stale code on a money platform is worse than a
  // slow load. Falls back to cache only when offline.
  if (url.pathname.endsWith('.js')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => putIfOk(c, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Other static assets (css/images): cache first.
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => putIfOk(c, clone));
          return res;
        })
    )
  );
});
