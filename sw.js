/* Service Worker：app shell cache + runtime CSV cache。
   改檔後升 CACHE 版本號強制更新。 */

const CACHE = 'thai-review-v96';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/base.css',
  './styles/layout.css',
  './styles/components.css',
  './src/app.js',
  './src/state.js',
  './src/storage-scope.js',
  './src/card-identity.js',
  './src/practice-db.js',
  './src/ledger-mirror.js',
  './src/practice-ledger-runtime.js',
  './src/legacy-claim-flow.js',
  './src/remote-workspace-probe.js',
  './src/production-lineage-trust.js',
  './src/data.js',
  './src/tts-prompts.js',
  './src/tts.js',
  './src/audio-stretch.js',
  './src/vendor/soundtouch.js',
  './src/vendor/supabase-auth.js',
  './src/cloud-auth.js',
  './src/cloud-merge.js',
  './src/cloud-sync.js',
  './src/listen-lock.js',
  './src/listen-static.js',
  './src/zh-sprite.js',
  './src/real-audio.js',
  './src/sentence.js',
  './src/dialog.js',
  './src/card.js',
  './src/listen.js',
  './src/srs.js',
  './src/resweep.js',
  './src/progress-sync.js',
  './src/today.js',
  './src/home.js',
  './src/game-listen.js',
  './src/game-combo.js',
  './src/game-dialogue.js',
  './src/grade-history.js',
  './src/achievements.js',
  './src/stats.js',
  './src/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  // GitHub Action 每 30 分鐘重生 data.json，這邊 cache 同源讓離線可用；
  // fetch 端會帶 ?_=ts cache buster 從 network 拿最新版（network-first 在 fetch handler 裡）
  './data.json',
  './data/card-id-lineage.json',
];

/* cache.add() 只看狀態碼，200 text/html 也照收，install 當下就會把 SPA fallback
   或 Access 登入頁寫進 JSON 的 cache key。改成自己 fetch 再過型別檢查：型別不對
   就不寫（離線時該路徑拿不到東西，呼叫端會走各自的 fail-closed 分支），但不讓整個
   install 失敗——那會連 offline shell 都沒有，比缺一個檔更糟。 */
async function precache(cache, url) {
  const request = new Request(url, { cache: 'reload' });
  const response = await fetch(request);
  if (!response.ok) throw new Error(`precache failed ${url} (${response.status})`);
  if (cacheableJsonResponse(request, response)) await cache.put(request, response);
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(url => precache(c, url))))
      .then(() => self.skipWaiting())
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

  // Google Sheets：network-first（線上一律抓最新，離線才 fallback cache）
  if (url.hostname.includes('docs.google.com') ||
      url.hostname.includes('googleusercontent.com')) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // 字型：stale-while-revalidate（內容幾乎不變，可放心 cache）
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // 同源可變資料與音訊索引：network-first
  // （data.json 每 30 分鐘更新；prompt / audio manifest 會隨新音檔更新；
  //   zh-manifest 重烤 sprite 後要拿最新；deploy-info 每次部署更新；
  //   MP3 / sprite 本體檔名帶 hash，繼續走 cache-first）
  if (url.origin === location.origin &&
      (url.pathname.endsWith('/data.json') ||
       url.pathname.endsWith('/data/card-id-lineage.json') ||
       url.pathname.endsWith('/src/tts-prompts.js') ||
       url.pathname.endsWith('/audio-manifest.json') ||
       url.pathname.endsWith('/zh-manifest.json') ||
       url.pathname.endsWith('/deploy-info.json'))) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // 同源：cache-first
  if (url.origin === location.origin) {
    e.respondWith(cacheFirst(e.request));
  }
});

/* SPA fallback 與 Cloudflare Access 的登入頁都是 200 text/html。只看 res.ok 會把
   HTML 存進 JSON 的 cache key，之後離線開機拿到那份 HTML 就再也解不開。 */
function cacheableJsonResponse(req, res) {
  if (!res.ok) return false;
  if (!new URL(req.url).pathname.endsWith('.json')) return true;
  return (res.headers.get('content-type') || '').toLowerCase().includes('json');
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (cacheableJsonResponse(req, res)) {
      cache.put(req, res.clone());
      return res;
    }
    // 型別不對就不污染 cache；有舊的正確版本先用舊的，沒有才把原樣回去讓呼叫端報錯。
    return (res.ok && await cache.match(req)) || res;
  } catch (e) {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}

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
