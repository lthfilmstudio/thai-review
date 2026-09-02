import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* 跟 legacy_claim_app_contract.test.mjs 同一個路數：app.js 是 DOM 耦合的入口，
   沒辦法直接跑行為測試，就把「接在哪、順序對不對、有沒有接錯東西」釘住。 */
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const swSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

test('ledger runtime 接在 boot ready 之後、任何主畫面 render 之前', () => {
  const readyGate = appSource.indexOf("if (bootResult.status !== 'ready')");
  const start = appSource.indexOf('practiceLedger = await startPracticeLedgerRuntime({');
  const settle = appSource.indexOf('settleStreakOnOpen(');
  const deepLink = appSource.indexOf('const deepLink = parseDeepLinkParam();');

  assert.ok(readyGate > 0 && start > readyGate, 'boot 沒 ready 就不該叫 ledger 起來');
  assert.ok(start > settle, 'streak 結算要先跑完，鏡射才不會被結算蓋掉');
  assert.ok(deepLink > start, '鏡射要在挑卡片、render 之前完成');
});

test('ledger runtime 拿到的是這次 boot 的 workspace、catalog 與 hydration 投影', () => {
  const start = appSource.indexOf('practiceLedger = await startPracticeLedgerRuntime({');
  const end = appSource.indexOf('const deepLink = parseDeepLinkParam();', start);
  const block = appSource.slice(start, end);

  assert.match(block, /connection: practiceConnection/);
  assert.match(block, /workspaceId: bootResult\.workspaceId/);
  assert.match(block, /catalog: bootResult\.catalog/);
  assert.match(block, /projections: bootResult\.hydration\?\.snapshot\?\.projections/);
  assert.match(block, /legacyProgress: state\.progress/);
  // 之前踩過：拿舊的 workspace handle 會把別的帳號的資料寫進來。
  assert.match(block, /assertActive:/);
  assert.match(block, /WORKSPACE_INVALIDATED/);
});

test('lineage evidence 只從有 SHA-256 綁定的那支拿，不自己 fetch', () => {
  const start = appSource.indexOf('practiceLedger = await startPracticeLedgerRuntime({');
  const end = appSource.indexOf('const deepLink = parseDeepLinkParam();', start);
  const block = appSource.slice(start, end);

  assert.match(block, /fetchProductionLineageEvidence\(\)/);
  assert.match(block, /trustedRevisionManifest: TRUSTED_PRODUCTION_LINEAGE/);
  assert.doesNotMatch(block, /card-id-lineage\.json/,
    '自己 fetch 就繞過了 evidence 的 digest 驗證');
});

test('ledger 起不來不擋開機：整段沒有 throw、沒有 boot 狀態轉移', () => {
  const start = appSource.indexOf('practiceLedger = await startPracticeLedgerRuntime({');
  const end = appSource.indexOf('const deepLink = parseDeepLinkParam();', start);
  const block = appSource.slice(start, end);

  // 唯一那個 throw 是 assertActive 的 workspace 守衛，會被 startPracticeLedgerRuntime
  // 自己的 try/catch 收掉變成 status: 'unavailable'，不會往開機路徑上冒。
  const throws = block.match(/\bthrow\b/g) || [];
  assert.equal(throws.length, 1);
  assert.match(block, /throw Object\.assign\(new Error\('practice ledger workspace is stale'\)/);
  assert.doesNotMatch(block, /moveTo\(\s*'recoverable-failure'/);
  assert.doesNotMatch(block, /renderWorkspaceBoot/);
  assert.doesNotMatch(block, /return;/, 'ledger 失敗不得中斷 init');
});

test('新的 runtime 模組進了 Service Worker 的 offline shell', () => {
  // app.js 靜態 import 了它們，沒進 SHELL 的話離線開會直接掛。
  assert.match(appSource, /from '\.\/practice-ledger-runtime\.js'/);
  assert.ok(swSource.includes("'./src/practice-ledger-runtime.js'"));
  assert.ok(swSource.includes("'./src/ledger-mirror.js'"));
});
