/* 第 1 局：音感挑戰。播老師泰文音，選中文意思。
   選卡優先該堂沒接觸過的新卡，刻意不碰 SRS 到期／弱卡（那是第 2 局的工作，
   避免兩局考同一批，見設計書 4 節、8 節）。純函式部分（buildListenChallenge）
   跟 render／播放狀態機分開，前者可單獨測試。 */

import { escapeHtml } from './ui.js';
import { speakCard, unlockAudioPlayback } from './tts.js';
import { logGame } from './today.js';

const SVG_REPLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 2.6 6.3"/><path d="M3 21v-6h6"/></svg>';
const SVG_CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_CROSS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 純函式：組出這一局的題目。
   candidates 只取 thai/zh 都非空的卡；優先沒接觸過的新卡（progress 沒有該卡 key），
   湊不滿 count 才用已學過的卡補。干擾項依 zh 去重，避免同義字互相干擾。 */
export function buildListenChallenge(lesson, progress, { count = 5, rng = Math.random } = {}) {
  const lessonId = lesson?.id || '';
  const candidates = (lesson?.cards || []).filter(c => c?.thai && c?.zh);
  if (!candidates.length) return [];

  const isNew = c => !progress?.[`${lessonId}:${c.thai}`];
  const fresh = shuffle(candidates.filter(isNew), rng);
  const learned = shuffle(candidates.filter(c => !isNew(c)), rng);
  const pool = [...fresh, ...learned].slice(0, count);

  return pool.map(card => {
    const distractorPool = [];
    const seenZh = new Set([card.zh]);
    for (const c of shuffle(candidates, rng)) {
      if (c === card || seenZh.has(c.zh)) continue;
      seenZh.add(c.zh);
      distractorPool.push(c.zh);
      if (distractorPool.length >= 3) break;
    }
    const options = shuffle([card.zh, ...distractorPool], rng);
    return { card, options, answerIndex: options.indexOf(card.zh) };
  });
}

/* ===== render 狀態機（module-local，跟 today.js 的 statsTab 同一種寫法） ===== */

let session = null;

export function startListenGame(lesson, progress, opts = {}) {
  session = {
    questions: buildListenChallenge(lesson, progress, { count: 5, ...opts }),
    idx: 0,
    correct: 0,
    answered: null,
    logged: false,
  };
}

export function isListenGameActive() {
  return !!session;
}

export function exitListenGame() {
  session = null;
}

function playCurrentCard() {
  const q = session?.questions[session.idx];
  if (!q) return;
  unlockAudioPlayback();
  speakCard(q.card);
}

function renderQuestion(el, { onExit }) {
  const q = session.questions[session.idx];
  const total = session.questions.length;
  const answered = session.answered !== null;

  el.innerHTML = `
    <div class="glg-wrap">
      <div class="glg-head">
        <button class="glg-exit" data-glg-exit aria-label="回首頁">${SVG_CROSS}</button>
        <div class="glg-progress">第 ${session.idx + 1} / ${total} 句</div>
        <div class="glg-streak">連對 ${session.streak || 0}</div>
      </div>
      <button class="glg-replay" data-glg-replay aria-label="重聽">${SVG_REPLAY}<span>重聽</span></button>
      <div class="glg-options">
        ${q.options.map((opt, i) => {
          let cls = 'glg-opt';
          if (answered) {
            if (i === q.answerIndex) cls += ' correct';
            else if (i === session.answered) cls += ' wrong';
          }
          return `<button class="${cls}" data-glg-opt="${i}" ${answered ? 'disabled' : ''}>${escapeHtml(opt)}</button>`;
        }).join('')}
      </div>
      ${answered ? renderFeedback(q, session.answered === q.answerIndex) : ''}
    </div>
  `;

  el.querySelector('[data-glg-exit]')?.addEventListener('click', () => { exitListenGame(); onExit?.(); });
  el.querySelector('[data-glg-replay]')?.addEventListener('click', playCurrentCard);

  // 題目一出來自動播一次；只在「還沒作答」時播，答完後重畫 feedback 不會走到這裡（answered 已非 null）。
  if (!answered) playCurrentCard();

  if (!answered) {
    el.querySelectorAll('[data-glg-opt]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.glgOpt);
        session.answered = i;
        session.streak = i === q.answerIndex ? (session.streak || 0) + 1 : 0;
        if (i === q.answerIndex) session.correct++;
        else session.wrongCards = [...(session.wrongCards || []), q.card];
        renderQuestion(el, { onExit });
      });
    });
  } else {
    el.querySelector('[data-glg-replay-correct]')?.addEventListener('click', () => {
      unlockAudioPlayback();
      speakCard(q.card);
    });
    el.querySelector('[data-glg-next]')?.addEventListener('click', () => {
      session.idx++;
      session.answered = null;
      render(el, { onExit });
    });
  }
}

function renderFeedback(q, gotIt) {
  return `
    <div class="glg-feedback ${gotIt ? 'good' : 'bad'}">
      <div class="glg-feedback-mark">${gotIt ? SVG_CHECK : SVG_CROSS}</div>
      ${!gotIt ? `
        <div class="glg-answer-card">
          <div class="glg-answer-thai">${escapeHtml(q.card.thai)}</div>
          <div class="glg-answer-karaoke">${escapeHtml(q.card.karaoke || '')}</div>
          <button class="glg-answer-replay" data-glg-replay-correct type="button">${SVG_REPLAY}<span>重聽正解</span></button>
        </div>
      ` : ''}
      <div class="glg-shadow-hint">你可以跟著唸一次</div>
      <button class="glg-next" data-glg-next type="button">下一句</button>
    </div>
  `;
}

function renderSummary(el, { onExit }) {
  if (!session.logged) {
    session.logged = true;
    logGame('listen');
  }
  const total = session.questions.length;
  const wrong = session.wrongCards || [];

  el.innerHTML = `
    <div class="glg-wrap glg-summary">
      <div class="glg-summary-score">${total} 句中對了 ${session.correct} 句</div>
      ${wrong.length ? `
        <div class="glg-summary-sub">需要再聽的句子</div>
        <div class="glg-wrong-list">
          ${wrong.map((card, i) => `
            <button class="glg-wrong-item" data-glg-replay-wrong="${i}">
              <span class="glg-wrong-thai">${escapeHtml(card.thai)}</span>
              <span class="glg-wrong-zh">${escapeHtml(card.zh)}</span>
              ${SVG_REPLAY}
            </button>
          `).join('')}
        </div>
      ` : `<div class="glg-summary-sub">全對，很好。</div>`}
      <button class="glg-back-home" data-glg-back-home type="button">回首頁</button>
    </div>
  `;

  wrong.forEach((card, i) => {
    el.querySelector(`[data-glg-replay-wrong="${i}"]`)?.addEventListener('click', () => {
      unlockAudioPlayback();
      speakCard(card);
    });
  });
  el.querySelector('[data-glg-back-home]')?.addEventListener('click', () => { exitListenGame(); onExit?.(); });
}

export function render(el, { onExit } = {}) {
  if (!session) { el.innerHTML = ''; return; }
  if (session.idx >= session.questions.length) {
    renderSummary(el, { onExit });
  } else {
    renderQuestion(el, { onExit });
  }
}
