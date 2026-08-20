/* 新首頁（第 7 個 mode tab「練功」）。Phase 1 只做「首頁能動 → 進得去 → 出得來 →
   記得住」這條路，只有第 1 局（音感挑戰）能玩，第 2、3 局先列出來標「準備中」
   （見設計書 13 節）。today.js 是每日日誌／streak 的唯一真相來源，這裡只消費不
   複製（11.2 節 B 案）；視覺語言照 prototype-daily.html，但變數改用 base.css
   那套 --bg/--text/--gold（11.4 節）。 */

import { state, localDateKey } from './state.js';
import { escapeHtml } from './ui.js';
import { loadDailyLog, streakDays, weekSummary } from './today.js';
import * as listenGame from './game-listen.js';

const SVG_HEADPHONE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="7" rx="1.5"/><rect x="17.5" y="13" width="4" height="7" rx="1.5"/></svg>';
const SVG_CARDS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="6" width="13" height="13" rx="2"/><path d="M8 6V4h9a2 2 0 0 1 2 2v9h-1"/></svg>';
const SVG_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v10H9l-5 4v-14z"/></svg>';
const SVG_FLAME = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 3.5c.3 2.7-1.4 4-2.8 5.4-1.2 1.2-2.4 2.5-2.4 4.6a5 5 0 0 0 10 0c0-2.1-1.1-3.7-2.7-5.1-.3 1.5-1 2.5-2 3.1.4-2.8-.4-5.3-.1-8z"/></svg>';

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

  const lesson = newestLesson();
  const log = loadDailyLog();
  const todayKey = localDateKey();
  const todayLog = log.days[todayKey] || {};
  const streak = streakDays(log.days);
  const week = weekSummary(log.days);
  const task1Done = (todayLog.games || 0) > 0;
  const doneCount = task1Done ? 1 : 0;
  const minutes = Math.floor((todayLog.seconds || 0) / 60);

  el.innerHTML = `
    <div class="home-wrap">
      <div class="home-status-row">
        <span class="home-streak">${SVG_FLAME}<strong>${streak}</strong> 天連續</span>
      </div>

      <div class="home-hero">
        ${lesson ? `<div class="home-course-chip"><span class="home-course-dot"></span>本週課程 · <strong>${escapeHtml(lesson.title)}</strong></div>` : ''}
        <div class="home-challenge-row">
          <span class="home-challenge-label">今日挑戰</span>
          <span class="home-challenge-num">${doneCount} / 3</span>
        </div>
        <div class="home-time-row">今日累積 <strong>${minutes > 0 ? `${minutes} 分鐘` : '未滿 1 分鐘'}</strong></div>
        <button class="home-primary-btn" data-home-start-game type="button">開始下一局 →</button>
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
        <div class="home-task disabled" data-home-task="2">
          <div class="home-task-icon">${SVG_CARDS}</div>
          <div class="home-task-body">
            <div class="home-task-title">複習容易忘的字<span class="home-task-tag">連擊複習</span></div>
            <div class="home-task-sub">準備中</div>
          </div>
          <button class="home-task-btn" disabled type="button">準備中</button>
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

      <div class="home-sentence" id="homeSentenceBox">
        <div class="home-sentence-label">今日一句</div>
        <div class="home-sentence-thai">…</div>
      </div>
    </div>
  `;

  const startGame = () => {
    if (!lesson || !lesson.cards?.length) return;
    listenGame.startListenGame(lesson, state.progress);
    renderHomeMode(el, rerender);
  };
  el.querySelector('[data-home-start-game]')?.addEventListener('click', startGame);
  el.querySelector('[data-home-task-btn="1"]')?.addEventListener('click', startGame);

  getDailySentence(state.lessons).then(result => {
    const box = document.getElementById('homeSentenceBox');
    if (!box || !result) return;
    box.querySelector('.home-sentence-thai').textContent = result.card.thai;
    const zhLine = document.createElement('div');
    zhLine.className = 'home-sentence-zh';
    zhLine.textContent = result.card.zh || '';
    box.appendChild(zhLine);
  }).catch(() => {});
}
