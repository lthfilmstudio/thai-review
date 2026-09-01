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
    Response,
    Promise,
    console,
  };
  const exported = runInNewContext(
    `${sw}\n;({ networkFirst, cacheableJsonResponse })`,
    context,
  );
  return { ...exported, puts };
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

test('service worker cache version invalidates the stale v93 bundle', () => {
  assert.ok(sw.includes("const CACHE = 'thai-review-v94';"));
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
