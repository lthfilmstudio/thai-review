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

  /* 這裡只准有 assertActive 的 workspace 守衛：一個給 ledger runtime 的 port，
     一個給重置專用的 port。兩個都在 callback 裡，開機路徑上不會被呼叫到。 */
  const throws = block.match(/\bthrow\b/g) || [];
  assert.equal(throws.length, 2);
  assert.match(block, /throw Object\.assign\(new Error\('practice ledger workspace is stale'\)/);
  assert.match(block, /throw Object\.assign\(new Error\('practice reset workspace is stale'\)/);
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

  // 鍵盤那道現在蓋住整個 handler（含 listen mode 與 / 開搜尋），
  // 順序由「搜尋的兩條進入點都擋得住」那條測試釘死。
});

test('AE7：click 的鎖排在所有會動 context 的 handler 之前', () => {
  const handler = appSource.indexOf("document.getElementById('content').addEventListener('click'");
  assert.ok(handler > 0);
  const lock = appSource.indexOf(
    'if (ledgerSession?.controller.isLocked()) { e.stopPropagation(); return; }', handler,
  );
  assert.ok(lock > handler, 'click handler 裡要有鎖');
  // 排在鎖後面才算被擋住。這幾個都會換卡或換 mode，排錯邊等於沒鎖。
  for (const selector of [
    '[data-jump-card]', '[data-mode-back-to-card]', '[data-lesson-map-jump]',
    '[data-start-review]', '[data-edit-card-key]', '#cardPrev', '#cardNext',
  ]) {
    const at = appSource.indexOf(selector, handler);
    assert.ok(at > lock, `${selector} 必須排在 saving 鎖後面`);
  }
});

/* 這條取代「逐一列 selector 比對字串位置」的寫法。舊寫法只能證明「這幾個特定
   selector 排在鎖後面」，證明不了「所有會動 context 的路徑都鎖住」——搜尋那個洞
   就是這樣漏掉的（`/` 快捷鍵排在鍵盤鎖前面、搜尋鈕又不在 #content 裡）。
   改成掃出所有會改 cardIndex／currentLessonId／mode 的函式，逐一要求有鎖。 */
const CONTEXT_MUTATION_EXEMPT = Object.freeze(new Map([
  // 評分成功後前進到下一張，本來就該動；鎖在它就永遠停在原卡
  ['afterGradeAdvance', '評分成功後的前進路徑本身'],
  ['nextCard', '所有人為呼叫端（方向鍵／滑動／cardPrev-Next）都已各自守門'],
  ['prevCard', '同上'],
  // 開機路徑，那時還沒有 ledgerSession
  ['init', '開機路徑'],
  // 課程延遲載入。ledger 只跑 __TODAY__，它的卡開機就載好了；而且會動 context 的
  // 進入點（搜尋、__ALL__）自己都守住了
  ['replaceRuntimeCatalog', '延遲載入課程；ledger 只跑 __TODAY__，卡片已載入'],
]));

test('AE7：每一個會動 context 的函式都要有 saving 鎖（豁免要寫理由）', () => {
  const starts = [...appSource.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)]
    .map(match => ({ name: match[1], at: match.index }));
  assert.ok(starts.length > 20, 'function 掃描失效的話這條測試會變成永遠通過');

  const mutates = /state\.(cardIndex|currentLessonId|mode)\s*=/;
  const unguarded = [];
  let checked = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const body = appSource.slice(starts[i].at, starts[i + 1]?.at ?? appSource.length);
    if (!mutates.test(body)) continue;
    checked += 1;
    if (CONTEXT_MUTATION_EXEMPT.has(starts[i].name)) continue;
    if (!/isLocked\(\)/.test(body)) unguarded.push(starts[i].name);
  }
  assert.ok(checked >= 6, `只掃到 ${checked} 個會動 context 的函式，掃描條件可能壞了`);
  assert.deepEqual(unguarded, [],
    `這些函式會改 cardIndex／currentLessonId／mode 卻沒有 saving 鎖：${unguarded.join(', ')}`);
});

test('AE7：搜尋的兩條進入點都擋得住（鈕在 topbar、/ 走鍵盤）', () => {
  // 進入點一：`/` 快捷鍵。鎖要排在它之前，否則按下去就開了搜尋面板
  const handler = appSource.indexOf("document.addEventListener('keydown'");
  const lock = appSource.indexOf('if (ledgerSession?.controller.isLocked()) return;', handler);
  const slash = appSource.indexOf("if (e.key === '/')", handler);
  assert.ok(lock > handler && slash > lock, '鍵盤鎖要排在 / 開搜尋之前');
  // 而且要蓋住整個 handler，listen mode 的方向鍵也在鎖後面
  const listen = appSource.indexOf("if (state.mode === 'listen') {", handler);
  assert.ok(listen > lock, 'listen mode 的方向鍵也要在鎖後面');
  // 進入點二：搜尋結果點下去。btnSearch 在 topbar，#content 的 click 鎖蓋不到
  const pick = appSource.indexOf('function onSearchPick(');
  const pickBody = appSource.slice(pick, appSource.indexOf('\n}', pick));
  assert.match(pickBody, /if \(ledgerSession\?\.controller\.isLocked\(\)\) return;/);
});

test('AE7：手機滑動換卡也要過同一道鎖', () => {
  const start = appSource.indexOf("contentEl.addEventListener('touchend'");
  assert.ok(start > 0);
  const block = appSource.slice(start, appSource.indexOf('}, { passive: true });', start));
  assert.match(block, /if \(ledgerSession\?\.controller\.isLocked\(\)\) return;/);
  /* 底下那道今日 mode 的 early return 擋不到帳本：帳本跑在 currentLessonId ===
     '__TODAY__'，而那時 mode 是 srs／cards，所以不能拿它當守門。比對完整那一行，
     不要比對片段——註解裡也會出現同樣的字。 */
  const modeGuard = block.indexOf("if (state.mode === 'today') return;");
  assert.ok(modeGuard > 0);
  assert.ok(block.indexOf('isLocked()') < modeGuard, 'saving 鎖要排在 mode 判斷之前');
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
  assert.match(block, /await resetLedgerAuthorityOrThrow\(\);/, '重置必須真的清 IDB');
  const idbReset = block.indexOf('resetLedgerAuthorityOrThrow');
  const localReset = block.indexOf('state.progress = {};');
  assert.ok(idbReset > 0 && idbReset < localReset, 'IDB 要清在本機鏡射之前');
  assert.match(block, /return;/, '清 IDB 失敗要中止，不能只清一半');
  // 以前是 if (practiceLedger?.port)：runtime 沒起來就靜默跳過，本機清了 IDB 沒清
  assert.doesNotMatch(block, /if \(practiceLedger\?\.port\)/,
    '清 IDB 不能因為 ledger runtime 沒起來就跳過');
});

test('P0：別台裝置按的重置也要清得掉本機 IDB，而且不看 ledger 狀態', () => {
  assert.match(appSource, /setRemoteResetHook\(resetLedgerAuthorityOrThrow\);/);
  // 要接在 status === 'ready' 判斷外面：那時 ledger runtime 可能沒起來，但 IDB 有列
  const hook = appSource.indexOf('setRemoteResetHook(resetLedgerAuthorityOrThrow);');
  const readyBranch = appSource.indexOf("if (practiceLedger.status === 'ready')");
  assert.ok(hook > 0 && readyBranch > 0 && hook < readyBranch,
    'reset hook 要在 ready 判斷之前接好');
  // 清不掉就往上丟，讓 sync 那輪中止
  const helper = appSource.indexOf('async function resetLedgerAuthorityOrThrow()');
  const body = appSource.slice(helper, appSource.indexOf('\n}', helper));
  assert.match(body, /resetRuntimeLedgerAuthority\(\{/);
  /* 記憶體裡的權威快取也要清。不清的話逐卡閘門會拿被刪掉的舊值放行評分，
     帳本讀 IDB 讀到空的、拿空狀態重算，interval 直接塌成 1。 */
  assert.match(body, /clearAuthoritative\(\)/);
  assert.ok(
    body.indexOf('resetRuntimeLedgerAuthority') < body.indexOf('clearAuthoritative'),
    '先清 IDB 再清記憶體快取',
  );
  assert.match(body, /bumpContextEpoch\(\)/);
  /* 連線沒開時不能丟：這條的呼叫端在 runSync 裡，例外會讓 watermark 不前進，
     整條雲端同步永久停擺。 */
  assert.doesNotMatch(body, /throw new Error/);
  assert.match(body, /console\.warn/);
});

test('cloud-sync 的重置 epoch 分支：先清 IDB 再刪本機鍵，而且不吞例外', async () => {
  const syncSource = await readFile(new URL('../src/cloud-sync.js', import.meta.url), 'utf8');
  const start = syncSource.indexOf('const clearedKeys = keysClearedByReset(');
  const end = syncSource.indexOf('// 1) 拉遠端變動並合併進本機', start);
  const block = syncSource.slice(start, end);
  assert.match(block, /await remoteResetHook\?\.\(\);/, '要真的清 IDB');
  assert.ok(
    block.indexOf('await remoteResetHook') < block.indexOf('delete state.progress[k]'),
    'IDB 要清在本機鏡射之前',
  );
  // notifyRemoteProgress 是 try/catch 吞掉的，重置不能走那條
  assert.doesNotMatch(block, /notifyRemoteProgress\('reset-epoch'\);[\s\S]*await remoteResetHook/);
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
