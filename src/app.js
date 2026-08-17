/* 入口：init → 載入狀態 → 抓資料 → 綁事件。 */

import {
  state, loadState, saveState,
  DEMO_LESSONS, DEFAULT_SHEET_URL,
  filteredCards, setGrade, shuffleCurrentLesson, isSrsActive,
  saveLessonsCache, loadLessonsCache, clearLessonsCache,
  loadManifest, saveManifest, loadLessonCards, saveLessonCards,
  setLastSync, getLastSync, formatLastSync,
  findCardByKey, saveCardEdit, clearCardEdit,
} from './state.js';
import { loadLessons, loadTabsOnly, fetchLessonCards, loadFromBundledJson } from './data.js';
import { initDailyLog, logReview, buildAchievementCtx, notifyAchievements } from './today.js';
import { checkAndUnlock } from './achievements.js';
import { getListenLog, speakCard, warmupVoices } from './tts.js';
import { stopListen } from './listen.js';
import {
  renderSidebar, renderTopbarTitle, renderStats, renderContent,
  openDrawer, closeDrawer, openModal, closeModal, applyTheme,
  openSearch, closeSearch, renderSearchResults,
} from './ui.js';

async function fetchFromNetwork(url, { force = false } = {}) {
  try {
    const lessons = await loadLessons(url, { force });
    if (lessons && lessons.length) return lessons;
    // 空回應時：force 路徑視為失敗讓上層 catch；非 force 才靜默
    if (force) throw new Error('回應為空');
  } catch (e) {
    console.warn('資料載入失敗：', e.message);
    if (force) throw e;
    if (state.settings.sheetInput) alert('資料載入失敗：' + e.message);
  }
  return null;
}

/* 舊版 eager cache（給單一 CSV / 多 CSV 模式用，沒 tab 概念無法 lazy）。 */
async function loadLessonsCacheFirstEager(onFreshData, { force = false } = {}) {
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  const cached = force ? null : loadLessonsCache(url);

  const revalidate = (async () => {
    const fresh = await fetchFromNetwork(url, { force });
    if (fresh) {
      saveLessonsCache(url, fresh);
      onFreshData?.(fresh);
    }
    return fresh;
  })();

  if (cached) return cached.lessons;
  const fresh = await revalidate;
  return fresh || DEMO_LESSONS;
}

/* ===== Lazy 載入（publish-to-web 模式） =====
   先抓 manifest（tab 列表），每堂卡片按需抓並各自 cache。 */

function buildLessonsFromManifest(manifest) {
  state.baseUrl = manifest.baseUrl;
  return manifest.tabs.map(t => {
    const cards = loadLessonCards(t.gid) || [];
    return {
      id: 'gid-' + t.gid,
      gid: t.gid,
      title: t.name || t.title || ('gid-' + t.gid),  // parsePubTabs 回傳 name
      cards,
      _loaded: cards.length > 0,
    };
  });
}

async function loadLessonsLazy(url, onFreshManifest, { force = false } = {}) {
  let manifest = force ? null : loadManifest(url);

  if (!manifest) {
    const m = await loadTabsOnly(url, { force });
    if (!m) throw new Error('no-manifest');
    manifest = { url, ts: Date.now(), ...m };
    saveManifest(url, m);
  } else {
    // 背景 revalidate manifest（只抓小小的 pubhtml，便宜）
    (async () => {
      try {
        const fresh = await loadTabsOnly(url);
        if (!fresh) return;
        const changed = JSON.stringify(fresh.tabs) !== JSON.stringify(manifest.tabs);
        if (changed) {
          saveManifest(url, fresh);
          onFreshManifest?.(fresh);
        }
      } catch {}
    })();
  }

  return buildLessonsFromManifest(manifest);
}

function onFreshManifest(fresh) {
  state.baseUrl = fresh.baseUrl;
  const newLessons = buildLessonsFromManifest(fresh);
  const sameStructure = newLessons.length === state.lessons.length
    && newLessons.every((l, i) => l.id === state.lessons[i]?.id);
  state.lessons = newLessons;
  if (!sameStructure) {
    state.currentLessonId = newLessons[0]?.id || null;
    state.cardIndex = 0;
    state.flipped = false;
  }
  rerender();
}

/* 確保單堂課的 cards 已載入；未載入就抓並 cache。 */
async function ensureLessonLoaded(lessonId, { silentUI = false, force = false } = {}) {
  // 全部混合、收藏、搜尋都需要所有課都載入過才有完整結果
  if (lessonId === '__ALL__' || lessonId === '__FAV__' || lessonId === '__SEARCH__') {
    return ensureAllLoaded({ force });
  }
  const lesson = state.lessons.find(l => l.id === lessonId);
  if (!lesson || (!force && lesson._loaded) || !lesson.gid || !state.baseUrl) return;

  if (!silentUI) showLoading(`載入「${lesson.title}」…`);
  try {
    lesson.cards = await fetchLessonCards(state.baseUrl, lesson.gid, {
      force,
      id: lesson.id,
      title: lesson.title,
    });
    lesson._loaded = true;
    saveLessonCards(lesson.gid, lesson.cards);
  } catch (e) {
    console.warn('lesson load failed:', lesson.title, e.message);
    alert('載入失敗：' + e.message);
  }
}

/* 全部混合：把還沒抓過的課程全部補抓（並行）。 */
async function ensureAllLoaded({ force = false } = {}) {
  const todo = state.lessons.filter(l => (force || !l._loaded) && l.gid && state.baseUrl);
  if (!todo.length) return;
  showLoading(`正在補抓 ${todo.length} 堂未載入的課程…`);
  await Promise.allSettled(todo.map(async l => {
    try {
      l.cards = await fetchLessonCards(state.baseUrl, l.gid, {
        force,
        id: l.id,
        title: l.title,
      });
      l._loaded = true;
      saveLessonCards(l.gid, l.cards);
    } catch (e) {
      console.warn('lesson load failed:', l.title, e.message);
    }
  }));
}

/* 主進入點：
   1. 預設 Sheet + 非 force → 直接讀同源 ./data.json（GitHub Action 預生成，< 50ms）
   2. 預設 Sheet + force（重新同步）→ 走 live publish-to-web（保留現有行為）
   3. 自訂 sheet URL → 永遠走 live（不影響使用者貼自己的 Sheet） */
async function loadLessonsSmart(onFresh, { force = false } = {}) {
  const customInput = (state.settings.sheetInput || '').trim();
  const url = customInput || DEFAULT_SHEET_URL;

  // 預設 Sheet + 非 force → 試 bundled JSON
  if (!customInput && !force) {
    try {
      const lessons = await loadFromBundledJson();
      // 同 lazy 模式格式：補上 _loaded=true（cards 已內含）+ baseUrl 用來提供「重新同步」走 live
      state.baseUrl = DEFAULT_SHEET_URL.replace(/\/pub(html)?$/, '');
      return lessons.map((l) => ({ ...l, _loaded: true }));
    } catch (e) {
      console.warn('bundled JSON 讀取失敗，退回 live fetch：', e.message);
    }
  }

  try {
    return await loadLessonsLazy(url, onFresh, { force });
  } catch (e) {
    if (e.message !== 'no-manifest') console.warn('lazy failed:', e.message);
    return await loadLessonsCacheFirstEager(onFresh, { force });
  }
}

function rerender() {
  renderSidebar(selectLesson);
  renderTopbarTitle();
  renderContent(rerender);
  renderStats();
}

function onSearchPick(match) {
  // 跳到該卡：切到對應課程、cardIndex、並切回字卡模式
  state.currentLessonId = match.lessonId;
  state.cardIndex = match.index;
  state.flipped = false;
  if (state.mode === 'listen' || state.mode === 'dialog' || state.mode === 'lists') state.mode = 'card';
  stopListen();
  saveState();
  syncModeButtons();
  closeSearch();
  rerender();
}

function syncModeButtons(m = state.mode) {
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('.mp-btn').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('[data-drawer-mode]').forEach(t => t.classList.toggle('active', t.dataset.drawerMode === m));
}

async function selectLesson(id) {
  state.currentLessonId = id;
  state.cardIndex = 0;
  state.flipped = false;
  stopListen();
  saveState();
  closeDrawer();
  rerender();
  // 抓不到已載入的 cards 就即時載入（lazy 模式）
  await ensureLessonLoaded(id);
  rerender();
}

async function selectMode(m) {
  state.mode = m;
  state.flipped = false;
  stopListen();
  syncModeButtons(m);
  saveState();
  renderContent(rerender);
  renderStats();
  if (m === 'lists' || m === 'dialog' || m === 'today') {
    await ensureAllLoaded();
    rerender();
  }
}

async function selectListMode(order) {
  const enteringLists = state.mode !== 'lists';
  state.listOrder = order === 'zh' ? 'zh' : 'thai';
  if (enteringLists) state.listFilter = 'all';
  await selectMode('lists');
  closeDrawer();
}

function nextCard() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex + 1) % cards.length;
  state.flipped = false;
  saveState();
  renderContent(rerender);
}

/* 評分後的行為：
   - SRS active：剛評的那張 nextReviewAt > now → 從 due 列表消失，cardIndex 不變但 list 變短，
     直接 rerender 自然指到下一張；clamp 防越界
   - 一般 mode：cards 不變，往下一張前進 */
function gradeAndAdvance(g) {
  setGrade(state.cardIndex, g);
  logReview(g);
  const achvCtx = buildAchievementCtx();
  notifyAchievements(checkAndUnlock(achvCtx), achvCtx);
  state.flipped = false;
  if (isSrsActive()) {
    const cards = filteredCards();
    if (state.cardIndex >= cards.length) state.cardIndex = Math.max(0, cards.length - 1);
    saveState();
    rerender();
  } else {
    nextCard();
    // 評分會影響側邊欄徽章，補一次 sidebar render
    renderSidebar(selectLesson);
    renderTopbarTitle();
  }
}

function prevCard() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;
  state.flipped = false;
  saveState();
  renderContent(rerender);
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

function saveEditModal() {
  const key = document.getElementById('editCardKey').value;
  const found = findCardByKey(key);
  if (!found) return closeEditModal();
  saveCardEdit(found.card, {
    thai: document.getElementById('editThai').value,
    karaoke: document.getElementById('editKaraoke').value,
    zh: document.getElementById('editZh').value,
    note: document.getElementById('editNote').value,
  });
  closeEditModal();
  rerender();
}

function clearEditModal() {
  const key = document.getElementById('editCardKey').value;
  const found = findCardByKey(key);
  if (!found) return closeEditModal();
  clearCardEdit(found.card);
  closeEditModal();
  rerender();
}

function jumpToCard(cardKey) {
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
  saveState();
  syncModeButtons('card');
  rerender();
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

function updateSyncHint() {
  const el = document.getElementById('syncHint');
  if (!el) return;
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  el.textContent = `上次同步：${formatLastSync(getLastSync(url))}`;
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

function onFreshLessons(fresh) {
  // 舊版 eager cache revalidation callback
  const sameStructure = fresh.length === state.lessons.length
    && fresh.every((l, i) => l.id === state.lessons[i]?.id);
  state.lessons = fresh;
  if (!sameStructure) {
    state.currentLessonId = fresh[0]?.id || null;
    state.cardIndex = 0;
    state.flipped = false;
  }
  rerender();
}

async function init() {
  loadState();
  initDailyLog(state.progress);
  applyTheme();

  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  const hasManifest = !!loadManifest(url);
  const hasEager = !!loadLessonsCache(url);
  if (!hasManifest && !hasEager) showLoading('正在從 Google Sheets 抓課程列表…');

  state.lessons = await loadLessonsSmart(onFreshManifest);
  if (!state.currentLessonId ||
      (state.currentLessonId !== '__ALL__' && !state.lessons.find(l => l.id === state.currentLessonId))) {
    state.currentLessonId = state.lessons[0]?.id || null;
  }

  // lazy 模式：確保當前課程的卡片已載入
  await ensureLessonLoaded(state.currentLessonId, { silentUI: false });

  // 防止舊 cardIndex 在課程更新後越界
  const _initCards = filteredCards();
  if (_initCards.length && state.cardIndex >= _initCards.length) state.cardIndex = 0;

  rerender();

  if (state.mode === 'lists' || state.mode === 'dialog' || state.mode === 'today') {
    await ensureAllLoaded();
    rerender();
  }

  // 模式切換
  syncModeButtons();

  document.querySelectorAll('.mode-tab,.mp-btn').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.mode))
  );
  document.querySelectorAll('[data-drawer-mode]').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.drawerMode))
  );
  document.querySelectorAll('[data-drawer-list-order]').forEach(b =>
    b.addEventListener('click', () => selectListMode(b.dataset.drawerListOrder))
  );
  document.querySelectorAll('[data-mobile-mode]').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.mobileMode))
  );

  // Topbar 按鈕
  document.getElementById('btnFavPanel')?.addEventListener('click', () => selectLesson('__FAV__'));
  document.querySelector('[data-mobile-fav-button]')?.addEventListener('click', () => selectLesson('__FAV__'));
  document.querySelectorAll('[data-list-order-button]').forEach(b =>
    b.addEventListener('click', () => selectListMode(b.dataset.listOrderButton))
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
    renderSidebar(selectLesson);
  });
  document.getElementById('btnCloseSearch').addEventListener('click', closeSearch);
  document.getElementById('searchMask').addEventListener('click', e => {
    if (e.target.id === 'searchMask') closeSearch();
  });
  document.getElementById('btnCloseEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnCancelEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnSaveEdit').addEventListener('click', saveEditModal);
  document.getElementById('btnClearEdit').addEventListener('click', clearEditModal);
  document.getElementById('editMask').addEventListener('click', e => {
    if (e.target.id === 'editMask') closeEditModal();
  });
  document.getElementById('inpSearch').addEventListener('input', e => {
    renderSearchResults(e.target.value, onSearchPick);
  });
  document.getElementById('btnShuffle').addEventListener('click', () => {
    stopListen();
    shuffleCurrentLesson();
    rerender();
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
    const newInput = document.getElementById('inpSheet').value.trim();
    const inputChanged = newInput !== state.settings.sheetInput;
    const oldInput = state.settings.sheetInput;
    state.settings.sheetInput = newInput;
    saveState();
    if (inputChanged) {
      const btn = document.getElementById('btnSaveSettings');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '同步中…';
      try {
        showLoading('正在從 Google Sheets 抓課程列表…');
        // 先 fetch，成功才動 cache（避免抓壞時兩邊都沒了）
        const fresh = await loadLessonsSmart(onFreshManifest, { force: true });
        if (!fresh || !fresh.length) throw new Error('沒抓到課程');
        // URL 變了，舊 lesson cards 已不對應新 Sheet → 清掉
        clearLessonsCache();
        // saveManifest 已在 loadLessonsSmart 內部覆蓋，重新賦值 lessons
        state.lessons = fresh;
        state.currentLessonId = state.lessons[0]?.id || null;
        state.cardIndex = 0;
        state.flipped = false;
        await ensureLessonLoaded(state.currentLessonId, { force: true });
        setLastSync(newInput || DEFAULT_SHEET_URL);
      } catch (e) {
        console.warn('URL 變更後重抓失敗：', e);
        alert('抓不到 Sheet：' + e.message + '\n\nURL 已存，但資料還是舊的。');
        // 把 settings 回滾，避免下次又走 inputChanged 分支
        state.settings.sheetInput = oldInput;
        saveState();
        document.getElementById('inpSheet').value = oldInput;
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
    closeModal();
    rerender();
  });

  // 重置進度
  document.getElementById('btnResetProgress').addEventListener('click', () => {
    if (confirm('確定要清除所有學習進度嗎？')) {
      state.progress = {};
      saveState();
      renderStats();
      renderContent(rerender);
    }
  });

  // 重新同步 Sheet：先抓再覆蓋；失敗保留舊資料；連點防呆
  document.getElementById('btnClearCache').addEventListener('click', async () => {
    const btn = document.getElementById('btnClearCache');
    if (btn.disabled) return;
    if (!confirm('重新從 Google Sheet 抓最新資料？（進度跟收藏不會動）')) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中…';
    const url = state.settings.sheetInput || DEFAULT_SHEET_URL;

    try {
      showLoading('重新抓課程列表…');
      const fresh = await loadLessonsSmart(onFreshManifest, { force: true });
      if (!fresh || !fresh.length) throw new Error('沒抓到課程');

      // 走到這裡代表新 manifest 已經 fetch + saveManifest 完成
      // 現在才清掉舊的 lesson cards（其他 27 堂未來切過去會自動抓網路）
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('thai-review-lesson-')) localStorage.removeItem(k);
      });

      state.lessons = fresh;
      if (!state.lessons.find(l => l.id === state.currentLessonId) &&
          state.currentLessonId !== '__ALL__' && state.currentLessonId !== '__FAV__') {
        state.currentLessonId = state.lessons[0]?.id || null;
        state.cardIndex = 0;
      }

      const cur = state.lessons.find(l => l.id === state.currentLessonId);
      if (cur) showLoading(`同步「${cur.title}」…`);
      await ensureLessonLoaded(state.currentLessonId, { force: true, silentUI: true });

      setLastSync(url);
      updateSyncHint();
      closeModal();
      rerender();
    } catch (e) {
      console.warn('重新同步失敗：', e);
      alert('抓不到 Sheet：' + e.message + '\n\n先用舊資料繼續。');
      rerender();   // 把 showLoading 蓋掉的內容還原成舊資料
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

    // / 開搜尋
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('btnSearch').click();
      return;
    }

    if (state.mode === 'listen') {
      if (e.key === 'ArrowLeft') { stopListen(); prevCard(); }
      else if (e.key === 'ArrowRight') { stopListen(); nextCard(); }
      else if (e.code === 'Space') {
        e.preventDefault();
        import('./listen.js').then(m => m.toggleListen());
      }
      return;
    }

    // 今日 mode 沒有當前卡片，卡片快捷鍵（翻面 / 評分 / 換卡）不適用
    if (state.mode === 'today') return;

    if (e.key === 'ArrowLeft') prevCard();
    else if (e.key === 'ArrowRight') nextCard();
    else if (e.code === 'Space') {
      e.preventDefault();
      state.flipped = !state.flipped;
      document.getElementById('cardStage')?.classList.toggle('flipped', state.flipped);
    } else if (e.key === '1') { gradeAndAdvance('bad'); }
    else if (e.key === '2') { gradeAndAdvance('ok'); }
    else if (e.key === '3') { gradeAndAdvance('good'); }
    else if (e.key === 'p' || e.key === 'P') {
      const cards = filteredCards();
      if (cards[state.cardIndex]) speakCard(cards[state.cardIndex]);
    }
    else if (e.key === 's' || e.key === 'S') {
      shuffleCurrentLesson();
      rerender();
      flashShuffle();
    }
  });

  // 字卡頁的上一張 / 下一張 + 評分鈕（事件委派，每次 re-render 都有效）
  document.getElementById('content').addEventListener('click', e => {
    if (e.target.closest('[data-start-review-all]')) {
      e.stopPropagation();
      state.currentLessonId = '__ALL__';
      state.mode = 'srs';
      state.cardIndex = 0;
      state.flipped = false;
      stopListen();
      saveState();
      syncModeButtons('srs');
      rerender();
      return;
    }
    if (e.target.closest('[data-start-review]')) {
      e.stopPropagation();
      state.mode = 'srs';
      state.cardIndex = 0;
      state.flipped = false;
      stopListen();
      saveState();
      syncModeButtons('srs');
      rerender();
      return;
    }
    if (e.target.closest('[data-mode-back-to-card]')) {
      e.stopPropagation();
      state.mode = 'card';
      state.cardIndex = 0;
      state.flipped = false;
      saveState();
      syncModeButtons('card');
      rerender();
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
      jumpToCard(jumpBtn.dataset.jumpCard);
      return;
    }
    const listFilter = e.target.closest('[data-list-filter]');
    if (listFilter) {
      e.stopPropagation();
      state.listFilter = listFilter.dataset.listFilter;
      saveState();
      renderContent(rerender);
      return;
    }
    const listLesson = e.target.closest('[data-list-lesson]');
    if (listLesson) {
      e.stopPropagation();
      state.listLessonId = listLesson.dataset.listLesson;
      saveState();
      renderContent(rerender);
      return;
    }
    if (e.target.closest('#cardPrev')) { e.stopPropagation(); prevCard(); return; }
    if (e.target.closest('#cardNext')) { e.stopPropagation(); nextCard(); return; }
    const grade = e.target.closest('.pill[data-grade]');
    if (grade) {
      e.stopPropagation();
      gradeAndAdvance(grade.dataset.grade);
    }
  });

  // SRS toggle 切換（card / reverse mode 才會 render 出 #srsToggle）
  document.getElementById('content').addEventListener('change', e => {
    if (e.target?.id === 'srsToggle') {
      state.srsToggle = e.target.checked;
      state.cardIndex = 0;
      state.flipped = false;
      rerender();
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
    const t = e.changedTouches[0];
    const dx = t.clientX - tx;
    const dy = t.clientY - ty;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (state.mode === 'today') return;   // 今日 mode 沒有卡片可滑
      if (state.mode === 'listen') stopListen();
      if (dx > 0) prevCard(); else nextCard();
    }
  }, { passive: true });

  // 預熱 TTS voices
  warmupVoices();

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
