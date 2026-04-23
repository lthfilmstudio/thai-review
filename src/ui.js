/* UI render 總管：sidebar、drawer、topbar、stats、content dispatcher、modal、主題。 */

import { state, currentLesson, filteredCards, gradeOf, favoriteCount } from './state.js';
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

  // 「全部混合」+「⭐ 收藏」分隔
  if (state.lessons.length > 1) {
    const hr = document.createElement('div'); hr.className = 'side-divider'; list.appendChild(hr);
    const hr2 = document.createElement('div'); hr2.className = 'side-divider'; dlist.appendChild(hr2);

    list.appendChild(makeSide({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));
    dlist.appendChild(makeDrawer({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));

    const favTitle = '⭐ 收藏' + (favoriteCount() ? ` (${favoriteCount()})` : '');
    list.appendChild(makeSide({ id: '__FAV__', title: favTitle }, state.currentLessonId === '__FAV__'));
    dlist.appendChild(makeDrawer({ id: '__FAV__', title: favTitle }, state.currentLessonId === '__FAV__'));
  }
}

export function renderTopbarTitle() {
  const lesson = currentLesson();
  document.getElementById('topTitle').textContent = lesson ? lesson.title : '清心安神';
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
    // card（正向）或 reverse（中文在正面）
    renderCardMode(el, cards, onGrade, { reverse: state.mode === 'reverse' });
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

export function openSearch() {
  const inp = document.getElementById('inpSearch');
  inp.value = '';
  document.getElementById('searchMeta').textContent = '輸入中文、泰文或拼音關鍵字';
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchMask').classList.add('open');
  setTimeout(() => inp.focus(), 50);
}

export function closeSearch() {
  document.getElementById('searchMask').classList.remove('open');
}

export function renderSearchResults(query, onPick) {
  const meta = document.getElementById('searchMeta');
  const list = document.getElementById('searchResults');
  const q = (query || '').trim().toLowerCase();
  list.innerHTML = '';

  if (!q) {
    meta.textContent = '輸入中文、泰文或拼音關鍵字';
    return;
  }

  const matches = [];
  for (const l of state.lessons) {
    for (let i = 0; i < l.cards.length; i++) {
      const c = l.cards[i];
      if (
        (c.thai || '').toLowerCase().includes(q) ||
        (c.zh || '').toLowerCase().includes(q) ||
        (c.karaoke || '').toLowerCase().includes(q)
      ) {
        matches.push({ card: c, lessonId: l.id, lessonTitle: l.title, index: i });
        if (matches.length >= 100) break;  // 上限
      }
    }
    if (matches.length >= 100) break;
  }

  meta.textContent = matches.length ? `找到 ${matches.length} 張${matches.length >= 100 ? '（只顯示前 100 張）' : ''}` : '沒有符合的卡';

  for (const m of matches) {
    const btn = document.createElement('button');
    btn.className = 'search-item';
    btn.innerHTML = `
      <div class="si-tag">${escapeHtml(m.lessonTitle)}</div>
      <div class="si-thai">${escapeHtml(m.card.thai)}</div>
      <div class="si-karaoke">${escapeHtml(m.card.karaoke)}</div>
      <div class="si-zh">${escapeHtml(m.card.zh)}</div>
    `;
    btn.addEventListener('click', () => onPick(m));
    list.appendChild(btn);
  }
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
