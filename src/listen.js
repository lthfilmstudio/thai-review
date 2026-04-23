/* 被動聽力模式：老師語音 → 跟讀空白 → 重複 N 次 → 下一張。
   手機鎖屏背景播放靠 Media Session API + 一條極短的靜音 audio loop
   （index.html 裡的 #silentLoop）保持 audio session active。 */

import { state, filteredCards } from './state.js';
import { speakWithPromise, estimateTeacherMs } from './tts.js';
import { escapeHtml } from './ui.js';

let onAdvance = null;   // 切卡後的 callback（由 app.js 注入，用來重繪 UI）
let silentAudio = null;

export function renderListenMode(el, cards, advanceCb) {
  onAdvance = advanceCb;
  silentAudio = silentAudio || document.getElementById('silentLoop');

  const i = state.cardIndex;
  const card = cards[i];
  const rep = state.settings.repeat;
  const curRep = state.listen.repeatCount;

  el.innerHTML = `
    <div class="listen-wrap">
      <div class="listen-card">
        <div class="listen-info">第 ${i + 1} / ${cards.length} · 重複 ${Math.min(curRep + 1, rep)}/${rep}</div>
        <div class="listen-body">
          <div class="thai-main thai-listen">${escapeHtml(card.thai)}</div>
          <div class="thai-sub-text">${escapeHtml(card.thai)}</div>
        </div>
        <div class="listen-kara">${escapeHtml(card.karaoke)}</div>
        <div class="listen-zh">${escapeHtml(card.zh)}</div>
        <div class="listen-divider"></div>
        <div class="phase-row"><div class="phase-dot teacher"></div><div class="phase-label">老師語音</div></div>
        <div class="phase-track"><div class="phase-fill teacher" id="barT"></div></div>
        <div class="phase-row"><div class="phase-dot repeat"></div><div class="phase-label">換你跟讀</div></div>
        <div class="phase-track"><div class="phase-fill repeat" id="barR"></div></div>
        <div class="listen-spacer"></div>
        <div class="listen-controls">
          <button class="l-btn" id="lPrev" aria-label="上一張">◀◀</button>
          <button class="l-main" id="lPlay" aria-label="${state.listen.playing ? '暫停' : '播放'}">${state.listen.playing ? '❚❚' : '▶'}</button>
          <button class="l-btn" id="lNext" aria-label="下一張">▶▶</button>
        </div>
      </div>
      <div class="listen-settings">
        <div class="setting-row">
          <div class="setting-label">重複次數</div>
          <div style="font-size:12px;font-weight:500">${rep}×</div>
        </div>
        <div class="setting-row">
          <div class="setting-label">跟讀間隔</div>
          <div style="font-size:12px;font-weight:500">${state.settings.gap === 'auto' ? '自動' : state.settings.gap + 's'}</div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('lPlay').addEventListener('click', toggleListen);
  document.getElementById('lPrev').addEventListener('click', () => { stopListen(); prevInList(); });
  document.getElementById('lNext').addEventListener('click', () => { stopListen(); nextInList(); });

  updateMediaSessionMetadata(card);
}

export function toggleListen() {
  if (state.listen.playing) stopListen();
  else startListen();
}

export function startListen() {
  state.listen.playing = true;
  state.listen.repeatCount = 0;
  startSilentLoop();
  registerMediaSessionHandlers();
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing');
  runListenStep();
  updatePlayBtn('❚❚', '暫停');
}

export function stopListen() {
  state.listen.playing = false;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  cancelAnimationFrame(state.listen.rafId);
  clearTimeout(state.listen.timeoutId);
  const barT = document.getElementById('barT'); if (barT) barT.style.width = '0';
  const barR = document.getElementById('barR'); if (barR) barR.style.width = '0';
  stopSilentLoop();
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused');
  updatePlayBtn('▶', '播放');
}

function updatePlayBtn(label, aria) {
  const btn = document.getElementById('lPlay');
  if (!btn) return;
  btn.textContent = label;
  btn.setAttribute('aria-label', aria);
}

async function runListenStep() {
  if (!state.listen.playing) return;
  const cards = filteredCards();
  if (!cards.length) { stopListen(); return; }
  const card = cards[state.cardIndex];

  // Phase 1：老師語音
  const teacherMs = estimateTeacherMs(card);
  animateBar('barT', teacherMs);
  await speakWithPromise(card);
  if (!state.listen.playing) return;

  // Phase 2：跟讀空白
  const gap = state.settings.gap === 'auto'
    ? Math.max(1.5, teacherMs / 1000 * 1.3)
    : Number(state.settings.gap);
  const gapMs = gap * 1000;
  animateBar('barR', gapMs);
  await wait(gapMs);
  if (!state.listen.playing) return;

  state.listen.repeatCount++;
  resetBars();

  if (state.listen.repeatCount < state.settings.repeat) {
    onAdvance?.('rerender');
    runListenStep();
  } else {
    state.listen.repeatCount = 0;
    if (state.cardIndex + 1 < cards.length) state.cardIndex++;
    else state.cardIndex = 0;
    onAdvance?.('rerender');
    runListenStep();
  }
}

function animateBar(id, durationMs) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = '0';
  el.style.transition = 'none';
  void el.offsetWidth;
  el.style.transition = `width ${durationMs}ms linear`;
  el.style.width = '100%';
}

function resetBars() {
  const barT = document.getElementById('barT'); if (barT) barT.style.width = '0';
  const barR = document.getElementById('barR'); if (barR) barR.style.width = '0';
}

function wait(ms) {
  return new Promise(r => { state.listen.timeoutId = setTimeout(r, ms); });
}

function prevInList() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex - 1 + cards.length) % cards.length;
  state.listen.repeatCount = 0;
  onAdvance?.('rerender');
}

function nextInList() {
  const cards = filteredCards();
  if (!cards.length) return;
  state.cardIndex = (state.cardIndex + 1) % cards.length;
  state.listen.repeatCount = 0;
  onAdvance?.('rerender');
}

/* ===== Silent audio loop（維持鎖屏 session） ===== */

function startSilentLoop() {
  if (!silentAudio) return;
  silentAudio.volume = 0;
  silentAudio.muted = true;
  silentAudio.play().catch(e => console.warn('silent loop play blocked:', e));
}

function stopSilentLoop() {
  if (!silentAudio) return;
  try { silentAudio.pause(); } catch (e) {}
}

/* ===== Media Session（鎖屏顯示 + 控制鍵） ===== */

function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => { if (!state.listen.playing) startListen(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (state.listen.playing) stopListen(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { stopListen(); prevInList(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { stopListen(); nextInList(); });
}

function updateMediaSessionMetadata(card) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: card.thai || '泰文複習',
      artist: card.karaoke || '',
      album: card.zh || '',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (e) {}
}
