/* 字卡 / 例句模式 render。翻面走 .card-inner 整層旋轉
   （prefers-reduced-motion 時在 CSS 改 cross-fade）。 */

import { state, gradeOf, setGrade } from './state.js';
import { speakCard } from './tts.js';
import { escapeHtml } from './ui.js';

export function renderCardMode(el, cards, onGrade) {
  const i = state.cardIndex;
  const card = cards[i];
  const pct = Math.round(((i + 1) / cards.length) * 100);
  const grade = gradeOf(i);

  el.innerHTML = `
    <div class="progress-row">
      <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="progress-count">${i + 1} / ${cards.length}</div>
    </div>
    <div class="card-stage${state.flipped ? ' flipped' : ''}" id="cardStage">
      <div class="card-inner">
        <div class="card front">
          <div class="card-tag">${card.type === 'sentence' ? 'EXAMPLE' : 'VOCAB'}</div>
          <div class="thai-stack">
            <div class="thai-main">${escapeHtml(card.thai)}</div>
            <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
          </div>
          <button class="play-btn" id="playFront" aria-label="播放">
            <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>
          </button>
          <div class="flip-hint">TAP CARD TO FLIP</div>
        </div>
        <div class="card back">
          <div class="card-tag">${card.type === 'sentence' ? 'EXAMPLE' : 'VOCAB'}</div>
          <div class="thai-stack">
            <div class="thai-main" style="font-size:clamp(22px,4.5vw,36px)">${escapeHtml(card.thai)}</div>
            <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
          </div>
          <div class="karaoke">${escapeHtml(card.karaoke)}</div>
          <div class="divider"></div>
          <div class="zh">${escapeHtml(card.zh)}${card.note ? `<br><span class="zh-note">（${escapeHtml(card.note)}）</span>` : ''}</div>
          <button class="play-btn" id="playBack" aria-label="再聽一次">
            <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="grade-row">
      <button class="pill red${grade === 'bad' ? ' active' : ''}" data-grade="bad">不熟</button>
      <button class="pill neutral${grade === 'ok' ? ' active' : ''}" data-grade="ok">普通</button>
      <button class="pill gold${grade === 'good' ? ' active' : ''}" data-grade="good">會了</button>
    </div>
  `;

  const stage = document.getElementById('cardStage');
  stage.addEventListener('click', e => {
    if (e.target.closest('.play-btn') || e.target.closest('.pill')) return;
    state.flipped = !state.flipped;
    stage.classList.toggle('flipped', state.flipped);
  });
  document.getElementById('playFront').addEventListener('click', e => {
    e.stopPropagation();
    speakCard(card);
  });
  document.getElementById('playBack').addEventListener('click', e => {
    e.stopPropagation();
    speakCard(card);
  });
  el.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setGrade(state.cardIndex, btn.dataset.grade);
      onGrade?.();
    });
  });
}
