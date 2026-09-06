import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* 跟 legacy_claim_app_contract.test.mjs 同一個路數：app.js 是 DOM 耦合的入口，
   沒辦法直接跑行為測試，就把「接在哪、順序對不對、有沒有接錯東西」釘住。 */
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
/* 位置比對一律用這份。踩過三次：註解裡引用了要比對的字串，assert 就比到自己的註解，
   結果是「程式碼明明對的，測試卻紅」或更糟的「程式碼錯了，測試卻綠」。 */
const appCode = appSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
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

/* AE7 的守衛檢查，第三版。前兩版都被獨立審查當場打穿：
   - 第一版逐一列 selector 比對字串先後位置——只證明得了「這幾個 selector 排在鎖後面」。
   - 第二版自己寫括號配對器切 listener body——被七種寫法規避（無大括號的箭頭 callback、
     body 裡有 regex 字面值讓配對 desync、mutation 塞在豁免 function 的尾巴區間、
     守衛換成含 isLocked() 的字串或沒有 return 的死表達式…），而且 46 個 listener 裡
     有 18 個是認錯 body 的幻影區塊，防呆門檻是被灌水撐起來的。

   兩次的共同錯誤是**想用靜態分析證明「所有路徑都守住了」**。做不到——每加一種寫法就多
   一個漏洞，而測試全綠會給人假的信心，比沒有更危險。

   這一版不證明那件事。它只做一件騙不了的事：**盤點**所有會改 cardIndex／
   currentLessonId／mode 的位置，跟凍結的清單逐字比對。新增、刪除、改寫任何一處都會紅，
   逼人打開這條清單、看那個位置、決定它需不需要鎖。三輪下來漏掉的（搜尋、設定 modal、
   rerender 擦掉狀態列）全部都是「沒有人看過那個位置」，這條擋得住的正是那件事。

   它擋不住什麼，講清楚：不驗證守衛存在、不驗證守衛有效、不驗證守衛排在前面，也看不到
   經過函式呼叫的間接 mutation。那些靠底下各自針對性的行為測試與 controller 測試。 */
const CONTEXT_MUTATION_FILES = Object.freeze(['app.js', 'listen.js', 'state.js', 'ui.js']);
const CONTEXT_MUTATION_SITES = Object.freeze([
  "app.js | if (_initCards.length && state.cardIndex >= _initCards.length) state.cardIndex = 0;",
  "app.js | if (idx >= 0) { state.cardIndex = idx; state.flipped = false; }",
  "app.js | if (state.cardIndex >= cards.length) state.cardIndex = Math.max(0, cards.length - 1);",
  "app.js | if (state.mode === 'listen' || state.mode === 'dialog' || state.mode === 'lists') state.mode = 'card';",
  "app.js | state.cardIndex = (state.cardIndex + 1) % cards.length;",
  "app.js | state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = 0;",
  "app.js | state.cardIndex = found.index;",
  "app.js | state.cardIndex = match.index;",
  "app.js | state.currentLessonId = '__TODAY__';",
  "app.js | state.currentLessonId = deepLink.lessonId;",
  "app.js | state.currentLessonId = found.lessonId;",
  "app.js | state.currentLessonId = id;",
  "app.js | state.currentLessonId = lessons[0]?.id || null;",
  "app.js | state.currentLessonId = match.lessonId;",
  "app.js | state.currentLessonId = state.lessons[0]?.id || null;",
  "app.js | state.currentLessonId = state.lessons[0]?.id || null;",
  "app.js | state.currentLessonId = state.lessons[0]?.id || null;",
  "app.js | state.mode = 'card';",
  "app.js | state.mode = 'card';",
  "app.js | state.mode = 'card';",
  "app.js | state.mode = 'card';",
  "app.js | state.mode = 'srs';",
  "app.js | state.mode = 'srs';",
  "app.js | state.mode = 'today';",
  "app.js | state.mode = m;",
  "listen.js | else state.cardIndex = 0;",
  "listen.js | state.cardIndex = (state.cardIndex + 1) % cards.length;",
  "listen.js | state.cardIndex = (state.cardIndex + 1) % cards.length;",
  "listen.js | state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;",
  "listen.js | state.cardIndex = entry.cardIndex;",
  "listen.js | state.cardIndex = session.nextIndex;",
  "state.js | state.cardIndex = 0;",
  "ui.js | if (state.cardIndex >= cards.length) state.cardIndex = 0;",
]);

test('AE7：會動 context 的位置清單沒有變動（新增一處就要來這裡登記）', async () => {
  const pattern = /state\.(cardIndex|currentLessonId|mode)\s*=(?!=)/;
  const found = [];
  for (const name of CONTEXT_MUTATION_FILES) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (pattern.test(trimmed)) found.push(`${name} | ${trimmed}`);
    }
  }
  found.sort();

  const added = found.filter(site => !CONTEXT_MUTATION_SITES.includes(site));
  const removed = CONTEXT_MUTATION_SITES.filter(site => !found.includes(site));
  assert.deepEqual(added, [],
    '新增了會改 cardIndex／currentLessonId／mode 的位置。先確認它在 saving／save-failed '
    + '期間會不會被觸發到（會的話要加 isLocked() 守衛），再把它登記進 CONTEXT_MUTATION_SITES。');
  assert.deepEqual(removed, [], '有位置消失或被改寫，請更新 CONTEXT_MUTATION_SITES');
  assert.equal(found.length, CONTEXT_MUTATION_SITES.length, '重複出現的行數也要對得上');
});

test('逐卡閘門要用 runtime 交出來的權威列，不是開機前的 hydration 快照', () => {
  /* baseline 與採納都在 hydration 之後才寫 IDB。用快照的話，卡片被 seed 的那一輪
     閘門會判定「沒有權威列但本機有進度」而退回 legacy，接著 localStorage 就比 IDB
     新，那張卡從此再也回不了帳本（線上實測過）。 */
  assert.match(appCode, /authoritativeSrsRows: practiceLedger\.authoritativeSrs/);
  const at = appCode.indexOf('authoritativeSrsRows:');
  const block = appCode.slice(at, at + 220);
  assert.ok(
    block.indexOf('practiceLedger.authoritativeSrs') < block.indexOf('bootResult.hydration'),
    'runtime 那份要排在 hydration 快照前面，快照只能當 fallback',
  );
});

test('AE7：rerender 之後要把鎖住狀態重新套回去', () => {
  /* 狀態列與重試鈕是 card.js 每次 render 重新產生的、寫死 hidden，評分鈕的 disabled
     也會被沖掉。少了這一行，失敗期間任何一次 rerender 都會讓出路從畫面上消失，而
     controller 還鎖著——點擊被靜默吃掉，只能重新整理。 */
  const start = appCode.indexOf('function rerender(storage) {');
  assert.ok(start > 0);
  const body = appCode.slice(start, appCode.indexOf('\n}', start));
  assert.match(body, /renderLedgerSavingState\(ledgerSession\.controller\.getStatus\(\)\)/);
  assert.ok(
    body.indexOf('renderContent(') < body.indexOf('renderLedgerSavingState'),
    '要排在 renderContent 之後，否則會被那次 render 沖掉',
  );
});

test('AE7：設定的守衛要排在任何寫入之前', () => {
  /* 原本放在 if (inputChanged) 裡面：URL 沒改的常見情況整段跳過，直接落到
     closeModal() + rerender()（而那個 rerender 會擦掉失敗狀態的出路）；而且
     sheetInput 早就寫進去又存檔了，第二次點 inputChanged 變 false。 */
  const start = appCode.indexOf("document.getElementById('btnSaveSettings')");
  assert.ok(start > 0);
  // 取固定視窗就好，這段的三個標記都在開頭 600 字內；找 handler 結尾容易抓錯縮排
  const body = appCode.slice(start, start + 600);
  const lock = body.indexOf('isLocked()');
  assert.ok(lock > 0, '設定儲存要有 saving 鎖');
  assert.ok(lock < body.indexOf('state.settings.sheetInput = newInput'), '鎖要排在寫入之前');
  assert.ok(lock < body.indexOf('if (inputChanged)'), '不能藏在 inputChanged 分支裡');
});

test('評分的 promise 有接住 rejection，不留 unhandled', () => {
  const start = appCode.indexOf('void ledgerSession.controller.submitGrade(g)');
  assert.ok(start > 0);
  const block = appCode.slice(start, start + 700);
  assert.match(block, /\.catch\(error => \{/);
});

test('AE7：搜尋的兩條進入點都擋得住（鈕在 topbar、/ 走鍵盤）', () => {
  // 進入點一：`/` 快捷鍵。鎖要排在它之前，否則按下去就開了搜尋面板
  const handler = appCode.indexOf("document.addEventListener('keydown'");
  const lock = appCode.indexOf('if (ledgerSession?.controller.isLocked()) return;', handler);
  const slash = appCode.indexOf("if (e.key === '/')", handler);
  assert.ok(lock > handler && slash > lock, '鍵盤鎖要排在 / 開搜尋之前');
  // 而且要蓋住整個 handler，listen mode 的方向鍵也在鎖後面
  const listen = appCode.indexOf("if (state.mode === 'listen') {", handler);
  assert.ok(listen > lock, 'listen mode 的方向鍵也要在鎖後面');
  // 進入點二：搜尋結果點下去。btnSearch 在 topbar，#content 的 click 鎖蓋不到
  const pick = appCode.indexOf('function onSearchPick(');
  const pickBody = appCode.slice(pick, appCode.indexOf('\n}', pick));
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
