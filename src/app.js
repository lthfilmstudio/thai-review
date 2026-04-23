/* 入口：init → 載入狀態 → 抓資料 → 綁事件。 */

import {
  state, loadState, saveState,
  DEMO_LESSONS, DEFAULT_SHEET_URL,
  filteredCards, setGrade, shuffleCurrentLesson,
  saveLessonsCache, loadLessonsCache, clearLessonsCache,
} from './state.js';
import { loadLessons } from './data.js';
import { speakCard, warmupVoices } from './tts.js';
import { stopListen } from './listen.js';
import {
  renderSidebar, renderTopbarTitle, renderStats, renderContent,
  openDrawer, closeDrawer, openModal, closeModal, applyTheme,
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

/* cache-first：有 cache 先回、同時背景 revalidate；
   沒 cache 才等網路；網路也炸才走 DEMO。 */
async function loadLessonsCacheFirst(onFreshData) {
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  const cached = loadLessonsCache(url);

  // 背景 revalidate 永遠會跑
  const revalidate = (async () => {
    const fresh = await fetchFromNetwork(url);
    if (fresh) {
      saveLessonsCache(url, fresh);
      onFreshData?.(fresh);
    }
    return fresh;
  })();

  if (cached) return cached.lessons;

  // 沒 cache，等網路
  const fresh = await revalidate;
  return fresh || DEMO_LESSONS;
}

function rerender() {
  renderSidebar(selectLesson);
  renderTopbarTitle();
  renderContent(rerender);
  renderStats();
}

function selectLesson(id) {
  state.currentLessonId = id;
  state.cardIndex = 0;
  state.flipped = false;
  stopListen();
  saveState();
  closeDrawer();
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
  // 課程結構沒變（數量跟 id 都相同）就靜默替換卡片資料，
  // 保留使用者當前位置；變了才重設到第一堂。
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

  const hasCache = !!loadLessonsCache(state.settings.sheetInput || DEFAULT_SHEET_URL);
  if (!hasCache) showLoading('正在從 Google Sheets 抓課程…');

  state.lessons = await loadLessonsCacheFirst(onFreshLessons);
  if (!state.currentLessonId ||
      (state.currentLessonId !== '__ALL__' && !state.lessons.find(l => l.id === state.currentLessonId))) {
    state.currentLessonId = state.lessons[0]?.id || null;
  }

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
      // URL 變了 → 清 cache 強制重抓
      clearLessonsCache();
      showLoading('正在從 Google Sheets 抓課程…');
      state.lessons = await loadLessonsCacheFirst(onFreshLessons);
      state.currentLessonId = state.lessons[0]?.id || null;
      state.cardIndex = 0;
      state.flipped = false;
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
    if (document.getElementById('modalMask').classList.contains('open')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

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
