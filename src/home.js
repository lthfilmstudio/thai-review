/* 新首頁（第 7 個 mode tab「練功」）。Phase 2：streak 完整規則（安神保護／補救／
   回補）+ 第 2 局「連擊複習」上線，第 3 局仍標「準備中」（見設計書 13 節）。
   today.js 是每日日誌／streak／安神保護的唯一真相來源，這裡只消費不複製
   （11.2 節 B 案）；視覺語言照 prototype-daily.html，但變數改用 base.css
   那套 --bg/--text/--gold（11.4 節）。 */

import { state, localDateKey, allCardsWithLessonId, cardKey } from './state.js';
import { escapeHtml } from './ui.js';
import {
  loadDailyLog, streakDays, weekSummary,
  getProtectionCount, getMakeupPending, buildAchievementCtx, notifyAchievements,
  renderAchievementsHtml,
} from './today.js';
import { checkAndUnlock } from './achievements.js';
import * as listenGame from './game-listen.js';
import * as comboGame from './game-combo.js';

const SVG_HEADPHONE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="7" rx="1.5"/><rect x="17.5" y="13" width="4" height="7" rx="1.5"/></svg>';
const SVG_CARDS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="6" width="13" height="13" rx="2"/><path d="M8 6V4h9a2 2 0 0 1 2 2v9h-1"/></svg>';
const SVG_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v10H9l-5 4v-14z"/></svg>';
const SVG_FLAME = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 3.5c.3 2.7-1.4 4-2.8 5.4-1.2 1.2-2.4 2.5-2.4 4.6a5 5 0 0 0 10 0c0-2.1-1.1-3.7-2.7-5.1-.3 1.5-1 2.5-2 3.1.4-2.8-.4-5.3-.1-8z"/></svg>';
const SVG_SHIELD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.6-2.9 8.2-7 10-4.1-1.8-7-5.4-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';

/* ===== 今日一句：跟 scripts/daily-reminder.py 的 pick_sentence() 同一套規則
   （§5.3）。兩邊算出同一句，通知才不會跟首頁對不起來。候選先依 thai 排序，
   跟來源陣列順序（可能被 shuffleCurrentLesson 打亂）無關。 ===== */

const THAI_CHAR_RE = /[฀-๿]/g;
const MIN_THAI_CHARS = 15;

function thaiCharCount(text) {
  return ((text || '').match(THAI_CHAR_RE) || []).length;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function pickDailySentence(lessons, dateKey) {
  for (let i = lessons.length - 1; i >= 0; i--) {
    const lesson = lessons[i];
    const candidates = (lesson.cards || [])
      .filter(c => thaiCharCount(c?.thai) >= MIN_THAI_CHARS)
      .slice()
      .sort((a, b) => (a.thai < b.thai ? -1 : a.thai > b.thai ? 1 : 0));
    if (!candidates.length) continue;
    const seed = `${dateKey}:${lesson.id || lesson.title || ''}`;
    const hex = await sha256Hex(seed);
    const idx = Number(BigInt('0x' + hex) % BigInt(candidates.length));
    return { lesson, card: candidates[idx] };
  }
  return null;
}

let sentenceCache = null;

function getDailySentence(lessons) {
  const dateKey = localDateKey();
  if (!sentenceCache || sentenceCache.dateKey !== dateKey) {
    sentenceCache = { dateKey, promise: pickDailySentence(lessons, dateKey) };
  }
  return sentenceCache.promise;
}

export function buildDailySentenceHref(lessonId, thai) {
  if (!lessonId || !thai) return null;
  const params = new URLSearchParams({ card: cardKey({ _lessonId: lessonId, thai }) });
  return `?${params.toString()}`;
}

export function fillDailySentence(box, result, documentRef = document) {
  const thai = result?.card?.thai || '';
  const zh = result?.card?.zh || '';
  const thaiLine = box?.querySelector('.home-sentence-thai');
  if (!thaiLine || !thai) return false;

  thaiLine.textContent = thai;
  if (!zh) return true;

  const href = buildDailySentenceHref(result?.lesson?.id, thai);
  const zhLine = documentRef.createElement(href ? 'a' : 'div');
  zhLine.className = 'home-sentence-zh';
  zhLine.textContent = zh;
  if (href) zhLine.href = href;
  box.appendChild(zhLine);
  return true;
}

/* ===== render ===== */

function newestLesson() {
  const real = state.lessons.filter(l => !l.id?.startsWith('__'));
  return real[real.length - 1] || null;
}

function renderWeekChip(week) {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const todayKey = localDateKey();
  return `<div class="home-week-chart">
    ${week.days.map((d, i) => `
      <div class="home-week-day${d.key === todayKey ? ' current' : ''}${d.came ? ' done' : ''}">
        <div class="home-week-dot"></div>
        <div class="home-week-label">${labels[i]}</div>
      </div>
    `).join('')}
  </div>`;
}

export function renderHomeMode(el, rerender) {
  if (listenGame.isListenGameActive()) {
    listenGame.render(el, { onExit: () => renderHomeMode(el, rerender) });
    return;
  }
  if (comboGame.isComboReviewActive()) {
    comboGame.render(el, { onExit: () => renderHomeMode(el, rerender) });
    return;
  }

  const lesson = newestLesson();
  const log = loadDailyLog();
  const todayKey = localDateKey();
  const todayLog = log.days[todayKey] || {};
  const streak = streakDays(log.days);
  const week = weekSummary(log.days);
  const protection = getProtectionCount(log);
  const makeup = getMakeupPending(log);
  const minutes = Math.floor((todayLog.seconds || 0) / 60);

  const doneGameIds = new Set(todayLog.gameIds || []);
  const task1Done = doneGameIds.has('listen');
  const task2Done = doneGameIds.has('combo');
  const doneCount = [task1Done, task2Done].filter(Boolean).length;

  // 成就檢查（連續 7/30/100 天等）：跟舊「今日」mode 一樣每次 render 都查一次，
  // checkAndUnlock 本身冪等，只有新解鎖時才跳 toast。
  const achvCtx = buildAchievementCtx(log);
  notifyAchievements(checkAndUnlock(achvCtx), achvCtx);

  const makeupBannerHtml = makeup ? `
    <div class="home-makeup-banner">
      <div class="home-makeup-text">昨天斷了一天——今天多完成 1 局（共 2 局）就能補回連續紀錄</div>
      <div class="home-makeup-progress">已完成 ${todayLog.games || 0} / 2 局</div>
    </div>
  ` : '';

  el.innerHTML = `
    <div class="home-wrap">
      <div class="home-status-row">
        <span class="home-streak">${SVG_FLAME}<strong>${streak}</strong> 天連續</span>
        <span class="home-protection">${SVG_SHIELD}<strong>${protection}</strong> 安神保護</span>
      </div>

      ${makeupBannerHtml}

      <div class="home-hero">
        ${lesson ? `<div class="home-course-chip"><span class="home-course-dot"></span>本週課程 · <strong>${escapeHtml(lesson.title)}</strong></div>` : ''}
        <div class="home-challenge-row">
          <span class="home-challenge-label">今日挑戰</span>
          <span class="home-challenge-num">${doneCount} / 3</span>
        </div>
        <div class="home-time-row">今日累積 <strong>${minutes > 0 ? `${minutes} 分鐘` : '未滿 1 分鐘'}</strong></div>
        <button class="home-primary-btn" data-home-start-game type="button">開始下一局 →</button>
      </div>

      <div class="home-sentence" id="homeSentenceBox">
        <div class="home-sentence-label">今日一句</div>
        <div class="home-sentence-thai">…</div>
      </div>

      <div class="home-tasks">
        <div class="home-task${task1Done ? ' done' : ''}" data-home-task="1">
          <div class="home-task-icon">${SVG_HEADPHONE}</div>
          <div class="home-task-body">
            <div class="home-task-title">聲音熱身<span class="home-task-tag">音感挑戰</span></div>
            <div class="home-task-sub">跟著老師音讀 5 句${lesson ? ` · ${escapeHtml(lesson.title)}` : ''}</div>
          </div>
          <button class="home-task-btn" data-home-task-btn="1" type="button">${task1Done ? '再玩一局' : '開始一局'}</button>
        </div>
        <div class="home-task${task2Done ? ' done' : ''}" data-home-task="2">
          <div class="home-task-icon">${SVG_CARDS}</div>
          <div class="home-task-body">
            <div class="home-task-title">複習容易忘的字<span class="home-task-tag">連擊複習</span></div>
            <div class="home-task-sub">跨課程到期／易忘的字 6 張</div>
          </div>
          <button class="home-task-btn" data-home-task-btn="2" type="button">${task2Done ? '再玩一局' : '開始一局'}</button>
        </div>
        <div class="home-task disabled" data-home-task="3">
          <div class="home-task-icon">${SVG_CHAT}</div>
          <div class="home-task-body">
            <div class="home-task-title">生活對話<span class="home-task-tag">情境選答</span></div>
            <div class="home-task-sub">準備中</div>
          </div>
          <button class="home-task-btn" disabled type="button">準備中</button>
        </div>
      </div>

      <div class="home-week-panel">
        <div class="home-week-head">本週進度</div>
        <div class="home-week-stats">來過 <strong>${week.daysCame} / 7</strong> 天 · 複習 <strong>${week.reviewedTotal}</strong> 張</div>
        ${renderWeekChip(week)}
      </div>

      ${renderAchievementsHtml(achvCtx)}
    </div>
  `;

  const startListen = () => {
    if (!lesson || !lesson.cards?.length) return;
    listenGame.startListenGame(lesson, state.progress);
    renderHomeMode(el, rerender);
  };
  const startCombo = () => {
    if (!lesson) return;
    comboGame.startComboReview(allCardsWithLessonId(), state.progress, lesson.id);
    renderHomeMode(el, rerender);
  };
  const startNext = !task1Done ? startListen : !task2Done ? startCombo : startListen;

  el.querySelector('[data-home-start-game]')?.addEventListener('click', startNext);
  el.querySelector('[data-home-task-btn="1"]')?.addEventListener('click', startListen);
  el.querySelector('[data-home-task-btn="2"]')?.addEventListener('click', startCombo);

  getDailySentence(state.lessons).then(result => {
    const box = document.getElementById('homeSentenceBox');
    fillDailySentence(box, result);
  }).catch(() => {});
}
