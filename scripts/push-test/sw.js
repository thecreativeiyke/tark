// Tark push test service worker (development harness).
// The backend sends JSON: { title, body, icon, badge, data: { url, ... } }.
// This worker turns that into a visible notification and handles clicks.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Tark', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Tark';
  const options = {
    body: payload.body || '',
    icon: payload.icon,   // relative paths resolve against THIS origin (localhost:5173)
    badge: payload.badge,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
