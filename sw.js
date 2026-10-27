/* Offline cache so the installed web app keeps working without a connection. */
const CACHE = 'pmm-coach-v5';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'llm.js', 'llm-worker.js', 'pmm-index.js', 'manifest.webmanifest',
  'img/welcome.png', 'img/listening.png', 'img/thinking.png', 'img/explaining.png', 'img/success.png', 'img/encourage.png',
  'img/hill-logo.png', 'img/icon-192.png', 'img/apple-touch-icon.png', 'img/qr.png', 'img/icon-512.png', 'img/favicon.png',
  'fonts/public-sans-latin-400-normal.woff2', 'fonts/public-sans-latin-500-normal.woff2', 'fonts/public-sans-latin-600-normal.woff2',
  'fonts/public-sans-latin-700-normal.woff2', 'fonts/public-sans-latin-400-italic.woff2', 'fonts/public-sans-latin-700-italic.woff2'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;   // model downloads are cached by the AI runtime itself
  if (/pmm-index\.enc$/.test(e.request.url)) { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); return; }   // always the latest manual
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match('index.html'))));
});
