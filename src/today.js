/* 今日 mode：今日複習計劃（跨課程 due 彙整 + streak）+ 月曆（歷史熱度 + 未來到期預測）。
   每日複習日誌存獨立 localStorage key，不動主 STORAGE_KEY schema。 */

import { state, allCardsWithLessonId, cardKey, getDueCount, localDateKey } from './state.js';
import { cardStatus, normalizeGrade, getDueCards } from './srs.js';
import { ACHIEVEMENT_DEFS, checkAndUnlock, loadUnlocked, achievementLabel, achievementIconSvg } from './achievements.js';
import { accuracyTrend, averageAccuracy, weakLessons, weakestCards } from './stats.js';
import { pickResweepBatch, resweepProgress } from './resweep.js';
import { escapeHtml } from './ui.js';

export const DAILY_KEY = 'thai-review-daily-v1';

/* ===== 每日複習隊列（設計書 docs/mastery-sprint-plan-2026-08.md） =====
   到期複習（相對逾期排序，軟上限）＋重新複習掃描（剩餘預算，保底）＋弱項加強
   （還有剩才補），三段共用同一份每日用時預算，換算張數只是估算，真正的
   gate 是 day.seconds 本身，估不準下一次開 App 會自我修正。 */
const DAILY_BUDGET_SEC = 3600;   // 每日用時預算：60 分鐘
const DUE_SOFT_CAP_SEC = 2700;   // 到期複習軟性上限：45 分鐘
const RESWEEP_FLOOR_SEC = 900;   // 重新複習掃描保底：15 分鐘
const MIN_SESSION_SEC = 600;     // 單次「開始複習」至少給 10 分鐘份，即使當天預算已經用完
const SEC_PER_DUE_CARD = 17.5;   // 估算：評分＋跟讀
const SEC_PER_RESWEEP_CARD = 11; // 估算：大多是已經熟的卡，直接評分較快
const SEC_PER_WEAK_CARD = 15;
const WEAK_CARD_MAX = 8;

/* 純函式：組今天的複習隊列。todaySeconds 是今天已累積的用時（day.seconds），
   用來算剩餘預算，不是張數上限。回傳 { cards, resweepKeys }——resweepKeys
   是這批裡「從重新複習掃描抽出來」的卡的 _cardKey 集合，評分時要靠它決定
   要不要推進 resweep 游標（app.js gradeAndAdvance() 用）。 */
export function buildDailyQueue(allCards, progress, lessons, todaySeconds) {
  const remaining = Math.max(MIN_SESSION_SEC, DAILY_BUDGET_SEC - todaySeconds);

  const dueLimit = Math.max(0, Math.floor(Math.min(remaining, DUE_SOFT_CAP_SEC) / SEC_PER_DUE_CARD));
  const dueCards = getDueCards(allCards, progress).slice(0, dueLimit);
  const dueKeys = new Set(dueCards.map(c => c._cardKey));
  const dueSec = dueCards.length * SEC_PER_DUE_CARD;

  const resweepLimit = Math.max(0, Math.floor(Math.max(RESWEEP_FLOOR_SEC, remaining - dueSec) / SEC_PER_RESWEEP_CARD));
  // 多抓一點份量，濾掉跟到期複習重疊的卡之後才不會不夠
  const resweepRaw = resweepLimit > 0 ? pickResweepBatch(allCards, resweepLimit + dueKeys.size) : [];
  const resweepCards = resweepRaw.filter(c => !dueKeys.has(c._cardKey)).slice(0, resweepLimit);
  const resweepKeys = new Set(resweepCards.map(c => c._cardKey));
  const resweepSec = resweepCards.length * SEC_PER_RESWEEP_CARD;

  const usedKeys = new Set([...dueKeys, ...resweepKeys]);
  const weakLimit = Math.min(WEAK_CARD_MAX, Math.floor(Math.max(0, remaining - dueSec - resweepSec) / SEC_PER_WEAK_CARD));
  const weakCards = [];
  if (weakLimit > 0) {
    const byKey = new Map(allCards.map(c => [c._cardKey, c]));
    for (const row of weakestCards(progress, lessons, 40)) {
      if (weakCards.length >= weakLimit) break;
      const k = `${row.lessonId}:${row.thai}`;
      if (usedKeys.has(k)) continue;
      const card = byKey.get(k);
      if (card) { weakCards.push(card); usedKeys.add(k); }
    }
  }

  return { cards: interleaveByLesson([...dueCards, ...resweepCards, ...weakCards]), resweepKeys };
}

/* 輕量交錯：依 _lessonId 分桶、round-robin 輪流各取一張，桶內原本排序不變
   （到期／掃描／弱項各自的優先順序不受影響，只打散跨課次的連續黏連，呼應
   設計書引用的 interleaved practice 研究）。 */
function interleaveByLesson(cards) {
  const buckets = new Map();
  const order = [];
  for (const c of cards) {
    const id = c._lessonId || '';
    if (!buckets.has(id)) { buckets.set(id, []); order.push(id); }
    buckets.get(id).push(c);
  }
  if (order.length <= 1) return cards;
  const out = [];
  let remaining = cards.length;
  while (remaining > 0) {
    for (const id of order) {
      const bucket = buckets.get(id);
      if (bucket.length) { out.push(bucket.shift()); remaining--; }
    }
  }
  return out;
}

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
  const day = {
    reviewed: 0, again: 0, hard: 0, good: 0, easy: 0,
    ...(log.days[key] || {}),
  };
  day.reviewed += 1;
  const grade = normalizeGrade(gradeStr);
  if (grade in day) day[grade] += 1;
  log.days[key] = day;
  saveDailyLog(log);
}

/* 完成一局遊戲時記一筆。跟 reviewed 分開欄位、刻意不動 reviewed——
   那個欄位還餵著月曆熱度、maxDailyReviewed、totalReviewed 三個成就判定，
   混寫會讓「單日複習 50 張」「千張複習」的語意歪掉（見設計書 11.3）。
   gameId（'listen' / 'combo' / 'dialog'）記進 day.gameIds，讓首頁「今日任務清單」
   分得出來哪一局做過，不只是總數——只看 games 總數的話，玩過任一局其他兩局
   也會被誤判成已完成。
   同時檢查有沒有補救中的 makeupPending：今天累積滿 2 局就把昨天蓋章補回（6.1 節），
   settleStreakOnOpen() 已經在每次開 App 時把 makeupPending 算到今天最新狀態，
   這裡不用再驗證日期是否過期。 */
export function logGame(gameId, ts = Date.now()) {
  const log = loadDailyLog();
  const key = localDateKey(ts);
  const day = { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0, gameIds: [], ...(log.days[key] || {}) };
  day.games = (day.games || 0) + 1;
  day.gameIds = [...(day.gameIds || []), gameId];
  log.days[key] = day;

  if (log.makeupPending && day.games >= 2) {
    const { missedDate } = log.makeupPending;
    log.days[missedDate] = { ...ensureDay(log.days, missedDate), bridged: true };
    log.makeupPending = null;
  }

  saveDailyLog(log);
}

/* 累積今天實際活動秒數（app.js 的 15 秒 ticker 呼叫）。只記錄，不設目標。 */
export function addActiveSeconds(sec, ts = Date.now()) {
  if (!(sec > 0)) return;
  const log = loadDailyLog();
  const key = localDateKey(ts);
  const day = { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0, ...(log.days[key] || {}) };
  day.seconds = (day.seconds || 0) + sec;
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
    const day = {
      reviewed: 0, again: 0, hard: 0, good: 0, easy: 0,
      ...(log.days[key] || {}),
    };
    day.reviewed += 1;
    const grade = normalizeGrade(v.grade);
    if (grade in day) day[grade] += 1;
    log.days[key] = day;
  }
  log.backfilled = true;
  saveDailyLog(log);
}

/* ===== Streak ===== */

/* 「今天有來」＝正式複習過、完成過一局遊戲，或這天被安神保護／補救蓋章
   （見設計書 6 節／11.3／6.1）。 */
function cameOnDay(day) {
  return !!(day && (day.reviewed > 0 || day.games > 0 || day.bridged));
}

/* 連續複習天數。今天還沒複習不算斷（從昨天起算）；用 Date 遞減避開時制邊界。 */
export function streakDays(days, now = Date.now()) {
  let n = 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (!cameOnDay(days[localDateKey(d.getTime())])) d.setDate(d.getDate() - 1);
  while (cameOnDay(days[localDateKey(d.getTime())])) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* day 物件的預設形狀，給結算流程操作「非 key 那天」時用（例如安神保護蓋章的舊日子）。 */
function ensureDay(days, key) {
  return { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0, gameIds: [], ...(days[key] || {}) };
}

function dayKeyOffset(now, offsetDays) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return localDateKey(d.getTime());
}

/* 從昨天往回數，連續「沒來」的天數；安神保護上限 2，超過 PROTECTION_MAX+2 天
   後面的分支判斷都一樣是「R>=2 歸零」，不用再往前找，數到這裡就停。 */
export const PROTECTION_MAX = 2;

function countGapDays(days, now) {
  let d = 0;
  const cap = PROTECTION_MAX + 2;
  while (d < cap) {
    const key = dayKeyOffset(now, -(d + 1));
    if (cameOnDay(days[key])) break;
    d++;
  }
  return d;
}

/* streak 結算（安神保護消耗 + 補救判定 + 保護回補），設計書 6.1 節的順序。
   純函式：吃 log、回傳新 log + 這次結算做了什麼事（給 UI 顯示提示用）。
   不用另存一個「今天結算過了嗎」旗標——保護一旦蓋章，那天 cameOnDay() 就會是
   true，下次（甚至同一天）再結算時 D 會自然重算成 0，天然冪等。 */
export function runStreakSettlement(log, now = Date.now()) {
  const days = { ...log.days };
  let protection = log.protection || 0;
  let makeupPending = log.makeupPending || null;
  let event = { type: 'none' };

  const D = countGapDays(days, now);

  if (D === 0) {
    // 昨天有來，任何舊的補救判定都已經沒意義（例如她自己另外用正式複習補上了）
    makeupPending = null;
  } else {
    const spend = Math.min(D, protection);
    const R = D - spend;
    protection -= spend;

    // 保護只在「補得完或差 1 天」時才蓋章，且蓋的是缺口裡最舊的 spend 天，
    // 刻意留下離今天最近的 R 天不蓋——這樣 streakDays() 從今天往回走，
    // R=1 時第一步（昨天）就會撞到沒蓋章的那天，正確顯示「斷」，
    // 不會因為更早的日子蓋了章就顯示成部分連續（詳見設計書 6.1 討論）。
    // R>=2 注定歸零，蓋章沒有意義，乾脆不蓋，避免留下無用的 bridged 資料。
    if (R <= 1) {
      for (let i = 1; i <= spend; i++) {
        const offset = -(D - i + 1);
        const key = dayKeyOffset(now, offset);
        days[key] = { ...ensureDay(days, key), bridged: true };
      }
    }

    if (R === 0) {
      event = { type: 'protected', spent: spend };
      makeupPending = null;
    } else if (R === 1) {
      const missedDate = dayKeyOffset(now, -1);
      makeupPending = { missedDate };
      event = { type: 'makeup-offered', missedDate };
    } else {
      makeupPending = null;
      event = { type: 'reset' };
    }
  }

  // 保護回補：每連續 7 天回補 1 個，上限 2。回補以連續天數為準——用掉保護
  // 蓋章的那天已經算進 cameOnDay()，streakDays() 天然把它算進連續天數，
  // 回補门檻才追得上消耗（設計書 6.1）。checkpoint 記錄「算到第幾天已經
  // 結算過回補」；streak 歸零時 checkpoint 也歸零，不然下次累積 7 天時對不上。
  const streakNow = streakDays(days, now);
  let checkpoint = log.protectionRefillCheckpoint || 0;
  if (streakNow < checkpoint) checkpoint = 0;
  const gained = Math.floor((streakNow - checkpoint) / 7);
  if (gained > 0) {
    protection = Math.min(PROTECTION_MAX, protection + gained);
    checkpoint += gained * 7;
  }

  return {
    log: { ...log, days, protection, protectionRefillCheckpoint: checkpoint, makeupPending },
    event,
  };
}

/* 每次開 App 呼叫一次（app.js init()）。內部自己 load/save，呼叫端只要用回傳的
   event 決定要不要顯示提示。 */
export function settleStreakOnOpen(now = Date.now()) {
  const log = loadDailyLog();
  const { log: settled, event } = runStreakSettlement(log, now);
  saveDailyLog(settled);
  return event;
}

/* 目前的安神保護數量，首頁狀態列顯示用。 */
export function getProtectionCount(log = loadDailyLog()) {
  return log.protection || 0;
}

/* 補救中的補救對象（{missedDate} 或 null），首頁顯示補救 banner 用。 */
export function getMakeupPending(log = loadDailyLog()) {
  return log.makeupPending || null;
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

/* 本週（週一起算）每天的來訪／複習彙總，給首頁「本週進度」用。 */
export function weekSummary(days, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 週一=0
  d.setDate(d.getDate() - dow);

  const out = [];
  let daysCame = 0;
  let reviewedTotal = 0;
  let dialoguesCompleted = 0;
  for (let i = 0; i < 7; i++) {
    const key = localDateKey(d.getTime());
    const day = days[key];
    const came = cameOnDay(day);
    const reviewed = day?.reviewed || 0;
    if (came) daysCame++;
    reviewedTotal += reviewed;
    dialoguesCompleted += (day?.gameIds || []).filter(id => id === 'dialog').length;
    out.push({ key, came, reviewed });
    d.setDate(d.getDate() + 1);
  }
  return { days: out, daysCame, reviewedTotal, dialoguesCompleted };
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
  const allLessonsLoaded = state.lessons.length > 0
    && state.lessons.every(lesson => lesson._loaded || !lesson.gid);
  return {
    streak: streakDays(log.days),
    maxDailyReviewed,
    totalReviewed,
    totalCards: cards.length,
    gradedCards,
    allLessonsLoaded,
    hasFullyMatureLesson: hasFullyMatureLesson(),
    weeklyAccuracy: averageAccuracy(accuracyTrend(log.days, 7)),
  };
}

let toastTimer = null;

/* 通用浮動提示，成就解鎖跟安神保護消耗提示共用同一個元素／樣式。 */
export function showToast(msg, ms = 3200) {
  let el = document.getElementById('achvToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'achvToast';
    el.className = 'achv-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* 新解鎖成就與同一次操作附帶訊息共用一則浮動提示。 */
export function notifyAchievements(justUnlocked, ctx, extraMessage = '') {
  if (!justUnlocked.length && !extraMessage) return;
  const messages = justUnlocked.map(d => `解鎖成就：${achievementLabel(d, ctx)}`);
  if (extraMessage) messages.push(extraMessage);
  if (messages.length) showToast(messages.join('\n'));
}

export function renderAchievementsHtml(ctx) {
  const unlocked = loadUnlocked();
  const badges = ACHIEVEMENT_DEFS.map(def => {
    const on = !!unlocked[def.id];
    return `<span class="achv-badge${on ? ' on' : ''}" title="${escapeHtml(achievementLabel(def, ctx))}">${achievementIconSvg(def)}</span>`;
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
    const games = log.days[key]?.games || 0;
    const due = forecast[key] || 0;
    const isToday = key === todayKey;
    const isPast = key < todayKey;

    const cls = ['cal-cell'];
    if (isToday) cls.push('today');
    const heat = heatLevel(reviewed);
    if (heat && (isPast || isToday)) cls.push('past', 'heat-' + heat);
    // 只玩遊戲沒做正式複習：有來但沒有 heat 色塊，用描邊區分（設計書 6.2）
    if (!heat && games > 0 && (isPast || isToday)) cls.push('past', 'game-only');

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
  const todaySeconds = todayLog?.seconds || 0;
  const streak = streakDays(log.days);

  const checkin = reviewedToday > 0
    ? `<span class="today-checkin done">${SVG_CHECK}今天已複習 ${reviewedToday} 張</span>`
    : `<span class="today-checkin">今天還沒複習</span>`;

  const remainingMin = Math.max(0, Math.ceil((DAILY_BUDGET_SEC - todaySeconds) / 60));
  const goalHtml = todaySeconds >= DAILY_BUDGET_SEC
    ? `<span class="today-goal done">${SVG_CHECK}今天已達 1 小時複習目標</span>`
    : `<span class="today-goal">距離今天 1 小時目標還差 ${remainingMin} 分鐘</span>`;

  const achvCtx = buildAchievementCtx(log);
  notifyAchievements(checkAndUnlock(achvCtx), achvCtx);

  const sweep = resweepProgress(achvCtx.totalCards);
  const hasMore = dueCount > 0 || !sweep.done;

  const planHtml = hasMore
    ? `<div class="today-due"><span class="today-due-num">${dueCount}</span><span class="today-due-label">張到期</span></div>
       <button class="review-start-btn" data-start-review-all>開始複習</button>`
    : `<div class="today-due done"><span class="today-due-icon">${SVG_CHECK}</span><span class="today-due-label">全部卡片都掃完一輪了</span></div>`;

  const coveragePct = achvCtx.totalCards > 0 ? Math.round((achvCtx.gradedCards / achvCtx.totalCards) * 100) : 0;
  const sweepPct = sweep.total > 0 ? Math.round((sweep.position / sweep.total) * 100) : 0;
  const coverageHtml = `
    <div class="coverage-row"><span class="coverage-label">涵蓋率 ${coveragePct}%（${achvCtx.gradedCards} / ${achvCtx.totalCards}）</span></div>
    <div class="coverage-row"><span class="coverage-label">重新複習掃描 ${sweepPct}%（${sweep.position} / ${sweep.total}）</span></div>`;

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
        <div class="today-meta">
          ${goalHtml}
        </div>
        ${coverageHtml}
      </div>
      ${renderCalendarHtml(log)}
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
