/* UI render 總管：sidebar、drawer、topbar、stats、content dispatcher、modal、主題。 */

import {
  state, currentLesson, filteredCards, favoriteCount, saveState, isSrsActive,
  allCardsWithLessonId, isFavorite, gradeOf,
} from './state.js';
import { renderCardMode } from './card.js';
import { renderListenMode, stopListen } from './listen.js';
import { renderDialogMode } from './dialog.js';
import { isDue, nextReviewAtMin, daysUntil, formatNextReview } from './srs.js';

const SVG_CHECK = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

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

/* 一次掃所有 cards 算出每堂課的 due 數（避免每堂呼叫一次 countDue 變 O(N²)） */
function dueCountsByLesson() {
  const counts = new Map();
  const now = Date.now();
  for (const l of state.lessons) {
    let n = 0;
    for (const c of l.cards) {
      const lessonId = c._lessonId || l.id;
      if (isDue(state.progress[`${lessonId}:${c.thai}`], now)) n++;
    }
    counts.set(l.id, n);
  }
  return counts;
}

/* 當前 lens（單堂或虛擬課程）的 due 總數，給「今日複習」tab 徽章用 */
function currentViewDueCount() {
  const lesson = currentLesson();
  if (!lesson) return 0;
  let n = 0;
  const now = Date.now();
  for (const c of lesson.cards) {
    const lessonId = c._lessonId || lesson.id;
    if (isDue(state.progress[`${lessonId}:${c.thai}`], now)) n++;
  }
  return n;
}

/* 更新 mode tab 上的「今日複習 (N)」徽章 */
export function updateSrsTabBadges() {
  const n = currentViewDueCount();
  const text = n > 0 ? `(${n})` : '';
  document.querySelectorAll('[data-srs-count]').forEach(el => {
    el.textContent = text;
  });
}

export function renderSidebar(selectLesson) {
  const list = document.getElementById('sideList');
  const dlist = document.getElementById('drawerList');
  list.innerHTML = '';
  dlist.innerHTML = '';

  const dueByLesson = dueCountsByLesson();

  const makeSide = (l, isActive, display) => {
    const btn = document.createElement('button');
    btn.className = 'side-item' + (isActive ? ' active' : '');
    const due = dueByLesson.get(l.id) || 0;
    const dueHtml = due > 0 ? `<span class="lesson-due">${due}</span>` : '';
    btn.innerHTML = `<span class="dot"></span><span class="lesson-name">${escapeHtml(display ?? l.title)}</span>${dueHtml}`;
    btn.addEventListener('click', () => selectLesson(l.id));
    return btn;
  };
  const makeDrawer = (l, isActive, display) => {
    const btn = document.createElement('button');
    btn.className = 'drawer-item' + (isActive ? ' active' : '');
    const due = dueByLesson.get(l.id) || 0;
    const dueHtml = due > 0 ? `<span class="lesson-due">${due}</span>` : '';
    btn.innerHTML = `<span class="lesson-name">${escapeHtml(display ?? l.title)}</span>${dueHtml}`;
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

    // 有初/中/高前綴分組時一律顯示章節 header（即使只有 1 章），保持視覺一致；純「其他」群才平鋪
    const needChapterGroup = hasPrefixedGroup || byChapter.size > 1;
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
  document.querySelector('[data-mobile-fav-button]')?.classList.toggle('active', state.currentLessonId === '__FAV__');
  const listedCount = allCardsWithLessonId().filter(c => isFavorite(c) || gradeOf(c)).length;
  document.querySelectorAll('#listThaiCount,#listZhCount').forEach(n => {
    n.textContent = String(listedCount);
  });
  document.querySelectorAll('[data-list-order-button]').forEach(b => {
    b.classList.toggle('active', state.mode === 'lists' && b.dataset.listOrderButton === state.listOrder);
  });
  document.querySelectorAll('[data-drawer-list-order]').forEach(b => {
    b.classList.toggle('active', state.mode === 'lists' && b.dataset.drawerListOrder === state.listOrder);
  });
}

function listTitleFor(card, lessonMap) {
  const title = lessonMap.get(card._lessonId) || '';
  const { group, display } = parseGroup(title);
  return group === '其他' ? display : `${GROUP_LABEL[group]} · ${display}`;
}

function cardsForList(kind, cards) {
  if (kind === 'fav') return cards.filter(c => isFavorite(c));
  return cards.filter(c => gradeOf(c) === kind);
}

function renderListCards(cards, lessonMap, order = 'thai') {
  if (!cards.length) {
    return `<div class="empty list-empty">
      <div class="empty-icon">✦</div>
      <div class="empty-title">這裡還沒有卡片</div>
      <div class="empty-sub">先收藏或按「差／可以／熟」評幾張，清單就會出現。</div>
    </div>`;
  }

  return `<div class="review-list">` + cards.map(card => `
    <div class="review-list-card${card._edited ? ' edited' : ''}">
      <button class="review-list-main" data-jump-card="${escapeHtml(card._cardKey)}">
        <div class="rl-tag">${escapeHtml(listTitleFor(card, lessonMap))}${card._edited ? ' · 已修正' : ''}</div>
        ${order === 'zh' ? `
          <div class="rl-zh rl-primary">${escapeHtml(card.zh)}</div>
          ${card.note ? `<div class="rl-note">（${escapeHtml(card.note)}）</div>` : ''}
          <div class="rl-thai rl-secondary">${escapeHtml(card.thai)}</div>
          <div class="rl-karaoke">${escapeHtml(card.karaoke)}</div>
        ` : `
          <div class="rl-thai">${escapeHtml(card.thai)}</div>
          <div class="rl-karaoke">${escapeHtml(card.karaoke)}</div>
          <div class="rl-zh">${escapeHtml(card.zh)}</div>
        `}
      </button>
      <button class="review-list-edit" data-edit-card-key="${escapeHtml(card._cardKey)}" aria-label="編輯這張卡">${SVG_EDIT}</button>
    </div>
  `).join('') + `</div>`;
}

function renderListsMode(el) {
  const all = allCardsWithLessonId();
  const lessonMap = new Map(state.lessons.map(l => [l.id, l.title]));
  const filters = [
    { id: 'fav', label: '收藏', count: cardsForList('fav', all).length },
    { id: 'bad', label: '差', count: cardsForList('bad', all).length },
    { id: 'ok', label: '可以', count: cardsForList('ok', all).length },
    { id: 'good', label: '熟', count: cardsForList('good', all).length },
  ];
  if (!filters.some(f => f.id === state.listFilter)) state.listFilter = 'fav';
  const cards = cardsForList(state.listFilter, all);
  const order = state.listOrder === 'zh' ? 'zh' : 'thai';
  const title = order === 'zh' ? '中文清單' : '泰文清單';
  const sub = order === 'zh'
    ? '中文在前，點任一張就回到複習頁。'
    : '泰文在前，點任一張就回到複習頁。';

  el.innerHTML = `
    <div class="lists-wrap">
      <div class="lists-head">
        <div>
          <div class="lists-title">${escapeHtml(title)}</div>
          <div class="lists-sub">${escapeHtml(sub)}</div>
        </div>
      </div>
      <div class="list-filter-row" role="tablist" aria-label="清單分類">
        ${filters.map(f => `
          <button class="list-filter${state.listFilter === f.id ? ' active' : ''}" data-list-filter="${f.id}" role="tab" aria-selected="${state.listFilter === f.id ? 'true' : 'false'}">
            <span>${escapeHtml(f.label)}</span><strong>${f.count}</strong>
          </button>
        `).join('')}
      </div>
      ${renderListCards(cards, lessonMap, order)}
    </div>
  `;
}

export function renderContent(onGrade) {
  const el = document.getElementById('content');

  if (state.mode === 'lists') {
    renderListsMode(el);
    renderStats();
    updateSrsTabBadges();
    return;
  }

  // 對話模式不依賴單張卡片，獨立 render（吃 state.lessons）
  if (state.mode === 'dialog') {
    renderDialogMode(el);
    renderStats();
    updateSrsTabBadges();
    return;
  }

  const cards = filteredCards();

  // SRS 空狀態：今日複習完成（或還沒評過任何字）
  if (isSrsActive() && cards.length === 0) {
    const min = nextReviewAtMin(state.progress);
    const hasAnyProgress = Object.keys(state.progress).some(k => {
      const v = state.progress[k];
      return v && typeof v === 'object';
    });
    // card / reverse mode 下保留 toggle，讓使用者能取消「只看待複習」
    const toggleHtml = (state.mode === 'card' || state.mode === 'reverse') ? `
      <div class="srs-toggle-row">
        <label class="srs-toggle">
          <input type="checkbox" id="srsToggle"${state.srsToggle ? ' checked' : ''}>
          <span>只看待複習</span>
        </label>
      </div>` : '';
    let doneHtml;
    if (!hasAnyProgress) {
      doneHtml = `<div class="srs-done">
        <div class="srs-done-icon">${SVG_CHECK}</div>
        <div class="srs-done-title">還沒開始</div>
        <div class="srs-done-sub">先到「字卡」模式評幾張，<br>它們才會排進複習隊列。</div>
      </div>`;
    } else {
      const days = min ? daysUntil(min) : 1;
      doneHtml = `<div class="srs-done">
        <div class="srs-done-icon">${SVG_CHECK}</div>
        <div class="srs-done-title">今日複習完成</div>
        <div class="srs-done-sub">下次複習：<strong>${escapeHtml(formatNextReview(days))}</strong></div>
      </div>`;
    }
    el.innerHTML = toggleHtml + doneHtml;
    renderStats();
    updateSrsTabBadges();
    return;
  }

  if (!cards.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">✦</div>
      <div class="empty-title">沒有卡片</div>
      <div class="empty-sub">這堂課沒有內容。試試切到其他課程。</div>
    </div>`;
    updateSrsTabBadges();
    return;
  }
  if (state.cardIndex >= cards.length) state.cardIndex = 0;

  if (state.mode === 'listen') {
    renderListenMode(el, cards, () => {
      renderContent(onGrade);
      renderStats();
    });
  } else {
    // card / reverse / srs 都共用 renderCardMode；reverse 把中文擺正面
    renderCardMode(el, cards, onGrade, { reverse: state.mode === 'reverse' });
    renderStats();
  }
  updateSrsTabBadges();
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
  syncSegActive('#segVoice', b => b.dataset.voice === state.settings.voice);
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
