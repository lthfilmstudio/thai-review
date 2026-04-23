/* UI render 總管：sidebar、drawer、topbar、stats、content dispatcher、modal、主題。 */

import { state, currentLesson, filteredCards, gradeOf } from './state.js';
import { renderCardMode } from './card.js';
import { renderListenMode, stopListen } from './listen.js';

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderSidebar(selectLesson) {
  const list = document.getElementById('sideList');
  const dlist = document.getElementById('drawerList');
  list.innerHTML = '';
  dlist.innerHTML = '';

  const makeSide = (l, isActive) => {
    const btn = document.createElement('button');
    btn.className = 'side-item' + (isActive ? ' active' : '');
    btn.innerHTML = `<span class="dot"></span><span>${escapeHtml(l.title)}</span>`;
    btn.addEventListener('click', () => selectLesson(l.id));
    return btn;
  };
  const makeDrawer = (l, isActive) => {
    const btn = document.createElement('button');
    btn.className = 'drawer-item' + (isActive ? ' active' : '');
    btn.textContent = l.title;
    btn.addEventListener('click', () => { selectLesson(l.id); closeDrawer(); });
    return btn;
  };

  for (const l of state.lessons) {
    const active = l.id === state.currentLessonId;
    list.appendChild(makeSide(l, active));
    dlist.appendChild(makeDrawer(l, active));
  }

  // 「全部混合」分隔
  if (state.lessons.length > 1) {
    const hr = document.createElement('div'); hr.className = 'side-divider'; list.appendChild(hr);
    list.appendChild(makeSide({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));
    const hr2 = document.createElement('div'); hr2.className = 'side-divider'; dlist.appendChild(hr2);
    dlist.appendChild(makeDrawer({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));
  }
}

export function renderTopbarTitle() {
  const lesson = currentLesson();
  document.getElementById('topTitle').textContent = lesson ? lesson.title : '泰文複習';
}

export function renderStats() {
  const cards = filteredCards();
  let g = 0, o = 0, b = 0;
  cards.forEach((_, i) => {
    const grade = gradeOf(i);
    if (grade === 'good') g++;
    else if (grade === 'ok') o++;
    else if (grade === 'bad') b++;
  });
  document.getElementById('statGood').textContent = g;
  document.getElementById('statOk').textContent = o;
  document.getElementById('statBad').textContent = b;
}

export function renderContent(onGrade) {
  const el = document.getElementById('content');
  const cards = filteredCards();
  if (!cards.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">✦</div>
      <div class="empty-title">沒有卡片</div>
      <div class="empty-sub">這堂課沒有內容。試試切到其他課程。</div>
    </div>`;
    return;
  }
  if (state.cardIndex >= cards.length) state.cardIndex = 0;

  if (state.mode === 'listen') {
    renderListenMode(el, cards, () => {
      renderContent(onGrade);
      renderStats();
    });
  } else {
    renderCardMode(el, cards, onGrade);
    renderStats();
  }
}

export function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerMask').classList.add('open');
}
export function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerMask').classList.remove('open');
}

export function openModal() {
  document.getElementById('inpSheet').value = state.settings.sheetInput;
  syncSegActive('#segRate', b => Number(b.dataset.rate) === state.settings.rate);
  syncSegActive('#segRepeat', b => Number(b.dataset.repeat) === state.settings.repeat);
  syncSegActive('#segGap', b => b.dataset.gap === String(state.settings.gap));
  syncSegActive('#segTheme', b => b.dataset.theme === state.settings.theme);
  document.getElementById('modalMask').classList.add('open');
}
export function closeModal() {
  document.getElementById('modalMask').classList.remove('open');
}

function syncSegActive(sel, predicate) {
  document.querySelectorAll(`${sel} .seg-btn`).forEach(b =>
    b.classList.toggle('active', predicate(b))
  );
}

export function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export { stopListen };
