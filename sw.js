/* Service Worker：app shell cache + runtime CSV cache。
   改檔後升 CACHE 版本號強制更新。 */

const CACHE = 'thai-review-v15';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/base.css',
  './styles/layout.css',
  './styles/components.css',
  './src/app.js',
  './src/state.js',
  './src/data.js',
  './src/tts.js',
  './src/card.js',
  './src/listen.js',
  './src/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 非 GET 不處理
  if (e.request.method !== 'GET') return;

  // Google Sheets / Fonts：stale-while-revalidate
  if (url.hostname.includes('docs.google.com') ||
      url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // 同源：cache-first
  if (url.origin === location.origin) {
    e.respondWith(cacheFirst(e.request));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}
