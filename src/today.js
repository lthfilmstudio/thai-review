/* 今日 mode：今日複習計劃（跨課程 due 彙整 + streak）+ 月曆（歷史熱度 + 未來到期預測）。
   每日複習日誌存獨立 localStorage key，不動主 STORAGE_KEY schema。 */

import { state, allCardsWithLessonId, cardKey, getDueCount, localDateKey } from './state.js';
import { cardStatus } from './srs.js';
import { ACHIEVEMENT_DEFS, checkAndUnlock, loadUnlocked, achievementLabel } from './achievements.js';
import { accuracyTrend, averageAccuracy, weakLessons, weakestCards } from './stats.js';
import { escapeHtml } from './ui.js';

export const DAILY_KEY = 'thai-review-daily-v1';

const SVG_CHEV_L = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const SVG_CHEV_R = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
const SVG_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/* ===== 每日日誌 ===== */

export function loadDailyLog() {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return { v: 1, backfilled: false, days: {} };
    const log = JSON.parse(raw);
    if (!log || typeof log.days !== 'object') return { v: 1, backfilled: false, days: {} };
    return log;
  } catch {
    return { v: 1, backfilled: false, days: {} };
  }
}

function saveDailyLog(log) {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(log));
  } catch (e) {
    console.warn('daily log save failed:', e.message);
  }
}

/* 評分時記一筆。寫入點在 app.js gradeAndAdvance()。
   day 的四檔欄位是 again/hard/good/easy；舊資料留下的 bad/ok 欄位維持原樣不動，
   只是新的一天不會再往那兩個欄位寫。 */
export function logReview(gradeStr, ts = Date.now()) {
  const log = loadDailyLog();
  const key = localDateKey(ts);
  const day = log.days[key] || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
  day.reviewed += 1;
  if (gradeStr in day) day[gradeStr] += 1;
  log.days[key] = day;
  saveDailyLog(log);
}

/* 一次性回填：progress 只存每張卡最後一次 reviewedAt，回填是下限值，比一片空白好。 */
export function initDailyLog(progress) {
  const log = loadDailyLog();
  if (log.backfilled) return;
  for (const k in progress) {
    const v = progress[k];
    if (!v || typeof v !== 'object' || !(v.reviewedAt > 0)) continue;
    const key = localDateKey(v.reviewedAt);
    const day = log.days[key] || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
    day.reviewed += 1;
    if (v.grade in day) day[v.grade] += 1;
    log.days[key] = day;
  }
  log.backfilled = true;
  saveDailyLog(log);
}

/* ===== Streak ===== */

/* 連續複習天數。今天還沒複習不算斷（從昨天起算）；用 Date 遞減避開時制邊界。 */
export function streakDays(days, now = Date.now()) {
  let n = 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (!(days[localDateKey(d.getTime())]?.reviewed > 0)) d.setDate(d.getDate() - 1);
  while (days[localDateKey(d.getTime())]?.reviewed > 0) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* ===== 未來到期預測 ===== */

/* 指定月份每日預計到期數。沒評過的新卡不算（與 isDue 語義一致）；
   所有 nextReviewAt <= now（含逾期 / migrate 的 0）歸入今天，跟「開始複習」隊列一致。 */
export function forecastByDay(cards, progress, year, month, now = Date.now()) {
  const out = {};
  const todayKey = localDateKey(now);
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  for (const c of cards) {
    const entry = progress[c._cardKey || cardKey(c)];
    if (!entry || typeof entry !== 'object') continue;
    const t = entry.nextReviewAt ?? 0;
    const key = t <= now ? todayKey : localDateKey(t);
    if (!key.startsWith(prefix)) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function heatLevel(n) {
  if (n >= 30) return 4;
  if (n >= 15) return 3;
  if (n >= 5) return 2;
  if (n >= 1) return 1;
  return 0;
}

/* ===== 成就 ===== */

/* 是否有某堂課全部卡片都到 mature（cardStatus，方向 2）。 */
function hasFullyMatureLesson() {
  for (const lesson of state.lessons) {
    if (!lesson.cards.length) continue;
    const allMature = lesson.cards.every(card => {
      const entry = state.progress[cardKey(card, lesson.id)];
      return cardStatus(entry) === 'mature';
    });
    if (allMature) return true;
  }
  return false;
}

/* 組裝成就判定要的 ctx。呼叫端（評分後、進今日 tab 時）各自帶目前的 log 呼叫。 */
export function buildAchievementCtx(log = loadDailyLog()) {
  let maxDailyReviewed = 0;
  let totalReviewed = 0;
  for (const k in log.days) {
    const r = log.days[k]?.reviewed || 0;
    totalReviewed += r;
    if (r > maxDailyReviewed) maxDailyReviewed = r;
  }
  const cards = allCardsWithLessonId();
  const gradedCards = cards.filter(c => !!state.progress[c._cardKey]).length;
  return {
    streak: streakDays(log.days),
    maxDailyReviewed,
    totalReviewed,
    totalCards: cards.length,
    gradedCards,
    hasFullyMatureLesson: hasFullyMatureLesson(),
    weeklyAccuracy: averageAccuracy(accuracyTrend(log.days, 7)),
  };
}

let achvToastTimer = null;

/* 新解鎖成就的浮動提示；沒有新解鎖時不做事。 */
export function notifyAchievements(justUnlocked, ctx) {
  if (!justUnlocked.length) return;
  let el = document.getElementById('achvToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'achvToast';
    el.className = 'achv-toast';
    document.body.appendChild(el);
  }
  el.textContent = justUnlocked.map(d => `${d.icon} 解鎖成就：${achievementLabel(d, ctx)}`).join('\n');
  el.classList.add('show');
  clearTimeout(achvToastTimer);
  achvToastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function renderAchievementsHtml(ctx) {
  const unlocked = loadUnlocked();
  const badges = ACHIEVEMENT_DEFS.map(def => {
    const on = !!unlocked[def.id];
    return `<span class="achv-badge${on ? ' on' : ''}" title="${achievementLabel(def, ctx)}">${def.icon}</span>`;
  }).join('');
  return `
    <div class="achv-row">
      ${badges}
      <span class="achv-count">已解鎖 ${Object.keys(unlocked).length}/${ACHIEVEMENT_DEFS.length}</span>
    </div>`;
}

/* ===== 數據 tab（趨勢 + 弱課次 + 卡住的字） ===== */

let statsTab = 'plan';     // 'plan' | 'stats'，module-local，不持久化
let trendWindow = 7;       // 7 | 30

function renderTrendChart(trend) {
  const bars = trend.map(d => {
    const has = d.pct !== null;
    const h = has ? Math.max(4, Math.round((d.pct / 100) * 52)) : 3;
    const cls = !has ? 'empty' : d.pct >= 80 ? 'good' : d.pct >= 50 ? 'mid' : 'low';
    const label = has ? `${d.key}：${d.pct}%（${d.reviewed} 張）` : `${d.key}：沒有複習紀錄`;
    return `<div class="trend-bar" title="${escapeHtml(label)}"><div class="trend-bar-fill ${cls}" style="height:${h}px"></div></div>`;
  }).join('');
  return `<div class="trend-chart">${bars}</div>`;
}

function renderWeakLessonsHtml(rows) {
  if (!rows.length) return `<div class="stats-empty">還沒有明顯偏弱的課次。</div>`;
  return `<div class="weak-list">${rows.map(r => `
    <div class="weak-row">
      <span class="weak-title">${escapeHtml(r.title)}</span>
      <span class="weak-rate">${Math.round(r.badRate * 100)}%</span>
    </div>`).join('')}</div>`;
}

function renderWeakCardsHtml(rows) {
  if (!rows.length) return `<div class="stats-empty">目前沒有卡在「重來 / 有點難」的字。</div>`;
  return `<div class="weak-list">${rows.map(r => `
    <div class="weak-row">
      <span class="weak-thai">${escapeHtml(r.thai)}</span>
      <span class="weak-zh">${escapeHtml(r.zh)}</span>
      <span class="weak-badge ${r.grade}">${r.grade === 'again' ? '重來' : '有點難'}</span>
    </div>`).join('')}</div>`;
}

function renderStatsHtml() {
  const log = loadDailyLog();
  const trend = accuracyTrend(log.days, trendWindow);
  const avg = averageAccuracy(trend);
  const weakL = weakLessons(state.progress, state.lessons);
  const weakC = weakestCards(state.progress, state.lessons, 20);

  return `
    <div class="stats-section">
      <div class="stats-head">
        <div class="stats-title">正確率趨勢${avg !== null ? `<span class="stats-avg">平均 ${avg}%</span>` : ''}</div>
        <div class="stats-window-toggle">
          <button class="stats-window-btn${trendWindow === 7 ? ' active' : ''}" data-trend-window="7">7 天</button>
          <button class="stats-window-btn${trendWindow === 30 ? ' active' : ''}" data-trend-window="30">30 天</button>
        </div>
      </div>
      ${renderTrendChart(trend)}
    </div>
    <div class="stats-section">
      <div class="stats-title">最弱課次</div>
      ${renderWeakLessonsHtml(weakL)}
    </div>
    <div class="stats-section">
      <div class="stats-title">卡住的字</div>
      ${renderWeakCardsHtml(weakC)}
    </div>
  `;
}

/* ===== Render ===== */

/* 顯示中的月份（module-local，不持久化；跨 re-render 保留，重開 app 回到當月） */
let viewYear = null;
let viewMonth = null;

function renderCalendarHtml(log) {
  const now = new Date();
  if (viewYear === null) { viewYear = now.getFullYear(); viewMonth = now.getMonth(); }

  const todayKey = localDateKey();
  const forecast = forecastByDay(allCardsWithLessonId(), state.progress, viewYear, viewMonth);
  const first = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;   // 週一起算的空格數

  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  let cells = weekdays.map(w => `<div class="cal-wd">${w}</div>`).join('');
  for (let i = 0; i < lead; i++) cells += '<div class="cal-cell empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const reviewed = log.days[key]?.reviewed || 0;
    const due = forecast[key] || 0;
    const isToday = key === todayKey;
    const isPast = key < todayKey;

    const cls = ['cal-cell'];
    if (isToday) cls.push('today');
    const heat = heatLevel(reviewed);
    if (heat && (isPast || isToday)) cls.push('past', 'heat-' + heat);

    let n = '';
    if ((isPast || isToday) && reviewed > 0) n = `<span class="cal-n">${reviewed}</span>`;
    if (!isPast && due > 0) n += `<span class="cal-n due">${due}</span>`;

    cells += `<div class="${cls.join(' ')}"><span class="cal-day">${day}</span>${n}</div>`;
  }

  return `
    <div class="cal">
      <div class="cal-head">
        <button class="cal-nav" data-cal-prev aria-label="上個月">${SVG_CHEV_L}</button>
        <div class="cal-title">${viewYear} 年 ${viewMonth + 1} 月</div>
        <button class="cal-nav" data-cal-next aria-label="下個月">${SVG_CHEV_R}</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span class="cal-legend-item"><span class="cal-legend-swatch"></span>已複習（越深越多）</span>
        <span class="cal-legend-item"><span class="cal-legend-due">8</span>預計到期</span>
      </div>
    </div>`;
}

export function renderTodayMode(el) {
  const log = loadDailyLog();
  const dueCount = getDueCount();
  const todayLog = log.days[localDateKey()];
  const reviewedToday = todayLog?.reviewed || 0;
  const streak = streakDays(log.days);

  const checkin = reviewedToday > 0
    ? `<span class="today-checkin done">${SVG_CHECK}今天已複習 ${reviewedToday} 張</span>`
    : `<span class="today-checkin">今天還沒複習</span>`;

  const achvCtx = buildAchievementCtx(log);
  notifyAchievements(checkAndUnlock(achvCtx), achvCtx);

  const planHtml = dueCount > 0
    ? `<div class="today-due"><span class="today-due-num">${dueCount}</span><span class="today-due-label">張到期</span></div>
       <button class="review-start-btn" data-start-review-all>開始複習</button>`
    : `<div class="today-due done"><span class="today-due-icon">${SVG_CHECK}</span><span class="today-due-label">今天沒有到期卡片</span></div>`;

  const tabsHtml = `
    <div class="today-tabs" role="tablist">
      <button class="today-tab${statsTab === 'plan' ? ' active' : ''}" data-today-tab="plan" role="tab" aria-selected="${statsTab === 'plan'}">複習規劃</button>
      <button class="today-tab${statsTab === 'stats' ? ' active' : ''}" data-today-tab="stats" role="tab" aria-selected="${statsTab === 'stats'}">數據</button>
    </div>`;

  const bodyHtml = statsTab === 'stats'
    ? renderStatsHtml()
    : `
      <div class="today-plan">
        ${planHtml}
        <div class="today-meta">
          <span class="today-streak">連續 ${streak} 天</span>
          ${checkin}
        </div>
      </div>
      ${renderCalendarHtml(log)}
      ${renderAchievementsHtml(achvCtx)}
    `;

  el.innerHTML = `
    <div class="today-wrap">
      ${tabsHtml}
      ${bodyHtml}
    </div>`;

  el.querySelectorAll('[data-today-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      statsTab = btn.dataset.todayTab;
      renderTodayMode(el);
    });
  });
  el.querySelectorAll('[data-trend-window]').forEach(btn => {
    btn.addEventListener('click', () => {
      trendWindow = Number(btn.dataset.trendWindow);
      renderTodayMode(el);
    });
  });

  // 月份切換自包含，不經 app.js 委派（只在 plan tab 存在，stats tab 這兩個 querySelector 會是 null）
  el.querySelector('[data-cal-prev]')?.addEventListener('click', () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderTodayMode(el);
  });
  el.querySelector('[data-cal-next]')?.addEventListener('click', () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderTodayMode(el);
  });
}
