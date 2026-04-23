/* 入口：init → 載入狀態 → 抓資料 → 綁事件。 */

import {
  state, loadState, saveState,
  DEMO_LESSONS, DEFAULT_SHEET_URL,
  filteredCards, setGrade, shuffleCurrentLesson,
  saveLessonsCache, loadLessonsCache, clearLessonsCache,
  loadManifest, saveManifest, loadLessonCards, saveLessonCards,
} from './state.js';
import { loadLessons, loadTabsOnly, fetchLessonCards } from './data.js';
import { speakCard, warmupVoices } from './tts.js';
import { stopListen } from './listen.js';
import {
  renderSidebar, renderTopbarTitle, renderStats, renderContent,
  openDrawer, closeDrawer, openModal, closeModal, applyTheme,
  openSearch, closeSearch, renderSearchResults,
} from './ui.js';

async function fetchFromNetwork(url) {
  try {
    const lessons = await loadLessons(url);
    if (lessons && lessons.length) return lessons;
  } catch (e) {
    console.warn('資料載入失敗：', e.message);
    if (state.settings.sheetInput) alert('資料載入失敗：' + e.message);
  }
  return null;
}

/* 舊版 eager cache（給單一 CSV / 多 CSV 模式用，沒 tab 概念無法 lazy）。 */
async function loadLessonsCacheFirstEager(onFreshData) {
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  const cached = loadLessonsCache(url);

  const revalidate = (async () => {
    const fresh = await fetchFromNetwork(url);
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

async function loadLessonsLazy(url, onFreshManifest) {
  let manifest = loadManifest(url);

  if (!manifest) {
    const m = await loadTabsOnly(url);
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
async function ensureLessonLoaded(lessonId, { silentUI = false } = {}) {
  // 全部混合、收藏、搜尋都需要所有課都載入過才有完整結果
  if (lessonId === '__ALL__' || lessonId === '__FAV__' || lessonId === '__SEARCH__') {
    return ensureAllLoaded();
  }
  const lesson = state.lessons.find(l => l.id === lessonId);
  if (!lesson || lesson._loaded || !lesson.gid || !state.baseUrl) return;

  if (!silentUI) showLoading(`載入「${lesson.title}」…`);
  try {
    lesson.cards = await fetchLessonCards(state.baseUrl, lesson.gid);
    lesson._loaded = true;
    saveLessonCards(lesson.gid, lesson.cards);
  } catch (e) {
    console.warn('lesson load failed:', lesson.title, e.message);
    alert('載入失敗：' + e.message);
  }
}

/* 全部混合：把還沒抓過的課程全部補抓（並行）。 */
async function ensureAllLoaded() {
  const todo = state.lessons.filter(l => !l._loaded && l.gid && state.baseUrl);
  if (!todo.length) return;
  showLoading(`正在補抓 ${todo.length} 堂未載入的課程…`);
  await Promise.allSettled(todo.map(async l => {
    try {
      l.cards = await fetchLessonCards(state.baseUrl, l.gid);
      l._loaded = true;
      saveLessonCards(l.gid, l.cards);
    } catch (e) {
      console.warn('lesson load failed:', l.title, e.message);
    }
  }));
}

/* 主進入點：publish-to-web 走 lazy，其他走舊版 eager。 */
async function loadLessonsSmart(onFresh) {
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  try {
    return await loadLessonsLazy(url, onFresh);
  } catch (e) {
    if (e.message !== 'no-manifest') console.warn('lazy failed:', e.message);
    return await loadLessonsCacheFirstEager(onFresh);
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
  if (state.mode === 'listen') state.mode = 'card';
  stopListen();
  saveState();
  closeSearch();
  rerender();
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

function selectMode(m) {
  state.mode = m;
  state.flipped = false;
  stopListen();
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('.mp-btn').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  document.querySelectorAll('[data-drawer-mode]').forEach(t => t.classList.toggle('active', t.dataset.drawerMode === m));
  saveState();
  renderContent(rerender);
  renderStats();
}

function nextCard() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex + 1) % cards.length;
  state.flipped = false;
  renderContent(rerender);
}

function prevCard() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;
  state.flipped = false;
  renderContent(rerender);
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

  rerender();

  // 模式切換
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === state.mode));
  document.querySelectorAll('.mp-btn').forEach(t => t.classList.toggle('active', t.dataset.mode === state.mode));
  document.querySelectorAll('[data-drawer-mode]').forEach(t => t.classList.toggle('active', t.dataset.drawerMode === state.mode));

  document.querySelectorAll('.mode-tab,.mp-btn').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.mode))
  );
  document.querySelectorAll('[data-drawer-mode]').forEach(b =>
    b.addEventListener('click', () => selectMode(b.dataset.drawerMode))
  );

  // Topbar 按鈕
  document.getElementById('btnMenu').addEventListener('click', openDrawer);
  document.getElementById('drawerMask').addEventListener('click', closeDrawer);
  document.getElementById('btnSettings').addEventListener('click', openModal);
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
  wireSegClick('#segTheme', b => {
    state.settings.theme = b.dataset.theme;
    applyTheme();
  });

  // 儲存設定
  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const newInput = document.getElementById('inpSheet').value.trim();
    const inputChanged = newInput !== state.settings.sheetInput;
    state.settings.sheetInput = newInput;
    saveState();
    if (inputChanged) {
      // URL 變了 → 清所有 cache 強制重抓
      clearLessonsCache();
      showLoading('正在從 Google Sheets 抓課程列表…');
      state.lessons = await loadLessonsSmart(onFreshManifest);
      state.currentLessonId = state.lessons[0]?.id || null;
      state.cardIndex = 0;
      state.flipped = false;
      await ensureLessonLoaded(state.currentLessonId);
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

  // 鍵盤快捷鍵
  document.addEventListener('keydown', e => {
    // Esc 關搜尋（搜尋 modal 內也要能關）
    if (e.key === 'Escape' && document.getElementById('searchMask').classList.contains('open')) {
      closeSearch();
      return;
    }
    if (document.getElementById('modalMask').classList.contains('open')) return;
    if (document.getElementById('searchMask').classList.contains('open')) return;
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

    if (e.key === 'ArrowLeft') prevCard();
    else if (e.key === 'ArrowRight') nextCard();
    else if (e.code === 'Space') {
      e.preventDefault();
      state.flipped = !state.flipped;
      document.getElementById('cardStage')?.classList.toggle('flipped', state.flipped);
    } else if (e.key === '1') { setGrade(state.cardIndex, 'bad'); renderStats(); nextCard(); }
    else if (e.key === '2') { setGrade(state.cardIndex, 'ok'); renderStats(); nextCard(); }
    else if (e.key === '3') { setGrade(state.cardIndex, 'good'); renderStats(); nextCard(); }
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

  // 字卡頁的上一張 / 下一張按鈕（事件委派，每次 re-render 都有效）
  document.getElementById('content').addEventListener('click', e => {
    if (e.target.closest('#cardPrev')) { e.stopPropagation(); prevCard(); }
    else if (e.target.closest('#cardNext')) { e.stopPropagation(); nextCard(); }
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
      if (state.mode === 'listen') stopListen();
      if (dx > 0) prevCard(); else nextCard();
    }
  }, { passive: true });

  // 預熱 TTS voices
  warmupVoices();

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW register failed:', e));
  }
}

init();
