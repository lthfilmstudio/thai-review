/* UI render 總管：sidebar、drawer、topbar、stats、content dispatcher、modal、主題。 */

import { state, currentLesson, filteredCards, favoriteCount, saveState } from './state.js';
import { renderCardMode } from './card.js';
import { renderListenMode, stopListen } from './listen.js';

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 解析 tab 名前綴分組：「初 1」→ group=初、displayTitle=1；沒前綴就歸「其他」 */
const GROUP_ORDER = ['初', '中', '高'];
const GROUP_LABEL = { '初': '初級', '中': '中級', '高': '高級', '其他': '其他' };

function parseGroup(title) {
  const m = (title || '').match(/^(初|中|高)\s+(.*)$/);
  if (m) return { group: m[1], display: m[2] };
  return { group: '其他', display: title };
}

function groupLessons(lessons) {
  const groups = new Map();
  for (const l of lessons) {
    const { group, display } = parseGroup(l.title);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...l, displayTitle: display });
  }
  // 依 GROUP_ORDER 排，其他放最後
  const ordered = [];
  for (const g of GROUP_ORDER) if (groups.has(g)) ordered.push([g, groups.get(g)]);
  if (groups.has('其他')) ordered.push(['其他', groups.get('其他')]);
  return ordered;
}

export function renderSidebar(selectLesson) {
  const list = document.getElementById('sideList');
  const dlist = document.getElementById('drawerList');
  list.innerHTML = '';
  dlist.innerHTML = '';

  const makeSide = (l, isActive, display) => {
    const btn = document.createElement('button');
    btn.className = 'side-item' + (isActive ? ' active' : '');
    btn.innerHTML = `<span class="dot"></span><span>${escapeHtml(display ?? l.title)}</span>`;
    btn.addEventListener('click', () => selectLesson(l.id));
    return btn;
  };
  const makeDrawer = (l, isActive, display) => {
    const btn = document.createElement('button');
    btn.className = 'drawer-item' + (isActive ? ' active' : '');
    btn.textContent = display ?? l.title;
    btn.addEventListener('click', () => { selectLesson(l.id); closeDrawer(); });
    return btn;
  };

  const makeGroupHeader = (label, count) => {
    const h = document.createElement('div');
    h.className = 'group-header';
    h.innerHTML = `<span>${escapeHtml(label)}</span><span class="group-count">${count}</span>`;
    return h;
  };

  const chevronSvg = collapsed => `<svg class="chev${collapsed ? '' : ' open'}" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

  const makeChapterHeader = (label, count, collapsed, onToggle) => {
    const btn = document.createElement('button');
    btn.className = 'chapter-header' + (collapsed ? ' collapsed' : '');
    btn.innerHTML = `${chevronSvg(collapsed)}<span class="ch-label">${escapeHtml(label)}</span><span class="ch-count">${count}</span>`;
    btn.addEventListener('click', onToggle);
    return btn;
  };

  // 分組渲染課程：先依前綴（初/中/高）分，再依章節號（1/2/3...）分子群
  const grouped = groupLessons(state.lessons);
  const hasPrefixedGroup = grouped.some(([k]) => k !== '其他');

  for (const [topKey, lessons] of grouped) {
    if (hasPrefixedGroup) {
      list.appendChild(makeGroupHeader(GROUP_LABEL[topKey], lessons.length));
      dlist.appendChild(makeGroupHeader(GROUP_LABEL[topKey], lessons.length));
    }

    // 子群：按章節號分組（「2-3」→ 章節 2、「3-總複習」→ 章節 3、「1」→ 章節 1）
    const byChapter = new Map();
    for (const l of lessons) {
      const m = (l.displayTitle || '').match(/^(\d+)/);
      const ch = m ? m[1] : '?';
      if (!byChapter.has(ch)) byChapter.set(ch, []);
      byChapter.get(ch).push(l);
    }

    // 章節數量夠多（>1）才展開收合功能；只有 1 章就直接平鋪
    const needChapterGroup = byChapter.size > 1;
    // 預設展開最後一章、其餘收起（使用者有手動點過就改用 explicit 狀態）
    const chapterKeys = [...byChapter.keys()];
    const lastChapter = chapterKeys[chapterKeys.length - 1];

    for (const [ch, items] of byChapter) {
      const collapseKey = `${topKey}-${ch}`;
      const explicit = state.collapsed[collapseKey];
      const collapsed = explicit !== undefined ? !!explicit : (ch !== lastChapter);

      if (needChapterGroup) {
        const label = `${GROUP_LABEL[topKey]} ${ch}`;
        const toggle = () => {
          state.collapsed[collapseKey] = !state.collapsed[collapseKey];
          saveState();
          renderSidebar(selectLesson);
        };
        list.appendChild(makeChapterHeader(label, items.length, collapsed, toggle));
        dlist.appendChild(makeChapterHeader(label, items.length, collapsed, toggle));
        if (collapsed) continue;
      }

      for (const l of items) {
        const active = l.id === state.currentLessonId;
        list.appendChild(makeSide(l, active, l.displayTitle));
        dlist.appendChild(makeDrawer(l, active, l.displayTitle));
      }
    }
  }

  // 「全部混合」分隔（sidebar 不含收藏，drawer 補回收藏供手機使用）
  if (state.lessons.length > 1) {
    const hr = document.createElement('div'); hr.className = 'side-divider'; list.appendChild(hr);
    const hr2 = document.createElement('div'); hr2.className = 'side-divider'; dlist.appendChild(hr2);

    const favTitle = '★ 收藏' + (favoriteCount() ? ` (${favoriteCount()})` : '');
    dlist.appendChild(makeDrawer({ id: '__FAV__', title: favTitle }, state.currentLessonId === '__FAV__'));

    list.appendChild(makeSide({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));
    dlist.appendChild(makeDrawer({ id: '__ALL__', title: '全部混合' }, state.currentLessonId === '__ALL__'));
  }
}

export function renderTopbarTitle() {
  const lesson = currentLesson();
  if (!lesson) {
    document.getElementById('topTitle').textContent = '清心安神';
    return;
  }
  // 虛擬課程（全部混合/收藏/搜尋）保留原名，真實課程剝掉「初 」「中 」前綴
  const isVirtual = ['__ALL__', '__FAV__', '__SEARCH__'].includes(lesson.id);
  const { display } = parseGroup(lesson.title);
  document.getElementById('topTitle').textContent = isVirtual ? lesson.title : display;
}

export function renderStats() {
  const count = favoriteCount();
  const el = document.getElementById('favPanelCount');
  if (el) el.textContent = count ? `${count} 張` : '0 張';
  const btn = document.getElementById('btnFavPanel');
  if (btn) btn.classList.toggle('active', state.currentLessonId === '__FAV__');
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
    const { group, display } = parseGroup(m.lessonTitle);
    const tag = group === '其他' ? display : `${GROUP_LABEL[group]} · ${display}`;
    btn.innerHTML = `
      <div class="si-tag">${escapeHtml(tag)}</div>
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
