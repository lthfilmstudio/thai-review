import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const root = fileURLToPath(new URL('../', import.meta.url));

/* sw.js 是 classic worker script，沒有 export；在 vm 裡補上 self/caches/fetch 之後
   直接把要驗的函式取出來實跑，比對原始碼字串更能證明行為。 */
function loadServiceWorker({ fetchImpl, cacheEntries = new Map() }) {
  const puts = [];
  const cache = {
    async match(req) { return cacheEntries.get(typeof req === 'string' ? req : req.url) || undefined; },
    async put(req, res) { puts.push({ url: typeof req === 'string' ? req : req.url, res }); },
    async add() {},
  };
  const context = {
    self: { addEventListener() {}, skipWaiting() {}, clients: { claim() {} } },
    caches: { async open() { return cache; }, async match(req) { return cache.match(req); }, async keys() { return []; } },
    fetch: fetchImpl,
    location: { origin: 'https://thai-review.test' },
    URL,
    Request,
    Response,
    Promise,
    console,
  };
  const exported = runInNewContext(
    `${sw}\n;({ networkFirst, cacheableTypedResponse, precache })`,
    context,
  );
  return { ...exported, puts, cache };
}

function jsonRequest(path = '/data/card-id-lineage.json') {
  return { url: `https://thai-review.test${path}`, method: 'GET' };
}

function stubResponse(body, contentType, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body,
    clone() { return this; },
  };
}

async function staticModuleGraph(entry) {
  const visited = new Set();
  async function visit(filePath) {
    const modulePath = relative(root, filePath).split(sep).join('/');
    if (visited.has(modulePath)) return;
    visited.add(modulePath);
    const source = await readFile(filePath, 'utf8');
    const imports = [
      ...source.matchAll(
        /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+\.js)['"]/g,
      ),
      ...source.matchAll(/import\s*\(\s*['"](\.[^'"]+\.js)['"]\s*\)/g),
    ];
    for (const match of imports) {
      await visit(resolve(dirname(filePath), match[1]));
    }
  }
  await visit(entry);
  return visited;
}

test('service worker fetches mutable deployment metadata network-first', () => {
  const networkFirstBlock = [
    "url.pathname.endsWith('/data.json')",
    "url.pathname.endsWith('/zh-manifest.json')",
    "url.pathname.endsWith('/deploy-info.json')",
    'e.respondWith(networkFirst(e.request));',
  ];

  for (const needle of networkFirstBlock) {
    assert.ok(sw.includes(needle), `missing ${needle}`);
  }

  const manifestRule = sw.indexOf("url.pathname.endsWith('/deploy-info.json')");
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');
  assert.ok(manifestRule > 0, 'deploy info rule should exist');
  assert.ok(cacheFirstRule > manifestRule, 'mutable metadata must be handled before same-origin cache-first');
});

test('service worker refreshes mutable Thai audio indexes before using cache', () => {
  const mutableAudioIndexes = [
    "url.pathname.endsWith('/src/tts-prompts.js')",
    "url.pathname.endsWith('/audio-manifest.json')",
  ];
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');

  for (const needle of mutableAudioIndexes) {
    const rule = sw.indexOf(needle);
    assert.ok(rule > 0, `missing ${needle}`);
    assert.ok(cacheFirstRule > rule, `${needle} must be handled before same-origin cache-first`);
  }
});

test('service worker cache version invalidates the stale v97 bundle', () => {
  assert.ok(sw.includes("const CACHE = 'thai-review-v98';"));
  assert.ok(sw.includes("'./src/practice-grade-session.js'"),
    'ledger grade session must be available in the offline shell');
  assert.ok(sw.includes("'./src/practice-commit.js'"),
    'practice commit coordinator must be available in the offline shell');
  assert.ok(sw.includes("'./src/ledger-mirror.js'"),
    'ledger mirror must be available in the offline shell');
  assert.ok(sw.includes("'./src/practice-ledger-runtime.js'"),
    'practice ledger boot must be available in the offline shell');
  assert.ok(sw.includes("'./src/storage-scope.js'"),
    'app boot dependency must be available in the offline shell');
  assert.ok(sw.includes("'./src/practice-db.js'"),
    'workspace hydration dependency must be available in the offline shell');
  assert.ok(sw.includes("'./src/legacy-claim-flow.js'"),
    'legacy claim controller must be available in the offline shell');
  assert.ok(sw.includes("'./src/remote-workspace-probe.js'"),
    'legacy claim remote probe must be available in the offline shell');
  assert.ok(sw.includes("'./src/production-lineage-trust.js'"),
    'legacy claim trust manifest must be available in the offline shell');
  assert.ok(sw.includes("'./src/card-identity.js'"),
    'card identity dependency must be available in the offline shell');
  assert.ok(sw.includes("'./data/card-id-lineage.json'"),
    'legacy claim evidence must be available in the offline shell');
});

test('service worker precaches the complete static app import graph', async () => {
  const modules = await staticModuleGraph(resolve(root, 'src/app.js'));
  for (const modulePath of modules) {
    assert.ok(
      sw.includes(`'./${modulePath}'`),
      `${modulePath} must be available in the offline shell`,
    );
  }
});

test('service worker refreshes production lineage evidence before using cache', () => {
  const lineageRule = sw.indexOf("url.pathname.endsWith('/data/card-id-lineage.json')");
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');
  assert.ok(lineageRule > 0, 'production lineage evidence needs an explicit rule');
  assert.ok(cacheFirstRule > lineageRule,
    'production lineage evidence must be handled before same-origin cache-first');
});

test('networkFirst 不把 200 text/html 存進 JSON 的 cache key', async () => {
  const req = jsonRequest();
  const html = stubResponse('<!DOCTYPE html>', 'text/html; charset=utf-8');
  const sw1 = loadServiceWorker({ fetchImpl: async () => html });

  const res = await sw1.networkFirst(req);

  assert.equal(sw1.puts.length, 0, 'SPA fallback 不可以進 cache');
  assert.equal(res, html, '沒有舊快取時原樣回傳，讓呼叫端自己報錯');
});

test('networkFirst 拿到 interstitial 時優先回舊的正確快取', async () => {
  const req = jsonRequest();
  const cached = stubResponse('{"kind":"production-lineage-evidence-v2"}', 'application/json');
  const sw1 = loadServiceWorker({
    fetchImpl: async () => stubResponse('<!DOCTYPE html>', 'text/html'),
    cacheEntries: new Map([[req.url, cached]]),
  });

  const res = await sw1.networkFirst(req);

  assert.equal(res, cached);
  assert.equal(sw1.puts.length, 0);
});

test('networkFirst 正常 JSON 照樣寫進 cache', async () => {
  const req = jsonRequest();
  const json = stubResponse('{"kind":"production-lineage-evidence-v2"}', 'application/json');
  const sw1 = loadServiceWorker({ fetchImpl: async () => json });

  const res = await sw1.networkFirst(req);

  assert.equal(res, json);
  assert.deepEqual(sw1.puts.map(entry => entry.url), [req.url]);
});

/* 之前 data/card-id-lineage.json 進了 SHELL 卻沒進部署清單，Pages 回 SPA fallback 的
   200 text/html，已登入又有 legacy 資料的使用者開機直接卡在 recoverable-failure。 */
test('every offline shell entry is staged by the deploy script', async () => {
  const deployScript = await readFile(new URL('../scripts/update-audio-deploy.sh', import.meta.url), 'utf8');
  const copyList = deployScript.match(/for item in ([^;]+); do/);
  assert.ok(copyList, 'ensure_preview_shell copy list should be readable');
  const staged = new Set(copyList[1].trim().split(/\s+/));

  const shellBlock = sw.match(/const SHELL = \[(.*?)\];/s);
  assert.ok(shellBlock, 'SHELL array should be readable');
  const shellPaths = [...shellBlock[1].matchAll(/'\.\/([^']+)'/g)].map(match => match[1]);
  assert.ok(shellPaths.length > 0, 'SHELL should list precached paths');

  for (const shellPath of shellPaths) {
    const topLevel = shellPath.split('/')[0];
    assert.ok(
      staged.has(topLevel),
      `${shellPath} is precached but "${topLevel}" is not staged for deploy`,
    );
  }
});

/* install 的 cache.add() 只看狀態碼，200 text/html 也照收——檔案哪天又漏部署，
   開機當下就把 SPA fallback 寫進 JSON 的 cache key。 */
test('precache 不把 200 text/html 寫進 JSON 的 cache key，但也不讓整個 install 掛掉', async () => {
  const sw1 = loadServiceWorker({
    fetchImpl: async () => stubResponse('<!DOCTYPE html>', 'text/html; charset=utf-8'),
  });

  await sw1.precache(await sw1Cache(sw1), 'https://thai-review.test/data/card-id-lineage.json');

  assert.equal(sw1.puts.length, 0, '型別不對不可以進 cache');
});

test('precache 照常快取正常 JSON 與一般靜態資源', async () => {
  const jsonSw = loadServiceWorker({
    fetchImpl: async () => stubResponse('{"kind":"x"}', 'application/json'),
  });
  await jsonSw.precache(await sw1Cache(jsonSw), 'https://thai-review.test/data/card-id-lineage.json');
  assert.equal(jsonSw.puts.length, 1);

  const htmlSw = loadServiceWorker({
    fetchImpl: async () => stubResponse('<!DOCTYPE html>', 'text/html'),
  });
  await htmlSw.precache(await sw1Cache(htmlSw), 'https://thai-review.test/index.html');
  assert.equal(htmlSw.puts.length, 1, 'HTML 資源本來就該是 HTML，照收');
});

test('install 真的走 precache，而不是繞回 cache.add', () => {
  const install = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('activate'"));
  assert.match(install, /precache\(/, 'install 必須經過型別檢查那條路徑');
  assert.doesNotMatch(install, /\.add\(/, 'cache.add() 會把 200 text/html 照收');
});

test('precache 對非 2xx 仍然丟錯（維持原本 cache.add 的失敗語意）', async () => {
  const sw1 = loadServiceWorker({
    fetchImpl: async () => stubResponse('', 'text/plain', 404),
  });
  await assert.rejects(sw1.precache(await sw1Cache(sw1), 'https://thai-review.test/index.html'), /precache failed/);
});

async function sw1Cache(sw1) {
  // loadServiceWorker 的 caches.open() 一律回同一個 cache 物件
  return sw1.cache;
}

/* R15：JS／CSS 被 200 text/html 冒充比 JSON 更糟——JSON 只是 parse 失敗，
   module 載入拿到 HTML 是直接炸掉，整個 App 起不來。 */
test('precache 對 JS／CSS 同樣拒收 200 text/html', () => {
  const { cacheableTypedResponse } = loadServiceWorker({ fetchImpl: async () => stubResponse('x', 'text/plain') });
  const html = stubResponse('<!DOCTYPE html>', 'text/html; charset=utf-8');

  for (const path of ['/src/app.js', '/src/practice-commit.js', '/styles/components.css',
    '/manifest.webmanifest', '/data.json']) {
    assert.equal(cacheableTypedResponse(jsonRequest(path), html), false, `${path} 不該收下 HTML`);
  }
});

test('正確 content-type 的靜態資源照收；缺 content-type 一律不收', () => {
  const { cacheableTypedResponse } = loadServiceWorker({ fetchImpl: async () => stubResponse('x', 'text/plain') });
  const ok = [
    ['/src/app.js', 'text/javascript; charset=utf-8'],
    ['/styles/components.css', 'text/css'],
    ['/data.json', 'application/json'],
  ];
  for (const [path, type] of ok) {
    assert.equal(cacheableTypedResponse(jsonRequest(path), stubResponse('x', type)), true, `${path} 應該收`);
  }
  // Pages 對真的靜態檔一定帶 content-type；帶不出來的多半是 fallback 或錯誤頁
  assert.equal(cacheableTypedResponse(jsonRequest('/src/app.js'), stubResponse('x', null)), false);
  // 沒有副檔名的路徑（例如 SPA 導覽）維持原本行為
  assert.equal(cacheableTypedResponse(jsonRequest('/today'), stubResponse('<html>', 'text/html')), true);
});

/* 部署後的 read-back 是「線上跑的等於本機驗過的那份」的唯一證據。SHELL 加了 ledger
   相關模組卻忘記加進 read-back，就會出現「測試全綠、線上跑舊版、沒人發現」。 */
test('ledger 相關的離線模組全部納入部署 read-back', async () => {
  const deployScript = await readFile(new URL('../scripts/update-audio-deploy.sh', import.meta.url), 'utf8');
  const listBlock = deployScript.match(/RUNTIME_READBACK_ASSETS=\(([\s\S]*?)\n\)/);
  assert.ok(listBlock, 'RUNTIME_READBACK_ASSETS should be readable');
  const readback = new Set([...listBlock[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));

  const shellBlock = sw.match(/const SHELL = \[(.*?)\];/s);
  const shellPaths = [...shellBlock[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  // 決定 ledger 正確性的那些模組；其餘（tts、遊戲、聽力）不必逐一 read-back。
  const ledgerOwned = /^src\/(practice-|ledger-|storage-scope|legacy-claim-flow|production-lineage-trust|card-identity)/;

  for (const shellPath of shellPaths.filter(p => ledgerOwned.test(p))) {
    assert.ok(readback.has(shellPath), `${shellPath} 在 SHELL 裡但沒進部署 read-back`);
  }
  assert.ok(readback.has('data/card-id-lineage.json'), 'lineage 檔本身也要 read-back');
  assert.ok(readback.has('sw.js'));
});

test('read-back 清單裡的每個路徑在 repo 裡都存在', async () => {
  const { access } = await import('node:fs/promises');
  const deployScript = await readFile(new URL('../scripts/update-audio-deploy.sh', import.meta.url), 'utf8');
  const listBlock = deployScript.match(/RUNTIME_READBACK_ASSETS=\(([\s\S]*?)\n\)/);
  const readback = [...listBlock[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

  for (const rel of readback) {
    // data.json 等產物由 build 步驟生出來，只驗版控裡有的那些
    if (rel.endsWith('-manifest.json') || rel === 'data.json') continue;
    await access(new URL(`../${rel}`, import.meta.url));
  }
});
