// Guarda la app y los últimos datos para abrirla sin conexión.
const CACHE = 'mi-garmin-v3';
const SHELL = ['/', 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', '/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.pathname === '/login' || u.pathname === '/logout') return;
  // Red primero; si no hay conexión, lo último guardado
  e.respondWith(fetch(r).then(res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r)));
});
// Recordatorio diario: lo envía el servidor; al tocarlo se abre la pestaña Registro
self.addEventListener('push', e => {
  let m = {}; try { m = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(m.title || 'Mi Garmin', {
    body: m.body || 'Rellena el registro de hoy.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'registro', data: { url: m.url || '/#registro' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/#registro';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs[0];
    return c ? c.focus().then(() => c.navigate(url)).catch(() => {}) : self.clients.openWindow(url);
  }));
});
