/* 字卡模式 render。翻面走 .card-inner 整層旋轉
   （prefers-reduced-motion 時在 CSS 改 cross-fade）。
   reverse=true：中文在正面、泰文在背面。 */

import { state, gradeOf, setGrade } from './state.js';
import { speakCard } from './tts.js';
import { escapeHtml } from './ui.js';

const SVG_PLAY = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>';
const SVG_CHEV_L = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const SVG_CHEV_R = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
const SVG_EXT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';

function youglishUrl(thai) {
  // YouGlish 後端（Tomcat）擋 encoded slash，而泰文資料常有 "ค่ะ / ครับ" 這種男女變體；
  // 取 / 前第一段當搜尋詞最乾淨（是完整片語，搜得到真人影片）。
  const term = (thai || '').split('/')[0].trim();
  return 'https://youglish.com/pronounce/' + encodeURIComponent(term) + '/thai';
}

function frontBody(card, reverse) {
  if (reverse) {
    return `
      <div class="thai-stack">
        <div class="zh" style="font-size:clamp(22px,4.2vw,30px)">${escapeHtml(card.zh)}</div>
        ${card.note ? `<div class="zh-note">（${escapeHtml(card.note)}）</div>` : ''}
      </div>
    `;
  }
  return `
    <div class="thai-stack">
      <div class="thai-main">${escapeHtml(card.thai)}</div>
      <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
    </div>
  `;
}

function backBody(card, reverse) {
  if (reverse) {
    // 反向的「答案面」＝ 泰文 + 拼音（中文已在正面，不再重複）
    return `
      <div class="thai-stack">
        <div class="thai-main">${escapeHtml(card.thai)}</div>
        <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
      </div>
      <div class="karaoke">${escapeHtml(card.karaoke)}</div>
    `;
  }
  return `
    <div class="thai-stack">
      <div class="thai-main thai-back">${escapeHtml(card.thai)}</div>
      <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
    </div>
    <div class="karaoke">${escapeHtml(card.karaoke)}</div>
    <div class="divider"></div>
    <div class="zh">${escapeHtml(card.zh)}${card.note ? `<br><span class="zh-note">（${escapeHtml(card.note)}）</span>` : ''}</div>
  `;
}

export function renderCardMode(el, cards, onGrade, opts = {}) {
  const reverse = !!opts.reverse;
  const i = state.cardIndex;
  const card = cards[i];
  const pct = Math.round(((i + 1) / cards.length) * 100);
  const grade = gradeOf(i);
  const tag = card.type === 'sentence' ? 'EXAMPLE' : 'VOCAB';

  el.innerHTML = `
    <div class="progress-row">
      <button class="nav-btn" id="cardPrev" aria-label="上一張" title="上一張 (←)">${SVG_CHEV_L}</button>
      <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="progress-count">${i + 1} / ${cards.length}</div>
      <button class="nav-btn" id="cardNext" aria-label="下一張" title="下一張 (→)">${SVG_CHEV_R}</button>
    </div>
    <div class="card-stage${state.flipped ? ' flipped' : ''}" id="cardStage">
      <div class="card-inner">
        <div class="card front">
          <div class="card-tag">${tag}</div>
          ${frontBody(card, reverse)}
          <button class="play-btn" id="playFront" aria-label="播放">${SVG_PLAY}</button>
          <div class="flip-hint">TAP CARD TO FLIP</div>
        </div>
        <div class="card back">
          <div class="card-tag">${tag}</div>
          ${backBody(card, reverse)}
          <div class="back-actions">
            <button class="play-btn" id="playBack" aria-label="再聽一次">${SVG_PLAY}</button>
            <a class="yg-btn" id="ygLink" href="${youglishUrl(card.thai)}" target="_blank" rel="noopener noreferrer" aria-label="在 YouGlish 聽真人發音">
              ${SVG_EXT}<span>聽真人</span>
            </a>
          </div>
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
    if (e.target.closest('.play-btn') || e.target.closest('.pill') || e.target.closest('.yg-btn')) return;
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
