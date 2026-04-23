/* 入口：init → 載入狀態 → 抓資料 → 綁事件。 */

import { state, loadState, saveState, DEMO_LESSONS, DEFAULT_SHEET_URL, filteredCards, setGrade } from './state.js';
import { loadLessons } from './data.js';
import { speakCard, warmupVoices } from './tts.js';
import { stopListen } from './listen.js';
import {
  renderSidebar, renderTopbarTitle, renderStats, renderContent,
  openDrawer, closeDrawer, openModal, closeModal, applyTheme,
} from './ui.js';

async function fetchLessonsOrDemo() {
  const url = state.settings.sheetInput || DEFAULT_SHEET_URL;
  try {
    const lessons = await loadLessons(url);
    if (lessons && lessons.length) return lessons;
  } catch (e) {
    console.warn('資料載入失敗，使用 demo 資料：', e.message);
    // 使用者有填自訂 URL 才跳錯誤提示；預設 URL 失敗靜默 fallback 到 demo
    if (state.settings.sheetInput) alert('資料載入失敗：' + e.message);
  }
  return DEMO_LESSONS;
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

async function init() {
  loadState();
  applyTheme();

  state.lessons = await fetchLessonsOrDemo();
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
      state.lessons = await fetchLessonsOrDemo();
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
