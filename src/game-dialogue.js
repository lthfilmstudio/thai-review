/* 第 3 局：固定生活對話。逐句走完一組 6 句 A/B 對話，可重聽單句與整段。
   素材來自 Sheet「生活對話」分頁，不呼叫既有 Gemini 即時對話 mode。 */

import { escapeHtml } from './ui.js';
import { cancelSpeech, speakCard, speakWithPromise, unlockAudioPlayback } from './tts.js';
import { logGame } from './today.js';

const SVG_REPLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 2.6 6.3"/><path d="M3 21v-6h6"/></svg>';
const SVG_CROSS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function isCompleteScenario(item) {
  if (!item?.id || !item?.title || !Array.isArray(item.turns) || item.turns.length !== 6) return false;
  return item.turns.every((turn, index) => (
    turn?.order === index + 1
    && turn.speaker === (index % 2 ? 'B' : 'A')
    && turn.thai && turn.karaoke && turn.zh
  ));
}

export function buildDialogueRound(dialogues, { excludeId = '', rng = Math.random } = {}) {
  const complete = (dialogues || []).filter(isCompleteScenario);
  if (!complete.length) return null;
  const candidates = complete.length > 1 && excludeId
    ? complete.filter(item => item.id !== excludeId)
    : complete;
  const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return candidates[index] || null;
}

export async function playDialogueTurns(dialogue, playTurn = speakWithPromise, shouldContinue = () => true) {
  for (const turn of dialogue?.turns || []) {
    if (!shouldContinue()) return false;
    await playTurn(turn);
    if (!shouldContinue()) return false;
  }
  return true;
}

let session = null;
let replayGeneration = 0;

export function startDialogueGame(dialogues, opts = {}) {
  const dialogue = buildDialogueRound(dialogues, opts);
  if (!dialogue) return false;
  replayGeneration++;
  cancelSpeech();
  session = { dialogues, dialogue, idx: 0, playedIdx: -1, logged: false };
  return true;
}

export function isDialogueGameActive() {
  return !!session;
}

export function exitDialogueGame() {
  replayGeneration++;
  cancelSpeech();
  session = null;
}

function playCurrentTurn() {
  const turn = session?.dialogue.turns[session.idx];
  if (!turn) return;
  unlockAudioPlayback();
  speakCard(turn);
}

function renderTurn(el, { onExit }, storage) {
  const { dialogue, idx } = session;
  const visibleTurns = dialogue.turns.slice(0, idx + 1);

  el.innerHTML = `
    <div class="gdg-wrap">
      <div class="gdg-head">
        <button class="gdg-exit" data-gdg-exit aria-label="回首頁">${SVG_CROSS}</button>
        <div class="gdg-title">${escapeHtml(dialogue.title)}</div>
        <div class="gdg-progress">第 ${idx + 1} / 6 句</div>
      </div>
      <div class="gdg-conversation">
        ${visibleTurns.map((turn, turnIndex) => `
          <div class="gdg-turn speaker-${turn.speaker.toLowerCase()}${turnIndex === idx ? ' current' : ''}">
            <div class="gdg-speaker">${turn.speaker}</div>
            <div class="gdg-bubble">
              <div class="gdg-thai">${escapeHtml(turn.thai)}</div>
              <div class="gdg-karaoke">${escapeHtml(turn.karaoke)}</div>
              <div class="gdg-zh">${escapeHtml(turn.zh)}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <button class="gdg-replay" data-gdg-replay type="button">${SVG_REPLAY}<span>重聽這句</span></button>
      <button class="gdg-next" data-gdg-next type="button">${idx === 5 ? '完成對話' : '下一句'}</button>
    </div>
  `;

  el.querySelector('[data-gdg-exit]')?.addEventListener('click', () => {
    exitDialogueGame();
    onExit?.();
  });
  el.querySelector('[data-gdg-replay]')?.addEventListener('click', playCurrentTurn);
  el.querySelector('[data-gdg-next]')?.addEventListener('click', () => {
    session.idx++;
    render(el, { onExit }, storage);
  });

  if (session.playedIdx !== idx) {
    session.playedIdx = idx;
    playCurrentTurn();
  }
}

function renderSummary(el, { onExit }, storage) {
  if (!session.logged) {
    session.logged = true;
    logGame('dialog', Date.now(), storage);
  }
  const { dialogue } = session;

  el.innerHTML = `
    <div class="gdg-wrap gdg-summary">
      <div class="gdg-summary-title">完成「${escapeHtml(dialogue.title)}」</div>
      <div class="gdg-summary-progress">對話完成度 6 / 6</div>
      <button class="gdg-summary-primary" data-gdg-replay-all type="button">${SVG_REPLAY}<span>重播整段</span></button>
      <button class="gdg-summary-secondary" data-gdg-another type="button">再挑一組</button>
      <button class="gdg-summary-secondary" data-gdg-home type="button">回首頁</button>
    </div>
  `;

  el.querySelector('[data-gdg-replay-all]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const generation = ++replayGeneration;
    button.disabled = true;
    button.querySelector('span').textContent = '播放中…';
    unlockAudioPlayback();
    await playDialogueTurns(
      dialogue,
      speakWithPromise,
      () => generation === replayGeneration && session?.dialogue === dialogue && button.isConnected,
    );
    if (!button.isConnected) return;
    button.disabled = false;
    button.querySelector('span').textContent = '重播整段';
  });
  el.querySelector('[data-gdg-another]')?.addEventListener('click', () => {
    const previousId = dialogue.id;
    const dialogues = session.dialogues || [dialogue];
    startDialogueGame(dialogues, { excludeId: previousId });
    render(el, { onExit }, storage);
  });
  el.querySelector('[data-gdg-home]')?.addEventListener('click', () => {
    exitDialogueGame();
    onExit?.();
  });
}

export function render(el, { onExit } = {}, storage) {
  if (!session) { el.innerHTML = ''; return; }
  if (session.idx >= session.dialogue.turns.length) renderSummary(el, { onExit }, storage);
  else renderTurn(el, { onExit }, storage);
}
