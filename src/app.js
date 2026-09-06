/* 入口：init → 載入狀態 → 抓資料 → 綁事件。 */

import {
  state, loadDeviceStateResult, saveState as persistState, localDateKey, setGradeFromLedger,
  STORAGE_KEY, projectHydratedWorkspaceState, projectWorkspaceAuxiliaryState,
  mergeWorkspaceHydration,
  DEFAULT_SHEET_URL,
  filteredCards, setGrade, shuffleCurrentLesson, isSrsActive, cardKey,
  saveLessonsCache, loadLessonsCache,
  setLastSync, getLastSync, formatLastSync,
  findCardByKey, saveCardEdit, clearCardEdit,
  allCardsWithLessonId, setDailyQueue, removeFromDailyQueue,
} from './state.js';
import {
  loadLessons, loadBundledData, loadPublishedCatalog,
} from './data.js';
import { DAILY_KEY, initDailyLog, logReview, buildAchievementCtx, notifyAchievements, addActiveSeconds, settleStreakOnOpen, showToast, buildDailyQueue, loadDailyLog, setLogChangeHook } from './today.js';
import { advanceResweepCursor } from './resweep.js';
import { syncProgressThrottled, syncProgressOnHide } from './progress-sync.js';
import * as cloudAuth from './cloud-auth.js';
import { syncNow, syncThrottled, syncSoon, flushOnHide, lastSyncedAt, resetProgressEverywhere, invalidateSync, clearSyncState, setRemoteProgressHook, setRemoteResetHook } from './cloud-sync.js';
import { recordGrade } from './grade-history.js';
import { checkAndUnlock } from './achievements.js';
import { getListenLog, speakCard, warmupVoices, preloadRealAudioAvailability } from './tts.js';
import { stopListen } from './listen.js';
import { exitDialogueGame } from './game-dialogue.js';
import {
  createWorkspaceStorage, requireWorkspaceStorage as assertWorkspaceStorage,
  bootScreenFor, createWorkspaceBoot, logoutToAnonymous, runWorkspaceBoot,
  getOrCreateWorkspaceInstallationId,
} from './storage-scope.js';
import { getDeviceId } from './srs.js';
import {
  createPracticeTransactionPort, hydrateWorkspaceSnapshot, openPracticeDatabase,
} from './practice-db.js';
import { createLegacyClaimFlow, fetchProductionLineageEvidence } from './legacy-claim-flow.js';
import { startPracticeLedgerRuntime, catalogCardKeyIndex } from './practice-ledger-runtime.js';
import { resetRuntimeLedgerAuthority } from './storage-scope.js';
import { createLedgerGradeSession, ledgerGradeEligible } from './practice-grade-session.js';
import { TRUSTED_PRODUCTION_LINEAGE } from './production-lineage-trust.js';
import {
  renderSidebar, renderTopbarTitle, renderStats, renderContent,
  openDrawer, closeDrawer, openModal, closeModal, applyTheme,
  openSearch, closeSearch, renderSearchResults,
} from './ui.js';

let workspaceStorage = null;
/* ledger runtime handle。status 不是 'ready' 就代表這次開機不開放 ledger 評分，
   評分照舊走 legacy 路徑（見 gradeAndAdvance）。 */
let practiceLedger = null;
let practiceLedgerWorkspaceId = null;
/* 重置要清 IDB 的權威 SRS，而那些列可能是上一輪開機寫進去的——就算這次 ledger
   runtime 沒起來（catalog fence、lineage 拿不到），它們還在。所以重置不能吃
   practiceLedger?.port，得有一條不依賴 runtime 狀態的路。 */
let practiceResetPort = null;
/* ledger 評分 session。null 代表這次開機沒有帳本路徑可走。 */
let ledgerSession = null;

/* 手動重置與遠端重置 epoch 共用這一條。清不掉就往上丟，讓呼叫端中止——半清的狀態
   比沒清更糟：本機沒了、IDB 還在，下次評分就把重置前的排程當基準算回去。 */
async function resetLedgerAuthorityOrThrow() {
  /* 連線根本沒開＝這個 session 沒碰過 IDB，沒有權威列要清。這裡不能丟：遠端重置
     epoch 的呼叫端在 runSync 裡，例外會被外層 catch 成 warn 而且 watermark 不前進，
     整條雲端同步就永久停擺。注意這跟「runtime 沒起來但連線在」是兩件事——那種
     情況 practiceResetPort 會有 fallback port，照樣清得掉。 */
  if (!practiceResetPort || !practiceLedgerWorkspaceId) {
    console.warn('practice ledger authority reset skipped: database was never opened');
    return;
  }
  await resetRuntimeLedgerAuthority({
    port: practiceResetPort,
    workspaceId: practiceLedgerWorkspaceId,
  });
  /* 順序：先清 IDB，再清記憶體裡的權威快取。快取沒清的話逐卡閘門會拿被刪掉的
     那份舊值放行評分，帳本從空狀態重算，排程塌成 1 天。 */
  ledgerSession?.clearAuthoritative();
  ledgerSession?.bumpContextEpoch();
}

function requireWorkspaceStorage(storage = workspaceStorage) {
  return assertWorkspaceStorage(storage);
}

function saveState(storage) {
  return persistState(requireWorkspaceStorage(storage));
}

function assertCompleteCatalog() {
  if (!state.lessons.length || state.lessons.some(lesson => !lesson._loaded)) {
    throw new Error('課程資料尚未完整載入，已保留上一版資料');
  }
}

async function ensureCatalogReady() {
  assertCompleteCatalog();
}

/* 所有跨課程操作都先確認 catalog 已完整採用，絕不在半套資料上運作。 */
export async function ensureAllLoaded() {
  assertCompleteCatalog();
}

function replaceRuntimeCatalog(catalog, storage) {
  const runtimeStorage = requireWorkspaceStorage(storage);
  const lessons = catalog.lessons.map(lesson => ({ ...lesson, _loaded: true }));
  const sameStructure = lessons.length === state.lessons.length
    && lessons.every((lesson, index) => lesson.id === state.lessons[index]?.id);
  state.lessons = lessons;
  state.dialogues = catalog.dialogues || [];
  state.baseUrl = catalog.baseUrl || '';
  if (!sameStructure) {
    state.currentLessonId = lessons[0]?.id || null;
    state.cardIndex = 0;
    state.flipped = false;
  }
  rerender(runtimeStorage);
}

/* 主進入點：
   1. 預設 Sheet + 非 force → 直接讀同源 ./data.json（GitHub Action 預生成，< 50ms）
   2. 預設 Sheet + force（重新同步）→ 走 live publish-to-web（保留現有行為）
   3. 自訂 sheet URL → 永遠走 live（不影響使用者貼自己的 Sheet） */
async function loadLessonsSmart({ force = false, runtimeStorage = null } = {}) {
  const customInput = (state.settings.sheetInput || '').trim();
  const url = customInput || DEFAULT_SHEET_URL;
  const cached = force ? null : loadLessonsCache(url);
  const adopt = ({ lessons, dialogues = [], baseUrl = '' }) => {
    state.dialogues = dialogues;
    state.baseUrl = baseUrl;
    return lessons.map(lesson => ({ ...lesson, _loaded: true }));
  };

  // 預設 Sheet + 非 force → 試 bundled JSON
  if (!customInput && !force) {
    try {
      const { lessons, dialogues } = await loadBundledData();
      return adopt({
        lessons,
        dialogues,
        baseUrl: DEFAULT_SHEET_URL.replace(/\/pub(html)?$/, ''),
      });
    } catch (e) {
      console.warn('bundled JSON 讀取失敗，退回 live fetch：', e.message);
    }
  }

  const isPublishedSheet = /\/d\/e\//.test(url) && !/output=csv/i.test(url);
  const fetchCompleteCatalog = async () => {
    if (isPublishedSheet) {
      return loadPublishedCatalog(url, {
        force,
        requireDialogues: force || !customInput,
      });
    }
    const lessons = await loadLessons(url, { force });
    if (!lessons?.length) throw new Error('回應為空');
    return { lessons, dialogues: [], baseUrl: '' };
  };

  // 新版完整 cache 可先開畫面，但背景刷新仍必須把整份 manifest、所有課程與對話
  // 都驗證完，才一起替換 runtime/cache；任何一處失敗都維持舊狀態。
  if (cached) {
    void fetchCompleteCatalog().then(catalog => {
      const currentUrl = (state.settings.sheetInput || '').trim() || DEFAULT_SHEET_URL;
      if (currentUrl !== url) return;
      const ready = catalog.lessons.map(lesson => ({ ...lesson, _loaded: true }));
      saveLessonsCache(url, ready, catalog);
      if (runtimeStorage) replaceRuntimeCatalog({ ...catalog, lessons: ready }, runtimeStorage);
    }).catch(e => console.warn('背景 catalog 刷新失敗，沿用已驗證快取：', e.message));
    return adopt(cached);
  }

  const catalog = await fetchCompleteCatalog();
  const ready = adopt(catalog);
  saveLessonsCache(url, ready, catalog);
  return ready;
}

function rerender(storage) {
  const runtimeStorage = requireWorkspaceStorage(storage);
  const renderAgain = () => rerender(runtimeStorage);
  preloadRealAudioAvailability(state.currentLessonId, renderAgain);
  renderSidebar(id => selectLesson(id, runtimeStorage), runtimeStorage);
  renderTopbarTitle();
  renderContent(renderAgain, runtimeStorage);
  renderStats();
  /* 狀態列與重試鈕是 card.js 每次 render 重新產生的、而且寫死 hidden，評分鈕的
     disabled 也會被沖掉。所以任何一次 rerender 都會把失敗狀態的出路擦掉——畫面看
     起來可以按，controller 卻還鎖著，點擊被靜默吃掉，只能重新整理。render 完一定
     要把狀態重新套回去。 */
  if (ledgerSession) renderLedgerSavingState(ledgerSession.controller.getStatus());
}

function onSearchPick(match, storage) {
  /* 搜尋進得來的路有兩條，兩條都繞過 #content 的 click 鎖（搜尋鈕在 topbar）與
     鍵盤鎖（`/` 分支排在它前面），所以守衛得放在這裡。少了它，saving 期間跳到
     別張卡，交易落地後 operation token 對不上，那筆評分只存在於 IDB，本機的
     每日日誌與佇列都不知道（AE7）。 */
  if (ledgerSession?.controller.isLocked()) return;
  // 跳到該卡：切到對應課程、cardIndex、並切回字卡模式
  state.currentLessonId = match.lessonId;
  state.cardIndex = match.index;
  state.flipped = false;
  if (state.mode === 'listen' || state.mode === 'dialog' || state.mode === 'lists') state.mode = 'card';
  stopListen();
  saveState(storage);
  syncModeButtons();
  closeSearch();
  rerender(storage);
}

function syncModeButtons(m = state.mode) {
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('.mp-btn').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('[data-drawer-mode]').forEach(t => t.classList.toggle('active', t.dataset.drawerMode === m));
}

async function selectLesson(id, storage) {
  // AE7：saving／失敗期間不准換 context。守門放在這裡而不是各個 handler，
  // 側欄、抽屜、mode picker 全都會經過這兩支。
  if (ledgerSession?.controller.isLocked()) return;
  state.currentLessonId = id;
  state.cardIndex = 0;
  state.flipped = false;
  stopListen();
  saveState(storage);
  closeDrawer();
  rerender(storage);
  // 跨課程操作前再次確認沒有半套 catalog。
  await ensureCatalogReady();
  rerender(storage);
}

async function selectMode(m, storage) {
  // AE7：saving／失敗期間不准換 context。守門放在這裡而不是各個 handler，
  // 側欄、抽屜、mode picker 全都會經過這兩支。
  if (ledgerSession?.controller.isLocked()) return;
  state.mode = m;
  state.flipped = false;
  stopListen();
  exitDialogueGame();
  syncModeButtons(m);
  saveState(storage);
  renderContent(() => rerender(storage), storage);
  renderStats();
  if (m === 'lists' || m === 'dialog' || m === 'today') {
    await ensureAllLoaded();
    rerender(storage);
  }
}

async function selectListMode(order, storage) {
  const enteringLists = state.mode !== 'lists';
  state.listOrder = order === 'zh' ? 'zh' : 'thai';
  if (enteringLists) state.listFilter = 'all';
  await selectMode('lists', storage);
  closeDrawer();
}

function nextCard(storage) {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex + 1) % cards.length;
  state.flipped = false;
  saveState(storage);
  renderContent(() => rerender(storage), storage);
}

/* 評分後的行為：
   - SRS active：剛評的那張 nextReviewAt > now → 從 due 列表消失，cardIndex 不變但 list 變短，
     直接 rerender 自然指到下一張；clamp 防越界
   - 一般 mode：cards 不變，往下一張前進 */
/* controller 的狀態 → 畫面。saving 期間鎖住評分與導覽（AE7）；失敗時一定要給得出
   下一步，不能讓人卡在一個鎖住又沒說明的畫面上。 */
const LEDGER_STATUS_TEXT = Object.freeze({
  saving: { text: '存檔中…', action: null },
  'save-failed': { text: '這筆沒存成功，進度還沒記下來。', action: '再試一次' },
  'projection-repair': { text: '進度已經記下來了，畫面數字還沒更新。', action: '重新整理數字' },
});

function renderLedgerSavingState(status) {
  const busy = status !== 'idle';
  document.body.dataset.ledgerSaving = busy ? status : '';
  for (const el of document.querySelectorAll('[data-grade], #cardPrev, #cardNext')) {
    el.toggleAttribute('disabled', busy);
    el.setAttribute('aria-disabled', busy ? 'true' : 'false');
  }

  const region = document.querySelector('[data-ledger-status]');
  if (!region) return;
  const copy = LEDGER_STATUS_TEXT[status];
  region.toggleAttribute('hidden', !copy);
  region.dataset.state = status;
  region.querySelector('[data-ledger-status-text]').textContent = copy ? copy.text : '';
  const action = region.querySelector('[data-ledger-retry]');
  action.toggleAttribute('hidden', !copy?.action);
  if (copy?.action) {
    action.textContent = copy.action;
    action.disabled = false;
    // 失敗時把焦點帶到唯一的出路，鍵盤使用者不用自己找。
    if (status !== 'saving') action.focus();
  }
}

async function retryLedgerAction() {
  if (!ledgerSession) return;
  const status = ledgerSession.controller.getStatus();
  const action = document.querySelector('[data-ledger-retry]');
  if (action) action.disabled = true;
  if (status === 'save-failed') await ledgerSession.controller.retry();
  else if (status === 'projection-repair') await ledgerSession.controller.repairProjection();
  else if (action) action.disabled = false;
}

/* 評分之後的畫面收尾。legacy 與 ledger 兩條路都走這裡，前進行為才會一致。 */
function afterGradeAdvance(runtimeStorage, gradedCardKey, improvementMoment) {
  if (cloudAuth.hasStoredSession()) syncSoon(runtimeStorage);
  if (state.currentLessonId === '__TODAY__' && gradedCardKey) {
    const wasResweep = removeFromDailyQueue(gradedCardKey);
    if (wasResweep) advanceResweepCursor(1, allCardsWithLessonId().length, runtimeStorage);
  }
  const achvCtx = buildAchievementCtx(undefined, Date.now(), runtimeStorage);
  notifyAchievements(
    checkAndUnlock(achvCtx, runtimeStorage),
    achvCtx,
    improvementMoment ? '這句你上次不會，現在會了。' : '',
  );
  state.flipped = false;
  if (isSrsActive()) {
    const cards = filteredCards();
    if (state.cardIndex >= cards.length) state.cardIndex = Math.max(0, cards.length - 1);
    saveState(runtimeStorage);
    rerender(runtimeStorage);
  } else {
    nextCard(runtimeStorage);
    // 評分會影響側邊欄徽章，補一次 sidebar render
    renderSidebar(id => selectLesson(id, runtimeStorage), runtimeStorage);
    renderTopbarTitle();
  }
}

/* 逐卡閘門：認領失敗的卡（IDB 沒有權威 SRS 列、但本機有進度）一律留給 legacy。
   硬走帳本的話 commitPracticeAttempt 會拿空狀態當基準，把累積數月的排程重設成
   interval 1 再推上雲端。判斷邏輯在 practice-grade-session.js。 */
function ledgerAcceptsCurrentCard() {
  const card = filteredCards()[state.cardIndex];
  if (!card) return false;
  const key = card._cardKey || cardKey(card);
  const cardId = card.card_id || card.cardId || null;
  if (!cardId) return false;
  return ledgerSession.acceptsCard(cardId, state.progress[key] || null);
}

/* 帳本收不下這筆時退回原本的同步流程。context 湊不齊（卡片索引越界、佇列與 lane
   快照不同步、Sheet 新增了沒有 card_id 的列）時 submitGrade 只回狀態不丟錯，不接住
   的話使用者按了評分畫面完全不動——宣稱的 fail-open 到 legacy 在那裡並不成立。 */
const LEDGER_FALLBACK_STATUSES = Object.freeze(new Set(['context-invalid', 'not-eligible']));

function gradeAndAdvance(g, storage) {
  // R1：只有 Today／All 而且 ledger 這次開機是 ready 的時候走帳本路徑，其餘一律
  // 維持原本的同步流程。controller 自己有 CAS guard，重複觸發會被擋掉。
  if (ledgerSession && ledgerGradeEligible(practiceLedger, state.currentLessonId)
      && ledgerAcceptsCurrentCard()) {
    void ledgerSession.controller.submitGrade(g).then(result => {
      if (LEDGER_FALLBACK_STATUSES.has(result?.status)) legacyGradeAndAdvance(g, storage);
    }).catch(error => {
      // controller 內部已經把已知的失敗轉成 status，這裡是最後一道：沒接的話會變成
      // unhandled rejection，而畫面可能還鎖著。
      console.warn('ledger submitGrade rejected:', error?.code || error?.message);
      renderLedgerSavingState(ledgerSession.controller.getStatus());
    });
    return;
  }
  legacyGradeAndAdvance(g, storage);
}

function legacyGradeAndAdvance(g, storage) {
  const runtimeStorage = requireWorkspaceStorage(storage);
  const gradedCard = filteredCards()[state.cardIndex];
  const gradedCardKey = gradedCard ? (gradedCard._cardKey || cardKey(gradedCard)) : '';
  setGrade(state.cardIndex, g, runtimeStorage);
  const improvementMoment = gradedCard
    ? recordGrade(gradedCardKey, g, Date.now(), runtimeStorage)
    : false;
  logReview(g, Date.now(), runtimeStorage);
  afterGradeAdvance(runtimeStorage, gradedCardKey, improvementMoment);
}

function prevCard(storage) {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;
  state.flipped = false;
  saveState(storage);
  renderContent(() => rerender(storage), storage);
}

function closeEditModal() {
  document.getElementById('editMask').classList.remove('open');
}

function openEditModal(cardKey) {
  const found = findCardByKey(cardKey);
  if (!found) {
    alert('找不到這張卡片，請重新同步後再試一次。');
    return;
  }
  const { card } = found;
  document.getElementById('editCardKey').value = card._cardKey;
  document.getElementById('editThai').value = card.thai || '';
  document.getElementById('editKaraoke').value = card.karaoke || '';
  document.getElementById('editZh').value = card.zh || '';
  document.getElementById('editNote').value = card.note || '';
  document.getElementById('editMask').classList.add('open');
  setTimeout(() => document.getElementById('editThai').focus(), 50);
}

function saveEditModal(storage) {
  const key = document.getElementById('editCardKey').value;
  const found = findCardByKey(key);
  if (!found) return closeEditModal();
  saveCardEdit(found.card, {
    thai: document.getElementById('editThai').value,
    karaoke: document.getElementById('editKaraoke').value,
    zh: document.getElementById('editZh').value,
    note: document.getElementById('editNote').value,
  }, storage);
  closeEditModal();
  rerender(storage);
}

function clearEditModal(storage) {
  const key = document.getElementById('editCardKey').value;
  const found = findCardByKey(key);
  if (!found) return closeEditModal();
  clearCardEdit(found.card, storage);
  closeEditModal();
  rerender(storage);
}

function jumpToCard(cardKey, storage) {
  if (ledgerSession?.controller.isLocked()) return;
  const found = findCardByKey(cardKey);
  if (!found) {
    alert('找不到這張卡片，請重新同步後再試一次。');
    return;
  }
  state.currentLessonId = found.lessonId;
  state.cardIndex = found.index;
  state.mode = 'card';
  state.flipped = false;
  stopListen();
  saveState(storage);
  syncModeButtons('card');
  rerender(storage);
}

function wireSegClick(sel, onPick) {
  document.querySelectorAll(`${sel} .seg-btn`).forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll(`${sel} .seg-btn`).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onPick(b);
    });
  });
}

function flashShuffle() {
  const btn = document.getElementById('btnShuffle');
  if (!btn) return;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 400);
}

function showLoading(msg) {
  const el = document.getElementById('content');
  if (el) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">⋯</div>
      <div class="empty-title">${msg}</div>
      <div class="empty-sub">首次載入 28 堂課要幾秒到十幾秒，請稍候。之後 Service Worker 會 cache，就會快很多。</div>
    </div>`;
  }
}

function renderWorkspaceBoot(snapshot, diagnostics = '') {
  if (snapshot.state === 'ready') return;
  const el = document.getElementById('content');
  if (!el) return;
  const screen = snapshot.screen || bootScreenFor(snapshot.state);
  const root = document.createElement('div');
  root.className = 'empty';
  root.dataset.bootState = snapshot.state;
  const add = (className, text) => {
    const child = document.createElement('div');
    child.className = className;
    child.textContent = text;
    root.append(child);
  };
  add('empty-icon', snapshot.state === 'recoverable-failure' || snapshot.state === 'storage-unavailable' ? '!' : '⋯');
  add('empty-title', screen.title);
  add('empty-sub', screen.message);
  const actions = document.createElement('div');
  actions.className = 'btn-row';
  for (const action of screen.actions) {
    const button = document.createElement('button');
    button.className = `btn ${action.id === 'retry' ? 'primary' : 'ghost'}`;
    button.id = `boot-${action.id}`;
    button.type = 'button';
    button.textContent = action.label;
    actions.append(button);
  }
  root.append(actions);
  const details = document.createElement('div');
  details.className = 'empty-sub';
  details.id = 'boot-diagnostic-details';
  details.hidden = true;
  details.textContent = diagnostics;
  root.append(details);
  el.replaceChildren(root);
  document.getElementById('boot-retry')?.addEventListener('click', () => location.reload());
  document.getElementById('boot-diagnostics')?.addEventListener('click', () => {
    const details = document.getElementById('boot-diagnostic-details');
    if (details) details.hidden = false;
  });
  document.getElementById(screen.focusTarget)?.focus();
}

function bootDiagnostics({ details = null, error = null } = {}) {
  const phase = details?.phase || 'unknown';
  const code = details?.code || error?.code || 'WORKSPACE_BOOT_FAILED';
  return `診斷：${phase} / ${code}`;
}

function renderLegacyClaimOffer({
  offer, accountLabel, legacyFactCount, summary, signal,
}) {
  return new Promise((resolve, reject) => {
    const content = document.getElementById('content');
    if (!content) {
      const error = new Error('legacy claim UI is unavailable');
      error.code = 'LEGACY_CLAIM_UI_UNAVAILABLE';
      reject(error);
      return;
    }
    const root = document.createElement('div');
    root.className = 'empty';
    root.dataset.legacyClaim = 'offer';
    const add = (className, text) => {
      const child = document.createElement('div');
      child.className = className;
      child.textContent = text;
      root.append(child);
    };
    add('empty-icon', '↗');
    add('empty-title', '找到這台裝置的舊進度');
    add('empty-sub', `帳號：${accountLabel}`);
    add('empty-sub', `共 ${legacyFactCount} 筆；可解析 ${summary.resolved} 筆，${summary.quarantined} 筆會先隔離。保守不亂猜。`);

    const actions = document.createElement('div');
    actions.className = 'btn-row';
    const claimButton = document.createElement('button');
    claimButton.className = 'btn primary';
    claimButton.type = 'button';
    claimButton.textContent = '將這台裝置的進度加入此帳號';
    const cancelButton = document.createElement('button');
    cancelButton.className = 'btn ghost';
    cancelButton.type = 'button';
    cancelButton.textContent = '先不要';
    actions.append(claimButton, cancelButton);
    root.append(actions);
    content.replaceChildren(root);

    let settled = false;
    const finish = decision => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      for (const button of [claimButton, cancelButton]) button.disabled = true;
      if (decision === 'claim') claimButton.textContent = '儲存中…';
      resolve(decision);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const error = new Error('legacy claim was invalidated');
      error.code = 'WORKSPACE_INVALIDATED';
      reject(error);
    };
    claimButton.addEventListener('click', () => finish('claim'), { once: true });
    cancelButton.addEventListener('click', () => finish('cancel'), { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    claimButton.focus();
  });
}

function showLegacyMigrationSummary(summary) {
  if (!summary) return Promise.resolve();
  return new Promise(resolve => {
    const content = document.getElementById('content');
    if (!content) {
      resolve();
      return;
    }
    const root = document.createElement('div');
    root.className = 'empty';
    root.dataset.migrationSummary = 'complete';
    const add = (className, text) => {
      const child = document.createElement('div');
      child.className = className;
      child.textContent = text;
      root.append(child);
    };
    add('empty-icon', '✓');
    add('empty-title', '舊進度已安全整理');
    add('empty-sub', `原始紀錄：${summary.original} 筆（完整保留）`);
    add('empty-sub', `已解析：${summary.resolved} 筆；已加入可用進度：${summary.materialized} 筆`);
    add('empty-sub', `待重新掃描：${summary.quarantined} 筆。無法唯一對應的內容已先隔離，保守不亂猜。`);
    const button = document.createElement('button');
    button.className = 'btn primary';
    button.type = 'button';
    button.textContent = '進入今日';
    button.addEventListener('click', () => resolve(), { once: true });
    root.append(button);
    content.replaceChildren(root);
    button.focus();
  });
}

function runtimeProgressFromHydration(progress, catalog) {
  const keyByCardId = new Map();
  for (const lesson of catalog?.lessons || []) {
    for (const card of lesson.cards || []) {
      if (card?.card_id) {
        keyByCardId.set(card.card_id, cardKey({ ...card, _lessonId: lesson.id }, lesson.id));
      }
    }
  }
  const translated = {};
  for (const [cardId, entry] of Object.entries(progress || {})) {
    const key = keyByCardId.get(cardId);
    if (key) translated[key] = structuredClone(entry);
  }
  return translated;
}

function mergeProjectionRecord(storage, writeHydration, key, projection) {
  const facts = Object.fromEntries((projection?.facts || []).map(fact => [fact.sourceKey, fact.value]));
  let existing = {};
  try {
    const parsed = JSON.parse(storage.getItem(key) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch { /* invalid auxiliary bytes are replaced by the verified projection */ }
  writeHydration(key, JSON.stringify({ ...facts, ...existing }));
  return { ...facts, ...existing };
}

function applyHydratedWorkspace(hydration, auxiliary, dailyStateExists, writeHydration, catalog, hydrationStorage) {
  const projected = projectHydratedWorkspaceState(hydration);
  const daily = projected.projections.daily;
  if (!dailyStateExists
      && daily?.schemaVersion === 1
      && daily.projectorVersion === 'legacy-workspace-facts-v1'
      && Array.isArray(daily.facts)) {
    const log = { v: 1, backfilled: false, days: {} };
    for (const fact of daily.facts) {
      if (fact?.sourceKey === 'meta' && fact.value && typeof fact.value === 'object') {
        Object.assign(log, structuredClone(fact.value));
      } else if (typeof fact?.sourceKey === 'string' && fact.value && typeof fact.value === 'object') {
        log.days[fact.sourceKey] = structuredClone(fact.value);
      }
    }
    writeHydration(DAILY_KEY, JSON.stringify(log));
  }
  const favoritesProjection = projected.projections.favorites;
  const projectionFavorites = Object.fromEntries((favoritesProjection?.facts || []).map(fact => [
    fact.sourceKey,
    fact.value?.favorite ?? fact.value,
  ]));
  const mergedFavorites = {
    ...projectionFavorites,
    ...auxiliary.favorites,
  };
  if (favoritesProjection) {
    writeHydration(STORAGE_KEY, JSON.stringify({
      progress: auxiliary.progress,
      favorites: mergedFavorites,
      edits: auxiliary.edits,
    }));
  }
  if (projected.projections.achievements) {
    mergeProjectionRecord(
      hydrationStorage, writeHydration, 'thai-review-achievements-v1',
      projected.projections.achievements,
    );
  }
  if (projected.projections.remoteDays) {
    mergeProjectionRecord(
      hydrationStorage, writeHydration, 'thai-review-remote-days-v1',
      projected.projections.remoteDays,
    );
  }
  Object.assign(state, mergeWorkspaceHydration({
    ...projected,
    progress: runtimeProgressFromHydration(projected.progress, catalog),
  }, { ...auxiliary, favorites: mergedFavorites }));
  return { projected, auxiliary };
}

function updateSyncHint() {
  const el = document.getElementById('syncHint');
  if (!el) return;
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  el.textContent = `上次同步：${formatLastSync(getLastSync(url))}`;
}

/* 跨裝置同步的狀態列。沒登入時完全不碰網路，畫面就停在「未登入」。 */
async function updateCloudHint(storage) {
  const statusEl = document.getElementById('cloudStatus');
  const btn = document.getElementById('btnCloudAuth');
  const hint = document.getElementById('cloudHint');
  if (!statusEl || !btn) return;

  const session = await cloudAuth.getSession();
  if (!session) {
    statusEl.textContent = '未登入';
    btn.textContent = '用 Google 登入';
    btn.dataset.cloudAction = 'login';
    if (hint) hint.textContent = '登入後，手機／平板／電腦的複習紀錄會自動同步。';
    return;
  }

  statusEl.textContent = session.user?.email || '已登入';
  btn.textContent = '登出';
  btn.dataset.cloudAction = 'logout';
  if (hint) {
    const at = lastSyncedAt(requireWorkspaceStorage(storage));
    hint.textContent = at
      ? `上次同步：${formatLastSync(at)}`
      : '尚未同步過，開啟 App 或切到背景時會自動同步。';
  }
}

async function fetchJsonMaybe(path) {
  try {
    const res = await fetch(`${path}?_=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function formatTaipei(value) {
  if (!value) return '';
  const date = typeof value === 'number'
    ? new Date(value * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

async function currentSwCacheName() {
  if (!('caches' in window)) return '';
  try {
    const keys = await caches.keys();
    return keys.filter(k => k.startsWith('thai-review-')).sort().at(-1) || '';
  } catch {
    return '';
  }
}

async function updateRuntimeHint() {
  const el = document.getElementById('appVersionHint');
  if (!el) return;
  el.textContent = '版本資訊：讀取中…';

  const [cacheName, deployInfo, dataInfo, zhInfo] = await Promise.all([
    currentSwCacheName(),
    fetchJsonMaybe('deploy-info.json'),
    fetchJsonMaybe('data.json'),
    fetchJsonMaybe('zh-manifest.json'),
  ]);

  const lines = [];
  if (cacheName) lines.push(`App cache：${cacheName.replace('thai-review-', '')}`);
  if (deployInfo?.source_commit) {
    const builtAt = formatTaipei(deployInfo.generated_at);
    lines.push(`部署：${deployInfo.source_commit}${builtAt ? ` / ${builtAt}` : ''}`);
  }
  const dataAt = formatTaipei(dataInfo?.generated_at);
  if (dataAt) lines.push(`資料：${dataAt}`);
  const zhAt = formatTaipei(zhInfo?.generated_at);
  if (zhAt) lines.push(`中文音檔：${zhAt}`);
  if (!lines.length) lines.push('版本資訊：無法讀取');
  lines.push('點這裡看聽力 log');
  el.textContent = lines.join('\n');
}

/* 通知深連結：?card=<lessonId>:<thai>（跟 state.js cardKey() 同一種 key 格式）。
   URLSearchParams 已經自動解掉 percent-encoding，不用再 decodeURIComponent 一次。
   只在開啟當下讀一次，讀完清掉網址參數，避免重整頁面又被拉回同一張卡。 */
function parseDeepLinkParam() {
  const raw = new URLSearchParams(location.search).get('card');
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep < 0) return null;
  const lessonId = raw.slice(0, sep);
  const thai = raw.slice(sep + 1);
  if (!lessonId || !thai) return null;
  return { lessonId, thai };
}

function clearDeepLinkParam() {
  const params = new URLSearchParams(location.search);
  if (!params.has('card')) return;
  params.delete('card');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
}

async function init() {
  const deviceState = loadDeviceStateResult();
  if (deviceState.status !== 'ok') {
    const state = deviceState.status === 'unavailable' ? 'storage-unavailable' : 'recoverable-failure';
    renderWorkspaceBoot({ state, screen: bootScreenFor(state) }, bootDiagnostics({
      details: { phase: deviceState.phase || 'device-settings', code: deviceState.reason },
    }));
    return;
  }
  applyTheme();
  let practiceConnection = null;
  let legacyClaimFlow = null;
  const workspaceBoot = createWorkspaceBoot();
  const bootResult = await runWorkspaceBoot({
    boot: workspaceBoot,
    resolveSession: cloudAuth.getSessionResult,
    resolveDeviceId: getDeviceId,
    loadCatalog: async () => ({ lessons: await loadLessonsSmart() }),
    openStorage: async ({ workspaceId, boot }) => {
      const storage = createWorkspaceStorage(localStorage, { workspaceId, boot });
      practiceConnection = await openPracticeDatabase({
        onVersionChange: () => {
          legacyClaimFlow?.invalidate();
          const current = boot.snapshot();
          if (current.state !== 'recoverable-failure' && current.state !== 'storage-unavailable') {
            boot.moveTo('recoverable-failure', {
              phase: 'indexeddb-versionchange', code: 'PRACTICE_DB_VERSION_CHANGED',
            });
          }
          renderWorkspaceBoot(boot.snapshot(), bootDiagnostics({ details: boot.snapshot().details }));
        },
      });
      return storage;
    },
    migrate: async ({ workspaceId, session, migrationStorage }) => {
      legacyClaimFlow?.invalidate();
      legacyClaimFlow = createLegacyClaimFlow({
        rootStorage: localStorage,
        eligibilityStorage: migrationStorage,
        practiceConnection,
        assertBootActive: id => {
          const current = workspaceBoot.snapshot();
          if (current.state !== 'migrating' || current.workspaceId !== id) {
            throw Object.assign(new Error('legacy claim boot was invalidated'), {
              code: 'WORKSPACE_INVALIDATED',
            });
          }
        },
        requestDecision: renderLegacyClaimOffer,
      });
      return legacyClaimFlow.migrate({ workspaceId, session });
    },
    hydrate: async ({ workspaceId, boot, hydrationStorage, writeHydration, catalog }) => {
      const auxiliary = projectWorkspaceAuxiliaryState(
        hydrationStorage.getItem(STORAGE_KEY),
      );
      const hydration = await hydrateWorkspaceSnapshot(practiceConnection, {
        workspaceId,
        assertActive: id => {
          const current = boot.snapshot();
          if (current.workspaceId !== id || !['opening-storage', 'migrating'].includes(current.state)) {
            throw new Error('workspace hydration was invalidated');
          }
        },
      });
      return {
        snapshot: hydration,
        ...applyHydratedWorkspace(
          hydration,
          auxiliary,
          hydrationStorage.getItem(DAILY_KEY) != null,
          writeHydration,
          catalog,
          hydrationStorage,
        ),
      };
    },
    onState: snapshot => renderWorkspaceBoot(snapshot, bootDiagnostics({ details: snapshot.details })),
  });
  if (bootResult.status !== 'ready') {
    legacyClaimFlow?.invalidate();
    practiceConnection?.close();
    renderWorkspaceBoot(bootResult.boot.snapshot(), bootDiagnostics({
      details: bootResult.boot.snapshot().details, error: bootResult.error,
    }));
    return;
  }
  workspaceStorage = bootResult.storage;
  const storage = requireWorkspaceStorage();
  await showLegacyMigrationSummary(bootResult.migration?.summary);
  initDailyLog(state.progress, storage);

  // streak 結算必須在 hydration 後、任何主畫面 render 前完成。
  const settleEvent = settleStreakOnOpen(undefined, storage);
  if (settleEvent.type === 'protected') {
    showToast(`昨天沒開，用掉 ${settleEvent.spent} 個安神保護幫你保住連續天數`);
  }
  state.lessons = bootResult.catalog.lessons;

  // ledger 這一側：確認 catalog fence、把 IDB 投影鏡射回本機。整段 fail-open——
  // 失敗只代表這次開機不開放 ledger 評分，畫面與 legacy 評分完全不受影響（R14）。
  practiceLedger = await startPracticeLedgerRuntime({
    connection: practiceConnection,
    workspaceId: bootResult.workspaceId,
    catalog: bootResult.catalog,
    projections: bootResult.hydration?.snapshot?.projections || null,
    storage,
    legacyProgress: state.progress,
    loadLineageEvidence: async () => {
      const lineageEvidence = await fetchProductionLineageEvidence();
      return { lineageEvidence, trustedRevisionManifest: TRUSTED_PRODUCTION_LINEAGE };
    },
    assertActive: id => {
      const current = workspaceBoot.snapshot();
      if (current.workspaceId !== id) {
        throw Object.assign(new Error('practice ledger workspace is stale'), {
          code: 'WORKSPACE_INVALIDATED',
        });
      }
    },
  });

  practiceLedgerWorkspaceId = bootResult.workspaceId;
  practiceResetPort = practiceLedger.port || (practiceConnection
    ? createPracticeTransactionPort(practiceConnection, {
      workspaceId: bootResult.workspaceId,
      assertActive: id => {
        if (id !== bootResult.workspaceId) {
          throw Object.assign(new Error('practice reset workspace is stale'), {
            code: 'WORKSPACE_INVALIDATED',
          });
        }
      },
    })
    : null);
  /* 這一條要接在 status === 'ready' 的判斷外面。別台裝置按的重置會透過 epoch
     傳過來，而那時本機的 ledger runtime 可能根本沒起來——IDB 裡的權威列還是得清。 */
  setRemoteResetHook(resetLedgerAuthorityOrThrow);
  if (practiceLedger.status === 'ready') {
    const cardKeyById = catalogCardKeyIndex(bootResult.catalog);
    ledgerSession = createLedgerGradeSession({
      ledger: practiceLedger,
      cardKeyById,
      storage,
      deviceId: getOrCreateWorkspaceInstallationId(storage, () => crypto.randomUUID()),
      createId: () => crypto.randomUUID(),
      readContext: () => {
        const card = filteredCards()[state.cardIndex];
        const key = card ? (card._cardKey || cardKey(card)) : '';
        return {
          workspaceId: bootResult.workspaceId,
          workspaceGeneration: workspaceBoot.snapshot().epoch,
          currentLessonId: state.currentLessonId,
          mode: state.mode,
          dayKey: localDateKey(),
          cardId: card?.card_id || card?.cardId || key,
          cardKey: key,
          card,
          todayLaneByCardKey: state.dailyQueueLaneByCardKey || new Map(),
          // 本輪只接 __TODAY__（lane 來自佇列快照），走不到這個欄位；
          // __ALL__ 接上時這裡要換成 IDB 的權威 SRS，理由見 practice-grade-session.js。
          authoritativeSrs: { status: 'not-ready', state: null },
        };
      },
      advance: result => {
        // KTD11：after-state 已經在交易裡算過一次，這裡只鏡射，不重算。
        // 非正式評分沒有 after-state，照 R5 完全不動 legacy 的排程。
        const card = filteredCards()[state.cardIndex];
        const key = card ? (card._cardKey || cardKey(card)) : '';
        if (result?.srs) setGradeFromLedger(card, result.srs, storage);
        afterGradeAdvance(storage, key, false);
      },
      onStateChange: ({ status }) => { renderLedgerSavingState(status); },
      /* 用 runtime 交出來的那份，不是開機前的 hydration 快照。baseline 與採納都是在
         hydration 之後才寫進 IDB 的——拿快照的話，卡片被 seed 的那一輪逐卡閘門會
         判定「沒有權威列但本機有進度」而退回 legacy，然後 localStorage 就比 IDB 新，
         那張卡從此再也回不了帳本。 */
      authoritativeSrsRows: practiceLedger.authoritativeSrs
        ?? bootResult.hydration?.snapshot?.srs
        ?? null,
    });
    // 遠端進度併進來 = 底下的到期狀態變了，讓還在路上的評分失效。
    setRemoteProgressHook(() => ledgerSession?.bumpContextEpoch());
  }

  const deepLink = parseDeepLinkParam();
  const today = localDateKey();
  state.lastOpenDate = today;

  if (deepLink && state.lessons.find(l => l.id === deepLink.lessonId)) {
    // 來自通知的深連結：強制切到那堂課、用字卡 mode 開、關掉 SRS 篩選，
    // 這樣待會才能在 lesson.cards 原始順序裡穩定找到那句話的 index。
    state.currentLessonId = deepLink.lessonId;
    state.mode = 'card';
    state.srsToggle = false;
  } else {
    if (!state.currentLessonId ||
        (state.currentLessonId !== '__ALL__' && !state.lessons.find(l => l.id === state.currentLessonId))) {
      state.currentLessonId = state.lessons[0]?.id || null;
    }
    // 打開一律落在「今日」（2026-08-22 Nalin 指定）。原本是「每天第一次落練功、
    // 同一天內記住上次 mode」，練功併進今日後這個分頁就是每天的起點。
    state.mode = 'today';
  }
  saveState(storage);

  // 跨課程操作前再次確認 catalog 已完整採用。
  await ensureCatalogReady();

  // 今日分頁的三局遊戲要最新一堂課的卡片，不一定跟目前選中的課程是同一堂
  if (state.mode === 'today') {
    const newest = state.lessons[state.lessons.length - 1];
    if (newest) await ensureCatalogReady();
  }

  if (deepLink) {
    const idx = filteredCards().findIndex(c => c.thai === deepLink.thai);
    if (idx >= 0) { state.cardIndex = idx; state.flipped = false; }
    clearDeepLinkParam();
  }

  // 防止舊 cardIndex 在課程更新後越界
  const _initCards = filteredCards();
  if (_initCards.length && state.cardIndex >= _initCards.length) state.cardIndex = 0;

  rerender(storage);

  if (state.mode === 'lists' || state.mode === 'dialog' || state.mode === 'today') {
    await ensureAllLoaded();
    rerender(storage);
  }

  // 跨裝置同步：登入導回來要先把 ?code= 換成 session，再拉一次雲端進度。
  // 整段不 await 進主流程——同步慢或失敗都不能拖住 App 開機。
  void (async () => {
    await cloudAuth.consumeRedirect();
    void updateCloudHint(storage);
    if (!cloudAuth.hasStoredSession()) return;
    const r = await syncNow(storage);
    if (r?.pulled) { rerender(storage); void updateCloudHint(storage); }
  })();

  // 模式切換
  syncModeButtons();

  document.querySelectorAll('.mode-tab,.mp-btn').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.mode, storage))
  );
  document.querySelectorAll('[data-drawer-mode]').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.drawerMode, storage))
  );
  document.querySelectorAll('[data-drawer-list-order]').forEach(b =>
    b.addEventListener('click', () => selectListMode(b.dataset.drawerListOrder, storage))
  );
  document.querySelectorAll('[data-mobile-mode]').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.mobileMode, storage))
  );

  // Topbar 按鈕
  document.getElementById('btnFavPanel')?.addEventListener('click', () => selectLesson('__FAV__', storage));
  document.querySelector('[data-mobile-fav-button]')?.addEventListener('click', () => selectLesson('__FAV__', storage));
  document.querySelectorAll('[data-list-order-button]').forEach(b =>
    b.addEventListener('click', () => selectListMode(b.dataset.listOrderButton, storage))
  );
  document.getElementById('btnMenu').addEventListener('click', openDrawer);
  document.getElementById('drawerMask').addEventListener('click', closeDrawer);
  document.getElementById('btnSettings').addEventListener('click', () => {
    openModal();
    updateSyncHint();
    void updateRuntimeHint();
  });
  document.getElementById('btnSearch').addEventListener('click', async () => {
    openSearch();
    // 搜尋要跨全部課程，先補抓
    await ensureAllLoaded();
    // 重畫側邊看有沒有載入新的
    renderSidebar(id => selectLesson(id, storage), storage);
  });
  document.getElementById('btnCloseSearch').addEventListener('click', closeSearch);
  document.getElementById('searchMask').addEventListener('click', e => {
    if (e.target.id === 'searchMask') closeSearch();
  });
  document.getElementById('btnCloseEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnCancelEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnSaveEdit').addEventListener('click', () => saveEditModal(storage));
  document.getElementById('btnClearEdit').addEventListener('click', () => clearEditModal(storage));
  document.getElementById('editMask').addEventListener('click', e => {
    if (e.target.id === 'editMask') closeEditModal();
  });
  document.getElementById('inpSearch').addEventListener('input', e => {
    renderSearchResults(e.target.value, match => onSearchPick(match, storage));
  });
  document.getElementById('btnShuffle').addEventListener('click', () => {
    stopListen();
    shuffleCurrentLesson();
    rerender(storage);
    flashShuffle();
  });
  document.getElementById('btnCloseModal').addEventListener('click', closeModal);
  document.getElementById('modalMask').addEventListener('click', e => {
    if (e.target.id === 'modalMask') closeModal();
  });

  // 設定 segmented controls
  wireSegClick('#segRate', b => { state.settings.rate = Number(b.dataset.rate); });
  wireSegClick('#segRepeat', b => { state.settings.repeat = Number(b.dataset.repeat); });
  wireSegClick('#segGap', b => {
    state.settings.gap = b.dataset.gap === 'auto' ? 'auto' : Number(b.dataset.gap);
  });
  wireSegClick('#segVoiceProvider', b => { state.settings.voiceProvider = b.dataset.voiceProvider; });
  wireSegClick('#segTheme', b => {
    state.settings.theme = b.dataset.theme;
    applyTheme();
  });

  // 儲存設定
  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    /* 守衛要排在任何寫入之前。放在 if (inputChanged) 裡面的話：URL 沒改的常見情況
       整段跳過，直接落到 closeModal() + rerender()（那個 rerender 會擦掉失敗狀態的
       出路）；而且 sheetInput 早就寫進去又存檔了，第二次點 inputChanged 變 false，
       使用者會拿到「URL 換好了」的假象、資料其實還是舊的。 */
    if (ledgerSession?.controller.isLocked()) {
      alert('這筆評分還在存檔，等它完成再改設定。');
      return;
    }
    const newInput = document.getElementById('inpSheet').value.trim();
    const inputChanged = newInput !== state.settings.sheetInput;
    const oldInput = state.settings.sheetInput;
    state.settings.sheetInput = newInput;
    saveState(storage);
    if (inputChanged) {
      const btn = document.getElementById('btnSaveSettings');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '同步中…';
      try {
        showLoading('正在從 Google Sheets 抓課程列表…');
        // 先 fetch，成功才動 cache（避免抓壞時兩邊都沒了）
        const fresh = await loadLessonsSmart({ force: true, runtimeStorage: storage });
        if (!fresh || !fresh.length) throw new Error('沒抓到課程');
        // 完整 catalog 驗證成功後，loadLessonsSmart 才會更新新版 cache。
        state.lessons = fresh;
        state.currentLessonId = state.lessons[0]?.id || null;
        state.cardIndex = 0;
        state.flipped = false;
        await ensureCatalogReady();
        setLastSync(newInput || DEFAULT_SHEET_URL);
      } catch (e) {
        console.warn('URL 變更後重抓失敗：', e);
        alert('抓不到 Sheet：' + e.message + '\n\nURL 已存，但資料還是舊的。');
        // 把 settings 回滾，避免下次又走 inputChanged 分支
        state.settings.sheetInput = oldInput;
        saveState(storage);
        document.getElementById('inpSheet').value = oldInput;
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
    closeModal();
    rerender(storage);
  });

  // 重置進度
  /* 重置進度：登入後這個動作會擴散到所有裝置，所以照 Nalin 定過的破壞性操作
     防呆走——執行前揭露影響數量、要打字確認、紅色警示，不是一個 confirm 了事。 */
  document.getElementById('btnResetProgress').addEventListener('click', async () => {
    const count = Object.keys(state.progress).length;
    document.getElementById('resetCount').textContent = count;
    const loggedIn = !!await cloudAuth.getSession();
    document.getElementById('resetScope').innerHTML = loggedIn
      ? '<strong class="danger-num">所有已登入的裝置</strong>（手機、平板、電腦）都會一起清空。'
      : '只清除這台裝置（目前未登入，不會影響其他裝置）。';
    const input = document.getElementById('resetConfirmInput');
    const confirmBtn = document.getElementById('btnConfirmReset');
    input.value = '';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '確定重置';
    document.getElementById('resetMask').classList.add('open');
    input.focus();
  });

  document.getElementById('resetConfirmInput')?.addEventListener('input', e => {
    document.getElementById('btnConfirmReset').disabled = e.target.value.trim() !== '重置進度';
  });

  const closeResetModal = () => document.getElementById('resetMask')?.classList.remove('open');
  document.getElementById('btnCloseReset')?.addEventListener('click', closeResetModal);
  document.getElementById('btnCancelReset')?.addEventListener('click', closeResetModal);

  document.getElementById('btnConfirmReset')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '重置中…';

    // 先標記雲端，再清本機：順序反過來的話，中途失敗會變成「本機清了、
    // 雲端沒清」，下次同步又把資料拉回來，使用者會以為重置沒生效。
    if (cloudAuth.hasStoredSession()) {
      try {
        await resetProgressEverywhere(storage);
      } catch (err) {
        btn.textContent = '確定重置';
        btn.disabled = false;
        alert(`雲端重置失敗，本機也沒有清除（避免兩邊不一致）。\n${err.message}`);
        return;
      }
    }

    // 先清 IDB 的權威 SRS，再清本機鏡射。順序反過來的話，中途失敗或當掉，下次在
    // Today 評分時 getSrs() 會讀到重置前那列，排程直接跳回重置前，而且會以新的
    // updatedAt 通過 epoch 過濾推上雲端——重置等於沒發生。
    /* 清不掉就整個中止。以前這裡守在 ledger runtime 的 port 上，runtime 沒起來就
       靜默跳過，本機清了、IDB 沒清；下次評分 getSrs() 讀到重置前那列，排程跳回去
       還會推上雲端，重置等於沒發生。 */
    try {
      await resetLedgerAuthorityOrThrow();
    } catch (err) {
      btn.textContent = '確定重置';
      btn.disabled = false;
      alert(`帳本重置失敗，本機也沒有清除（避免兩邊不一致）。\n${err.message}`);
      return;
    }

    state.progress = {};
    saveState(storage);
    closeResetModal();
    renderStats();
    renderContent(() => rerender(storage), storage);
    void updateCloudHint(storage);
  });

  // 跨裝置同步：登入 / 登出，以及登入狀態下手動觸發一次同步
  document.getElementById('btnCloudAuth')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    if (btn.dataset.cloudAction === 'logout') {
      if (!confirm('登出後這台裝置就不再同步（本機已有的紀錄不會被刪）。確定登出？')) return;
      btn.disabled = true;
      try {
        await logoutToAnonymous({
          deviceId: getDeviceId(),
          invalidate: () => {
            legacyClaimFlow?.invalidate();
            invalidateSync();
          },
          clearAuth: cloudAuth.logout,
          cleanup: () => {
            // Auth 清除成功後才清掉帳號 workspace 的同步衍生狀態。
            clearSyncState(storage);
            practiceConnection?.close();
          },
          activate: () => {},
          reload: () => location.reload(),
        });
      } catch (error) {
        btn.disabled = false;
        alert(`登出失敗，仍保留目前帳號資料。\n${error.message}`);
      }
      return;
    }
    await cloudAuth.login();   // 會整頁跳轉去 Google
  });

  // 手動同步（登入後點狀態列就跑一次，離線或自動同步出問題時的逃生口）
  document.getElementById('cloudStatus')?.addEventListener('click', async () => {
    const hint = document.getElementById('cloudHint');
    if (!await cloudAuth.getSession()) return;
    if (hint) hint.textContent = '同步中…';
    const r = await syncNow(storage);
    if (hint) {
      hint.textContent = r
        ? `同步完成：收到 ${r.pulled} 筆、送出 ${r.pushed} 筆`
        : '同步失敗，稍後會自動重試。';
    }
    if (r?.pulled) rerender(storage);
  });

  // 重新同步 Sheet：先抓再覆蓋；失敗保留舊資料；連點防呆
  document.getElementById('btnClearCache').addEventListener('click', async () => {
    const btn = document.getElementById('btnClearCache');
    if (btn.disabled) return;
    if (!confirm('重新從 Google Sheet 抓最新資料？（進度跟收藏不會動）')) return;

    /* 這兩支重抓 Sheet 的按鈕都在設定 modal 裡，掛在 topbar 上，#content 的 click
       鎖與鍵盤鎖都蓋不到，而它們會換掉 state.lessons 與 currentLessonId——`__TODAY__`
       是虛擬課號、永遠不在 state.lessons 裡，所以那個 fallback if 必定成立。
       saving 期間讓它跑，交易落地後 operation token 對不上，那筆評分只會留在 IDB。 */
    if (ledgerSession?.controller.isLocked()) return;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中…';
    const url = state.settings.sheetInput || DEFAULT_SHEET_URL;

    try {
      showLoading('重新抓課程列表…');
      const fresh = await loadLessonsSmart({ force: true, runtimeStorage: storage });
      if (!fresh || !fresh.length) throw new Error('沒抓到課程');

      state.lessons = fresh;
      if (!state.lessons.find(l => l.id === state.currentLessonId) &&
          state.currentLessonId !== '__ALL__' && state.currentLessonId !== '__FAV__') {
        state.currentLessonId = state.lessons[0]?.id || null;
        state.cardIndex = 0;
      }

      const cur = state.lessons.find(l => l.id === state.currentLessonId);
      if (cur) showLoading(`同步「${cur.title}」…`);
      await ensureCatalogReady();

      setLastSync(url);
      updateSyncHint();
      closeModal();
      rerender(storage);
    } catch (e) {
      console.warn('重新同步失敗：', e);
      alert('抓不到 Sheet：' + e.message + '\n\n先用舊資料繼續。');
      rerender(storage);   // 把 showLoading 蓋掉的內容還原成舊資料
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // 鍵盤快捷鍵
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('editMask').classList.contains('open')) {
      closeEditModal();
      return;
    }
    // Esc 關搜尋（搜尋 modal 內也要能關）
    if (e.key === 'Escape' && document.getElementById('searchMask').classList.contains('open')) {
      closeSearch();
      return;
    }
    if (document.getElementById('modalMask').classList.contains('open')) return;
    if (document.getElementById('searchMask').classList.contains('open')) return;
    if (document.getElementById('editMask').classList.contains('open')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    /* saving／失敗期間鍵盤一律不放行，一道蓋住整個 handler。方向鍵、`/` 開搜尋、
       listen mode 的前後首都算 context mutation：換了卡片之後交易回來會因為
       operation token 對不上而整筆丟掉，那筆評分在 IDB 裡但本機完全不知道（AE7）。
       重試不受影響——它是 click（含鍵盤觸發的 click），走 #content 的 retry 分支。 */
    if (ledgerSession?.controller.isLocked()) return;

    // / 開搜尋
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('btnSearch').click();
      return;
    }

    if (state.mode === 'listen') {
      if (e.key === 'ArrowLeft') { stopListen(); prevCard(storage); }
      else if (e.key === 'ArrowRight') { stopListen(); nextCard(storage); }
      else if (e.code === 'Space') {
        e.preventDefault();
        import('./listen.js').then(m => m.toggleListen());
      }
      return;
    }

    // 今日 / 練功 mode 沒有當前卡片，卡片快捷鍵（翻面 / 評分 / 換卡）不適用
    if (state.mode === 'today') return;

    if (e.key === 'ArrowLeft') prevCard(storage);
    else if (e.key === 'ArrowRight') nextCard(storage);
    else if (e.code === 'Space') {
      e.preventDefault();
      state.flipped = !state.flipped;
      document.getElementById('cardStage')?.classList.toggle('flipped', state.flipped);
    } else if (e.key === '1') { gradeAndAdvance('again', storage); }
    else if (e.key === '2') { gradeAndAdvance('hard', storage); }
    else if (e.key === '3') { gradeAndAdvance('good', storage); }
    else if (e.key === '4') { gradeAndAdvance('easy', storage); }
    else if (e.key === 'p' || e.key === 'P') {
      const cards = filteredCards();
      if (cards[state.cardIndex]) speakCard(cards[state.cardIndex]);
    }
    else if (e.key === 's' || e.key === 'S') {
      shuffleCurrentLesson();
      rerender(storage);
      flashShuffle();
    }
  });

  // 字卡頁的上一張 / 下一張 + 評分鈕（事件委派，每次 re-render 都有效）
  document.getElementById('content').addEventListener('click', e => {
    /* 這兩道要排在所有其他 handler 前面。底下有換卡（data-jump-card）、切 mode
       （data-mode-back-to-card）之類會動 context 的分支，排在鎖後面等於沒鎖：
       交易還在路上時把卡片換掉，回來的結果就套到別張卡上了（AE7）。 */
    if (e.target.closest('[data-ledger-retry]')) {
      e.stopPropagation();
      void retryLedgerAction();
      return;
    }
    if (ledgerSession?.controller.isLocked()) { e.stopPropagation(); return; }
    if (e.target.closest('[data-lesson-map-jump]')) {
      e.stopPropagation();
      const lessonId = e.target.closest('[data-lesson-map-jump]').dataset.lessonMapJump;
      state.mode = 'card';
      syncModeButtons('card');
      selectLesson(lessonId, storage);
      return;
    }
    if (e.target.closest('[data-start-review-all]')) {
      e.stopPropagation();
      const log = loadDailyLog(storage);
      const todaySeconds = log.days[localDateKey()]?.seconds || 0;
      const { cards, resweepKeys, laneByCardKey } = buildDailyQueue(
        allCardsWithLessonId(), state.progress, state.lessons, todaySeconds, storage,
      );
      setDailyQueue(cards, resweepKeys, laneByCardKey);
      // 新的一輪佇列＝新的 round，同時讓還在路上的評分失效（它的 lane 快照已經舊了）。
      ledgerSession?.startRound();
      state.currentLessonId = '__TODAY__';
      state.mode = 'srs';
      state.cardIndex = 0;
      state.flipped = false;
      stopListen();
      saveState(storage);
      syncModeButtons('srs');
      rerender(storage);
      return;
    }
    if (e.target.closest('[data-start-review]')) {
      e.stopPropagation();
      state.mode = 'srs';
      state.cardIndex = 0;
      state.flipped = false;
      stopListen();
      saveState(storage);
      syncModeButtons('srs');
      rerender(storage);
      return;
    }
    if (e.target.closest('[data-mode-back-to-card]')) {
      e.stopPropagation();
      state.mode = 'card';
      state.cardIndex = 0;
      state.flipped = false;
      saveState(storage);
      syncModeButtons('card');
      rerender(storage);
      return;
    }
    const editBtn = e.target.closest('[data-edit-card-key]');
    if (editBtn) {
      e.stopPropagation();
      openEditModal(editBtn.dataset.editCardKey);
      return;
    }
    const jumpBtn = e.target.closest('[data-jump-card]');
    if (jumpBtn) {
      e.stopPropagation();
      jumpToCard(jumpBtn.dataset.jumpCard, storage);
      return;
    }
    const listFilter = e.target.closest('[data-list-filter]');
    if (listFilter) {
      e.stopPropagation();
      state.listFilter = listFilter.dataset.listFilter;
      saveState(storage);
      renderContent(() => rerender(storage), storage);
      return;
    }
    const listLesson = e.target.closest('[data-list-lesson]');
    if (listLesson) {
      e.stopPropagation();
      state.listLessonId = listLesson.dataset.listLesson;
      saveState(storage);
      renderContent(() => rerender(storage), storage);
      return;
    }
    if (e.target.closest('#cardPrev')) { e.stopPropagation(); prevCard(storage); return; }
    if (e.target.closest('#cardNext')) { e.stopPropagation(); nextCard(storage); return; }
    const grade = e.target.closest('.pill[data-grade]');
    if (grade) {
      e.stopPropagation();
      gradeAndAdvance(grade.dataset.grade, storage);
    }
  });

  // SRS toggle 切換（card / reverse mode 才會 render 出 #srsToggle）
  document.getElementById('content').addEventListener('change', e => {
    /* 目前整個 repo 都沒有地方 render 出 #srsToggle，所以這支實際上不會被觸發。
       還是補上鎖：它會動 cardIndex，哪天元素回來了守衛就已經在對的位置。 */
    if (ledgerSession?.controller.isLocked()) return;
    if (e.target?.id === 'srsToggle') {
      state.srsToggle = e.target.checked;
      state.cardIndex = 0;
      state.flipped = false;
      rerender(storage);
    }
  });

  // 滑動手勢（content 區內左右滑切卡）
  let tx = 0, ty = 0;
  const contentEl = document.getElementById('content');
  contentEl.addEventListener('touchstart', e => {
    const t = e.touches[0];
    tx = t.clientX; ty = t.clientY;
  }, { passive: true });
  contentEl.addEventListener('touchend', e => {
    /* 手機的主要換卡方式。這裡少一道鎖的話，saving／失敗期間滑一下就換卡，
       底下那個 state.mode === 'today' 擋不到——帳本跑在 currentLessonId
       === '__TODAY__'，而那時 mode 是 srs／cards。 */
    if (ledgerSession?.controller.isLocked()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - tx;
    const dy = t.clientY - ty;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (state.mode === 'today') return;   // 今日 mode 沒有卡片可滑
      if (state.mode === 'listen') stopListen();
      if (dx > 0) prevCard(storage); else nextCard(storage);
    }
  }, { passive: true });

  // 預熱 TTS voices
  warmupVoices();

  // 今日累積時間：每 15 秒記一次，分頁在背景時跳過。最多掉尾數 15 秒，
  // 換掉整套 flush-on-unload 邏輯，划算（只記錄不設目標，見設計書 3 節）。
  // 順便節流同步給 22:00 推播用（docs/mastery-sprint-plan-2026-08.md
  // 「即時進度推播」），同步失敗不影響複習，syncProgressThrottled 內部靜默吞錯。
  setInterval(() => {
    if (document.hidden) return;
    addActiveSeconds(15, Date.now(), storage);
    syncProgressThrottled(loadDailyLog(storage).days[localDateKey()]?.seconds || 0);
    // 跨裝置同步（登入才會真的動作，內部節流 2 分鐘一次）
    if (cloudAuth.hasStoredSession()) syncThrottled(storage);
  }, 15000);

  // 背景化/關頁時補送最後一筆進度（sendBeacon，比一般 fetch 更能在背景存活）。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    syncProgressOnHide(loadDailyLog(storage).days[localDateKey()]?.seconds || 0);
    // 切走前把還沒推上去的評分補送（keepalive，分頁關掉也送得完）。
    // 不用 syncNow()：那是一般 fetch，分頁一關就被瀏覽器砍掉。
    if (cloudAuth.hasStoredSession()) flushOnHide(storage);
  });

  // 完成一局遊戲也會產生要同步的資料（games / gameIds / 補救蓋章），
  // 用 hook 通知，避免 today.js 反向 import cloud-sync 造成循環相依。
  setLogChangeHook(changedStorage => {
    if (cloudAuth.hasStoredSession()) syncSoon(changedStorage);
  });

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW register failed:', e));
    // 新版 SW 接管時自動重載，Android PWA 常駐背景才不會一直跑舊版 code。
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // 首次安裝不重載
      location.reload();
    });
  }

  // 設定裡顯示目前 runtime 版本；點版本資訊展開聽力鏈除錯紀錄
  void updateRuntimeHint();
  document.getElementById('appVersionHint')?.addEventListener('click', () => {
    const pre = document.getElementById('listenLogView');
    if (!pre) return;
    const show = pre.style.display === 'none';
    if (show) pre.textContent = getListenLog().join('\n') || '（沒有紀錄）';
    pre.style.display = show ? 'block' : 'none';
  });
}

init();
