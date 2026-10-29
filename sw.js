const CACHE_NAME = 'kidhar-v5';
const SHELL_FILES = [
  '/index.html',
  '/signup.html',
  '/privacy.html',
  '/css/style.css',
  '/js/config.js',
  '/js/pluscode.js',
  '/js/auth.js',
  '/js/setup.js',
  '/js/app.js',
  '/js/checkin.js',
  '/js/admin.js',
  '/js/settings.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (event.request.mode === 'navigate') {
    let cleanPath = url.pathname.replace(/\.html$/, '');
    if (cleanPath === '/index' || cleanPath === '') cleanPath = '/';
    event.respondWith(
      fetch(cleanPath + url.search, { redirect: 'follow' }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: '📍 Kidhar', body: 'Time to check in.' };
  try { if (event.data) data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      vibrate: [200, 100, 200],
      tag: 'kidhar-reminder',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/index.html');
    })
  );
});
