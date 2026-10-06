/* AfnoKamai service worker — cache-first for static assets,
   network-first for pages, plus real Web Push delivery.

   The push handlers below are what make notifications arrive while the
   site is closed. They only ever *display*; the subscription document is
   owned by the page (js/push.js) because Firestore auth does not exist
   inside a service worker. */
const CACHE = 'afnokamai-v8';
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

/* ─── Web Push ───────────────────────────────────────────────────────
   These handlers are the reason a notification reaches the device while
   the site is closed. The page cannot do any of this — when every tab is
   gone, only the service worker is still alive.

   Hard requirement: because the subscription is created with
   `userVisibleOnly: true`, the browser expects a visible notification for
   every push we receive. Failing to show one is treated as a violation.
   So every branch here ends in showNotification(), including the
   malformed-payload branch. */

const ICON = '/assets/icon-512.png';

/* Public half of the VAPID keypair. This is NOT a secret — it is the same
   value as VAPID_PUBLIC_KEY in js/firebase-config.js. It is duplicated
   here because the worker is registered as a classic script (not a
   module), so it cannot import from js/. If you rotate the keypair,
   change BOTH places. */
const VAPID_PUBLIC_KEY =
  'BAlZc5BOauiuRe1C5-KGq7162RG7W1qtSxxiov7IHXk6CO1dLUY2EoKHpWWEP24OdBS8M6QU4UToWajz7z6qA-U';

function base64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json() || {};
    } catch (_) {
      // A non-JSON body is still something the sender meant to show, so
      // fall back to treating the whole body as the message text.
      payload = { body: event.data.text() };
    }
  }

  const title = String(payload.title || 'AfnoKamai').slice(0, 140);
  const body = String(payload.body || 'You have a new notification.').slice(0, 600);

  const options = {
    body,
    icon: typeof payload.icon === 'string' && payload.icon ? payload.icon : ICON,
    badge: ICON,
    // tag = the notification id, so distinct events never silently replace
    // one another (a rejected task must not overwrite an approved one).
    tag: typeof payload.notificationId === 'string' && payload.notificationId
      ? payload.notificationId
      : undefined,
    // Urgent alerts stay on screen until dismissed rather than sliding
    // into the notification shade after a few seconds.
    requireInteraction: payload.priority === 'urgent',
    data: {
      url: typeof payload.url === 'string' ? payload.url : '/notifications.html',
      notificationId: typeof payload.notificationId === 'string' ? payload.notificationId : '',
      category: typeof payload.category === 'string' ? payload.category : 'system'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = (event.notification.data && event.notification.data.url) || '/notifications.html';

  // The URL arrives from a push payload. Never navigate off-origin: a
  // compromised or misconfigured sender must not be able to bounce a user
  // to a phishing page by clicking our own notification.
  let target;
  try {
    target = new URL(rawUrl, self.location.origin);
    if (target.origin !== self.location.origin) {
      target = new URL('/notifications.html', self.location.origin);
    }
  } catch (_) {
    target = new URL('/notifications.html', self.location.origin);
  }

  event.waitUntil((async () => {
    const wanted = target.pathname;

    // 1. A window already sitting on the destination: just focus it.
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      try {
        if (new URL(client.url).pathname === wanted && 'focus' in client) {
          await client.focus();
          return;
        }
      } catch (_) { /* unparseable url — keep looking */ }
    }

    // 2. Some other window is open: focus it and ask the app to navigate.
    //    A window cannot be navigated from here directly, so the page must
    //    honour this message (registered in js/shell.js).
    for (const client of open) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'notification:navigate', url: target.pathname + target.search });
        return;
      }
    }

    // 3. Nothing open: start a new session at the destination.
    await self.clients.openWindow(target.pathname + target.search);
  })());
});

/* The browser can retire or rotate a subscription on its own — an OS
   update, a storage wipe, or the push service reissuing the endpoint. When
   that happens we re-subscribe immediately so the device keeps receiving
   alerts instead of silently going dark.

   The new endpoint only reaches Firestore on the page's next
   autoSyncIfGranted(); until then the stale record is addressed and the
   sender's 410 handling retires it. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const reg = await self.registration;
      await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    } catch (_) {
      // Nothing useful to do here — the page re-subscribes on next load.
    }
  })());
});
