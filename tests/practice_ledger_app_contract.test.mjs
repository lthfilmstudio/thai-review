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

const cardSource = await readFile(new URL('../src/card.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../styles/components.css', import.meta.url), 'utf8');

test('Today 走 controller，其他課程維持 legacy 同步路徑（R1）', () => {
  const start = appSource.indexOf('function gradeAndAdvance(');
  const end = appSource.indexOf('function prevCard(', start);
  const block = appSource.slice(start, end);

  assert.match(block, /ledgerGradeEligible\(practiceLedger, state\.currentLessonId\)/);
  assert.match(block, /ledgerSession\.controller\.submitGrade\(g\)/);
  // legacy 那條原本的三個寫入一個都不能少
  assert.match(block, /setGrade\(state\.cardIndex, g, runtimeStorage\)/);
  assert.match(block, /recordGrade\(gradedCardKey, g/);
  assert.match(block, /logReview\(g, Date\.now\(\), runtimeStorage\)/);
});

test('KTD11：ledger 路徑鏡射交易算好的 after-state，不自己重算', () => {
  const start = appSource.indexOf('advance: result => {');
  const end = appSource.indexOf('onStateChange:', start);
  const block = appSource.slice(start, end);

  assert.match(block, /setGradeFromLedger\(card, result\.srs, storage\)/);
  assert.doesNotMatch(block, /setGrade\(/, 'setGrade 會再算一次 nextReview');
  assert.doesNotMatch(block, /nextReview\(/);
  assert.doesNotMatch(block, /logReview\(/, 'daily 由投影鏡射負責，不能再累加一次');
  assert.doesNotMatch(block, /recordGrade\(/, 'history 同理');
});

test('AE7：滑鼠與鍵盤共用同一道 saving 鎖，鍵盤那道排在方向鍵之前', () => {
  assert.match(appSource, /if \(ledgerSession\?\.controller\.isLocked\(\)\) \{ e\.stopPropagation\(\); return; \}/);
  // retry 按鈕本身不能被那道鎖擋掉，否則失敗後就出不去了
  const clickStart = appSource.indexOf("if (e.target.closest('[data-ledger-retry]'))");
  const clickLock = appSource.indexOf('if (ledgerSession?.controller.isLocked()) { e.stopPropagation(); return; }');
  assert.ok(clickStart > 0 && clickStart < clickLock, 'retry 要排在鎖前面');

  // 方向鍵也是 context mutation：換了卡片，交易回來就會因為 token 對不上被丟掉。
  const keyLock = appSource.indexOf('if (ledgerSession?.controller.isLocked()) return;\n\n    if (e.key === \'ArrowLeft\')');
  assert.ok(keyLock > 0, '鍵盤的鎖要緊接在方向鍵之前');
});

test('AE7：換課與換 mode 也擋在同一道鎖後面', () => {
  for (const fn of ['async function selectLesson(id, storage) {', 'async function selectMode(m, storage) {']) {
    const start = appSource.indexOf(fn);
    assert.ok(start > 0, `${fn} 應該存在`);
    const head = appSource.slice(start, start + 400);
    assert.match(head, /if \(ledgerSession\?\.controller\.isLocked\(\)\) return;/,
      `${fn} 缺少 saving 守門`);
  }
});

test('帳本收不下的評分要退回 legacy，不能靜默吞掉', () => {
  const start = appSource.indexOf('function gradeAndAdvance(');
  const end = appSource.indexOf('function legacyGradeAndAdvance(', start);
  const block = appSource.slice(start, end);
  assert.match(block, /LEDGER_FALLBACK_STATUSES\.has\(result\?\.status\)/);
  assert.match(block, /legacyGradeAndAdvance\(g, storage\)/);
  assert.match(appSource, /LEDGER_FALLBACK_STATUSES = Object\.freeze\(new Set\(\['context-invalid', 'not-eligible'\]\)\)/);
});

test('P0-3：重置要先清 IDB 權威 SRS 再清本機鏡射', () => {
  const start = appSource.indexOf('await resetProgressEverywhere(storage);');
  const end = appSource.indexOf('closeResetModal();', start);
  const block = appSource.slice(start, end);
  assert.match(block, /resetRuntimeLedgerAuthority\(\{/, '重置必須真的清 IDB');
  const idbReset = block.indexOf('resetRuntimeLedgerAuthority');
  const localReset = block.indexOf('state.progress = {};');
  assert.ok(idbReset > 0 && idbReset < localReset, 'IDB 要清在本機鏡射之前');
  assert.match(block, /return;/, '清 IDB 失敗要中止，不能只清一半');
});

test('失敗狀態一定給得出下一步，而且是可讀的 a11y 區域', () => {
  assert.match(cardSource, /data-ledger-status/);
  assert.match(cardSource, /role="status"/);
  assert.match(cardSource, /aria-live="polite"/);
  assert.match(appSource, /'save-failed': \{ text: '[^']+', action: '[^']+' \}/);
  assert.match(appSource, /'projection-repair': \{ text: '[^']+', action: '[^']+' \}/);
  assert.match(appSource, /action\.focus\(\)/, '鍵盤使用者不用自己找出路');
  // repair 只重跑鏡射，絕不重送交易
  const retryStart = appSource.indexOf('async function retryLedgerAction()');
  const retryEnd = appSource.indexOf('\n}', retryStart);
  const block = appSource.slice(retryStart, retryEnd);
  assert.match(block, /controller\.retry\(\)/);
  assert.match(block, /controller\.repairProjection\(\)/);
  assert.doesNotMatch(block, /submitGrade/);
});

test('狀態列在窄螢幕與淺色主題下都有樣式', () => {
  assert.match(cssSource, /\.ledger-status \{/);
  assert.match(cssSource, /\.ledger-status\[data-state='save-failed'\]/);
  assert.match(cssSource, /@media \(max-width: 360px\)[\s\S]*\.ledger-status/);
  // 只用既有 token，不寫死顏色
  const start = cssSource.indexOf('/* ===== Ledger 評分狀態');
  const block = cssSource.slice(start);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b/, '顏色要走 theme token');
});
