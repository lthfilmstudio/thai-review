/* 「今日」分頁的行動面板（原本是獨立的「練功」分頁，2026-08-22 合併進今日——
   兩個分頁都在回答「今天要做什麼」，分開反而要來回切）。Phase 3：三種每日
   遊戲局、進步時刻與成就徽章均已接入（見設計書 13 節）。
   today.js 是每日日誌／streak／安神保護的唯一真相來源，也是合併後的分頁殼，
   這裡只出 HTML 片段 + 綁自己的事件，不自己畫分頁（11.2 節 B 案）；視覺語言
   照 prototype-daily.html，但變數改用 base.css 那套 --bg/--text/--gold（11.4 節）。 */

import { state, localDateKey, allCardsWithLessonId, cardKey } from './state.js';
import { escapeHtml } from './ui.js';
import { speakCard } from './tts.js';
import * as listenGame from './game-listen.js';
import * as comboGame from './game-combo.js';
import * as dialogueGame from './game-dialogue.js';

const SVG_PLAY = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>';
const SVG_HEADPHONE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="7" rx="1.5"/><rect x="17.5" y="13" width="4" height="7" rx="1.5"/></svg>';
const SVG_CARDS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="6" width="13" height="13" rx="2"/><path d="M8 6V4h9a2 2 0 0 1 2 2v9h-1"/></svg>';
const SVG_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v10H9l-5 4v-14z"/></svg>';
export const SVG_FLAME = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 3.5c.3 2.7-1.4 4-2.8 5.4-1.2 1.2-2.4 2.5-2.4 4.6a5 5 0 0 0 10 0c0-2.1-1.1-3.7-2.7-5.1-.3 1.5-1 2.5-2 3.1.4-2.8-.4-5.3-.1-8z"/></svg>';
export const SVG_SHIELD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.6-2.9 8.2-7 10-4.1-1.8-7-5.4-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';

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

  // 冪等：getDailySentence() 一天只建一個 promise，但今日分頁可能 render 兩次
  // （進分頁一次、ensureAllLoaded() 補完課程後再一次），兩個 then callback 都會
  // 用 id 抓到「當下」那個 box，不先清掉舊的就會疊出兩行中文翻譯。
  box.querySelector('.home-sentence-zh')?.remove();

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

export function renderWeekChip(week) {
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

/* 遊戲進行中：整頁交給遊戲接管，呼叫端（today.js）看到 true 就不要再畫分頁殼。 */
export function renderActiveGame(el, onExit) {
  if (listenGame.isListenGameActive()) {
    listenGame.render(el, { onExit });
    return true;
  }
  if (comboGame.isComboReviewActive()) {
    comboGame.render(el, { onExit });
    return true;
  }
  if (dialogueGame.isDialogueGameActive()) {
    dialogueGame.render(el, { onExit });
    return true;
  }
  return false;
}

/* 今日挑戰三局的完成狀態，HTML 跟事件綁定都要用，抽出來免得兩邊各算一次。 */
export function gameTaskState(todayLog) {
  const doneGameIds = new Set(todayLog?.gameIds || []);
  const task1Done = doneGameIds.has('listen');
  const task2Done = doneGameIds.has('combo');
  const task3Done = doneGameIds.has('dialog');
  return {
    task1Done, task2Done, task3Done,
    doneCount: [task1Done, task2Done, task3Done].filter(Boolean).length,
  };
}

/* 行動面板 HTML：補救 banner、今日挑戰、今日一句、三局任務。
   連續天數／安神保護 pill 併進 today.js 的「X 張到期」卡片，這裡不重複顯示。
   複習隊列（開始複習）那塊歸 today.js，這裡不碰。 */
export function homePanelHtml({ todayLog, makeup }) {
  const lesson = newestLesson();
  const minutes = Math.floor((todayLog.seconds || 0) / 60);
  const { task1Done, task2Done, task3Done, doneCount } = gameTaskState(todayLog);

  const makeupBannerHtml = makeup ? `
    <div class="home-makeup-banner">
      <div class="home-makeup-text">昨天斷了一天——今天多完成 1 局（共 2 局）就能補回連續紀錄</div>
      <div class="home-makeup-progress">已完成 ${todayLog.games || 0} / 2 局</div>
    </div>
  ` : '';

  return `
      ${makeupBannerHtml}

      <div class="home-sentence" id="homeSentenceBox">
        <div class="home-sentence-head">
          <div class="home-sentence-label">今日一句</div>
          <button class="play-btn" id="homeSentencePlay" aria-label="播放">${SVG_PLAY}</button>
        </div>
        <div class="home-sentence-thai">…</div>
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
        <div class="home-task${task2Done ? ' done' : ''}" data-home-task="2">
          <div class="home-task-icon">${SVG_CARDS}</div>
          <div class="home-task-body">
            <div class="home-task-title">複習容易忘的字<span class="home-task-tag">連擊複習</span></div>
            <div class="home-task-sub">跨課程到期／易忘的字 6 張</div>
          </div>
          <button class="home-task-btn" data-home-task-btn="2" type="button">${task2Done ? '再玩一局' : '開始一局'}</button>
        </div>
        <div class="home-task${task3Done ? ' done' : ''}${state.dialogues.length ? '' : ' disabled'}" data-home-task="3">
          <div class="home-task-icon">${SVG_CHAT}</div>
          <div class="home-task-body">
            <div class="home-task-title">生活對話<span class="home-task-tag">情境選答</span></div>
            <div class="home-task-sub">兩人來回 6 句，各講 3 句</div>
          </div>
          <button class="home-task-btn" data-home-task-btn="3" ${state.dialogues.length ? '' : 'disabled'} type="button">${task3Done ? '再玩一局' : '開始一局'}</button>
        </div>
      </div>`;
}

/* 綁行動面板的事件；rerender 由呼叫端（today.js）給，開完一局回到今日分頁。 */
export function wireHomePanel(el, todayLog, rerender) {
  const lesson = newestLesson();
  const { task1Done, task2Done, task3Done } = gameTaskState(todayLog);

  const startListen = () => {
    if (!lesson || !lesson.cards?.length) return;
    listenGame.startListenGame(lesson, state.progress);
    rerender();
  };
  const startCombo = () => {
    if (!lesson) return;
    comboGame.startComboReview(allCardsWithLessonId(), state.progress, lesson.id);
    rerender();
  };
  const startDialogue = () => {
    if (!state.dialogues.length) return;
    dialogueGame.startDialogueGame(state.dialogues);
    rerender();
  };
  const startNext = () => {
    if (!task1Done) startListen();
    else if (!task2Done) startCombo();
    else if (!task3Done && state.dialogues.length) startDialogue();
    else startListen();
  };

  el.querySelector('[data-home-start-game]')?.addEventListener('click', startNext);
  el.querySelector('[data-home-task-btn="1"]')?.addEventListener('click', startListen);
  el.querySelector('[data-home-task-btn="2"]')?.addEventListener('click', startCombo);
  el.querySelector('[data-home-task-btn="3"]')?.addEventListener('click', startDialogue);

  getDailySentence(state.lessons).then(result => {
    const box = document.getElementById('homeSentenceBox');
    fillDailySentence(box, result);
    const playBtn = document.getElementById('homeSentencePlay');
    if (playBtn && result?.card?.thai) {
      playBtn.addEventListener('click', e => {
        e.stopPropagation();
        speakCard(result.card);
      });
    }
  }).catch(() => {});
}
