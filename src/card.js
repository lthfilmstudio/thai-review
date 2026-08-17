/* 字卡模式 render。翻面走 .card-inner 整層旋轉
   （prefers-reduced-motion 時在 CSS 改 cross-fade）。
   reverse=true：中文在正面、泰文在背面。 */

import { state, isFavorite, toggleFavorite, srsEntryOf } from './state.js';
import { speakCard } from './tts.js';
import { escapeHtml } from './ui.js';
import { wireSentenceButton, SVG_SPARK_ICON } from './sentence.js';
import { nextReview, formatNextReview } from './srs.js';

const SVG_PLAY = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>';

const SVG_CHEV_L = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const SVG_CHEV_R = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
const SVG_EXT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
const SVG_EDIT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const SVG_STAR_OUTLINE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SVG_STAR_FILLED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

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

export function renderCardMode(el, cards, _onGrade, opts = {}) {
  const reverse = !!opts.reverse;
  const i = state.cardIndex;
  const card = cards[i];
  const pct = Math.round(((i + 1) / cards.length) * 100);
  const tag = card.type === 'sentence' ? 'EXAMPLE' : 'VOCAB';

  // 預覽 4 個評分按下去後的間隔（給每顆 pill 帶 meta 文字）
  const cur = srsEntryOf(card) || {};
  const previewAgain = formatNextReview(nextReview('again', cur).interval);
  const previewHard = formatNextReview(nextReview('hard', cur).interval);
  const previewGood = formatNextReview(nextReview('good', cur).interval);
  const previewEasy = formatNextReview(nextReview('easy', cur).interval);

  const showReviewHint = state.mode === 'card' || state.mode === 'reverse';
  const dueCount = Number(opts.dueCount || 0);
  const reviewHint = dueCount > 0
    ? `<div class="review-hint-title">今天有 ${dueCount} 張待複習</div>
       <div class="review-hint-sub">先練到期的字，再繼續新卡。</div>
       <button class="review-start-btn" data-start-review>開始</button>`
    : `<div class="review-hint-title">按重來 / 有點難 / 可以 / 很熟，系統會安排複習</div>
       <div class="review-hint-sub">評過的字會在適合的時間再次出現。</div>`;

  el.innerHTML = `
    ${showReviewHint ? `
      <div class="review-hint${dueCount > 0 ? ' due' : ''}">
        ${reviewHint}
      </div>
    ` : ''}
    <div class="progress-row">
      <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="progress-count">${i + 1} / ${cards.length}</div>
    </div>
    <div class="card-stage${state.flipped ? ' flipped' : ''}" id="cardStage">
      <div class="card-inner">
        <div class="card front">
          <div class="card-tag">${tag}</div>
          ${frontBody(card, reverse)}
          <div class="flip-hint">TAP CARD TO FLIP</div>
        </div>
        <div class="card back">
          <div class="card-tag">${tag}</div>
          ${backBody(card, reverse)}
          <div class="back-actions">
            <button class="play-btn" id="playBack" aria-label="播放">${SVG_PLAY}</button>
            <a class="yg-btn" href="${youglishUrl(card.thai)}" target="_blank" rel="noopener noreferrer" aria-label="在 YouGlish 聽真人發音">
              ${SVG_EXT}<span>聽真人</span>
            </a>
            <button class="sent-btn" id="sentBtn" aria-label="AI 造例句">
              ${SVG_SPARK_ICON}<span>造 3 句</span>
            </button>
            <button class="edit-card-btn" data-edit-card-key="${escapeHtml(card._cardKey || '')}" aria-label="編輯">
              ${SVG_EDIT}<span>編輯</span>
            </button>
          </div>
          <div class="sent-list" id="sentList"></div>
        </div>
      </div>
    </div>
    <div class="grade-row" aria-label="評分">
      <button class="pill red" data-grade="again" aria-label="重來，明天再練">
        重來<span class="pill-meta">明天再練</span><span class="pill-time">${escapeHtml(previewAgain)}</span>
      </button>
      <button class="pill orange" data-grade="hard" aria-label="有點難，較快複習">
        有點難<span class="pill-meta">較快複習</span><span class="pill-time">${escapeHtml(previewHard)}</span>
      </button>
      <button class="pill neutral" data-grade="good" aria-label="可以，正常複習">
        可以<span class="pill-meta">正常複習</span><span class="pill-time">${escapeHtml(previewGood)}</span>
      </button>
      <button class="pill gold" data-grade="easy" aria-label="很熟，晚點再出現">
        很熟<span class="pill-meta">晚點再出現</span><span class="pill-time">${escapeHtml(previewEasy)}</span>
      </button>
    </div>
    <div class="card-nav-row">
      <button class="nav-side-btn" id="cardPrev" aria-label="上一張">${SVG_CHEV_L}<span>上一張</span></button>
      <button class="fav-btn${isFavorite(card) ? ' on' : ''}" id="favBtn" aria-label="收藏">
        ${isFavorite(card) ? SVG_STAR_FILLED : SVG_STAR_OUTLINE}
      </button>
      <button class="fav-btn edit-nav-btn" data-edit-card-key="${escapeHtml(card._cardKey || '')}" aria-label="編輯這張卡">
        ${SVG_EDIT}
      </button>
      <button class="nav-side-btn" id="cardNext" aria-label="下一張"><span>下一張</span>${SVG_CHEV_R}</button>
    </div>
  `;

  const stage = document.getElementById('cardStage');
  stage.addEventListener('click', e => {
    if (
      e.target.closest('.play-btn') ||
      e.target.closest('.yg-btn') ||
      e.target.closest('.sent-btn') ||
      e.target.closest('.edit-card-btn') ||
      e.target.closest('.sent-list')
    ) return;
    state.flipped = !state.flipped;
    stage.classList.toggle('flipped', state.flipped);
  });

  document.getElementById('playBack')?.addEventListener('click', e => {
    e.stopPropagation();
    speakCard(card);
  });

  // AI 造句：傳卡片的泰文當 word；按下去 fetch、render；不影響翻面
  const sentBtn = document.getElementById('sentBtn');
  const sentList = document.getElementById('sentList');
  if (sentBtn && sentList) {
    wireSentenceButton(sentBtn, sentList, card.thai);
  }

  const favBtn = document.getElementById('favBtn');
  favBtn?.addEventListener('click', e => {
    e.stopPropagation();
    toggleFavorite(card);
    favBtn.classList.toggle('on');
    favBtn.innerHTML = isFavorite(card) ? SVG_STAR_FILLED : SVG_STAR_OUTLINE;
  });
}
