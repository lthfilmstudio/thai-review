/* 第 2 局：連擊複習。跨所有課程的到期／弱字，最新一堂加權優先（設計書 8 節）。
   翻卡自我回報「記得／沒想起來」，不寫 SRS grade（§7、§16 第 2 項）。
   選卡邏輯（buildComboReview）跟 render 狀態機分開，前者可單獨測試。 */

import { escapeHtml } from './ui.js';
import { speakCard, unlockAudioPlayback } from './tts.js';
import { logGame } from './today.js';
import { isDue, normalizeGrade, daysUntil, formatNextReview } from './srs.js';

const SVG_REPLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 2.6 6.3"/><path d="M3 21v-6h6"/></svg>';
const SVG_CROSS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const COUNT = 6;

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 純函式：組出這一局的 6 張卡。
   candidates 只取 thai/zh 都非空、且帶 _lessonId 的卡（跨課程攤平後的格式，
   跟 state.js allCardsWithLessonId() 一致）。
   1. 全部課程今天到期的卡（getDueCards 的邏輯，這裡重寫一份是因為還要分課程加權）。
   2. 湊不滿才補全部課程近期答錯／ease factor 偏低的卡。
   3. 前兩項都湊不滿才補最新一堂尚未接觸的新卡。
   每一步「最新一堂」的卡都排在同類別最前面（加權優先），但不是唯一來源——
   夠不到 6 張時，其他課程的卡照樣補進來（設計書 8 節：只鎖最新一堂會餓死舊課到期卡）。 */
export function buildComboReview(allCards, progress, newestLessonId, { count = COUNT, rng = Math.random } = {}) {
  const candidates = (allCards || []).filter(c => c?.thai && c?.zh && c?._lessonId);
  const key = c => `${c._lessonId}:${c.thai}`;

  const picked = [];
  const pickedKeys = new Set();
  function addFrom(list) {
    for (const c of list) {
      if (picked.length >= count) return;
      const k = key(c);
      if (pickedKeys.has(k)) continue;
      pickedKeys.add(k);
      picked.push(c);
    }
  }
  // 同類別內把最新一堂的卡排到前面，不是唯一來源
  function weightNewest(list) {
    const mine = [], others = [];
    for (const c of list) (c._lessonId === newestLessonId ? mine : others).push(c);
    return [...mine, ...others];
  }

  const now = Date.now();
  const dueCards = candidates
    .filter(c => isDue(progress[key(c)], now))
    .sort((a, b) => (progress[key(a)]?.nextReviewAt ?? 0) - (progress[key(b)]?.nextReviewAt ?? 0));
  addFrom(weightNewest(dueCards));

  if (picked.length < count) {
    const weakCards = candidates
      .filter(c => {
        const entry = progress[key(c)];
        if (!entry || typeof entry !== 'object') return false;
        const g = normalizeGrade(entry.grade);
        return g === 'again' || g === 'hard';
      })
      .sort((a, b) => {
        const ga = normalizeGrade(progress[key(a)].grade);
        const gb = normalizeGrade(progress[key(b)].grade);
        if (ga !== gb) return ga === 'again' ? -1 : 1;
        return (progress[key(a)].easeFactor ?? 2.5) - (progress[key(b)].easeFactor ?? 2.5);
      });
    addFrom(weightNewest(weakCards));
  }

  if (picked.length < count) {
    const unseen = shuffle(
      candidates.filter(c => c._lessonId === newestLessonId && !progress[key(c)]),
      rng,
    );
    addFrom(unseen);
  }

  return picked.map(card => ({ card, entry: progress[key(card)] || null }));
}

/* ===== render 狀態機（module-local，同 game-listen.js 的寫法） ===== */

let session = null;

export function startComboReview(allCards, progress, newestLessonId, opts = {}) {
  session = {
    questions: buildComboReview(allCards, progress, newestLessonId, opts),
    idx: 0,
    combo: 0,
    maxCombo: 0,
    correct: 0,
    flipped: false,
    wrongCards: [],
    logged: false,
  };
}

export function isComboReviewActive() {
  return !!session;
}

export function exitComboReview() {
  session = null;
}

function playCurrentCard() {
  const q = session?.questions[session.idx];
  if (!q) return;
  unlockAudioPlayback();
  speakCard(q.card);
}

function renderQuestion(el, { onExit }, storage) {
  const q = session.questions[session.idx];
  const total = session.questions.length;
  const flipped = session.flipped;

  el.innerHTML = `
    <div class="gcr-wrap">
      <div class="gcr-head">
        <button class="gcr-exit" data-gcr-exit aria-label="回首頁">${SVG_CROSS}</button>
        <div class="gcr-progress">第 ${session.idx + 1} / ${total} 張</div>
        <div class="gcr-combo">連擊 ${session.combo}</div>
      </div>
      <div class="gcr-card${flipped ? ' flipped' : ''}" data-gcr-flip>
        <div class="gcr-card-thai">${escapeHtml(q.card.thai)}</div>
        ${flipped ? `
          <div class="gcr-card-karaoke">${escapeHtml(q.card.karaoke || '')}</div>
          <div class="gcr-card-divider"></div>
          <div class="gcr-card-zh">${escapeHtml(q.card.zh)}</div>
        ` : `<div class="gcr-flip-hint">點卡片看意思</div>`}
      </div>
      <button class="gcr-replay" data-gcr-replay type="button" aria-label="重聽">${SVG_REPLAY}<span>重聽</span></button>
      ${flipped ? `
        <div class="gcr-report-row">
          <button class="gcr-report bad" data-gcr-report="false" type="button">沒想起來</button>
          <button class="gcr-report good" data-gcr-report="true" type="button">記得</button>
        </div>
      ` : ''}
    </div>
  `;

  el.querySelector('[data-gcr-exit]')?.addEventListener('click', () => { exitComboReview(); onExit?.(); });
  el.querySelector('[data-gcr-replay]')?.addEventListener('click', playCurrentCard);

  if (!flipped) {
    // 卡片一出來自動播一次；翻面後不重播，重聽鈕仍可手動再聽
    playCurrentCard();
    el.querySelector('[data-gcr-flip]')?.addEventListener('click', () => {
      session.flipped = true;
      renderQuestion(el, { onExit }, storage);
    });
  } else {
    el.querySelectorAll('[data-gcr-report]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gotIt = btn.dataset.gcrReport === 'true';
        if (gotIt) {
          session.combo++;
          session.correct++;
          session.maxCombo = Math.max(session.maxCombo, session.combo);
        } else {
          session.combo = 0;
          session.wrongCards.push(q);
        }
        session.idx++;
        session.flipped = false;
        render(el, { onExit }, storage);
      });
    });
  }
}

function renderSummary(el, { onExit }, storage) {
  if (!session.logged) {
    session.logged = true;
    logGame('combo', Date.now(), storage);
  }
  const total = session.questions.length;
  const wrong = session.wrongCards;

  el.innerHTML = `
    <div class="gcr-wrap gcr-summary">
      <div class="gcr-summary-score">${total} 張中記得 ${session.correct} 張</div>
      <div class="gcr-summary-combo">最高連擊 ${session.maxCombo}</div>
      ${wrong.length ? `
        <div class="gcr-summary-sub">需要再練的字</div>
        <div class="gcr-wrong-list">
          ${wrong.map((q, i) => {
            const days = q.entry?.nextReviewAt ? daysUntil(q.entry.nextReviewAt) : null;
            const hint = days !== null ? `下次複習：${formatNextReview(days)}` : '';
            return `
            <button class="gcr-wrong-item" data-gcr-replay-wrong="${i}">
              <span class="gcr-wrong-thai">${escapeHtml(q.card.thai)}</span>
              <span class="gcr-wrong-zh">${escapeHtml(q.card.zh)}</span>
              ${hint ? `<span class="gcr-wrong-hint">${escapeHtml(hint)}</span>` : ''}
              ${SVG_REPLAY}
            </button>`;
          }).join('')}
        </div>
      ` : `<div class="gcr-summary-sub">全部記得，很好。</div>`}
      <button class="gcr-back-home" data-gcr-back-home type="button">回首頁</button>
    </div>
  `;

  wrong.forEach((q, i) => {
    el.querySelector(`[data-gcr-replay-wrong="${i}"]`)?.addEventListener('click', () => {
      unlockAudioPlayback();
      speakCard(q.card);
    });
  });
  el.querySelector('[data-gcr-back-home]')?.addEventListener('click', () => { exitComboReview(); onExit?.(); });
}

export function render(el, { onExit } = {}, storage) {
  if (!session) { el.innerHTML = ''; return; }
  if (session.idx >= session.questions.length) {
    renderSummary(el, { onExit }, storage);
  } else {
    renderQuestion(el, { onExit }, storage);
  }
}
