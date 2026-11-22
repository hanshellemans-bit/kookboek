// Network-first service worker: always fresh when online, app shell cached for offline use.
const CACHE = 'kookboek-shell-v4';
const SHELL = ['./', 'index.html', 'app.js', 'home.js', 'dnd.js', 'importer.js', 'util.js', 'leftovers.js', 'chef.js', 'season.js', 'zip.js', 'icons.js', 'shop.js', 'shopui.js', 'syncCore.js', 'backup.js', 'drive.js', 'sync.js', 'settings.js', 'config.js', 'db.js', 'style.css', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && SHELL.some(s => url.pathname.endsWith(s === './' ? '/' : s))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
