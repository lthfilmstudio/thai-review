/* 被動聽力模式：老師語音 → 跟讀空白 → 重複 N 次 → 下一張。
   手機背景 / 鎖屏播放：全程用 tts.js 的共用 <audio> 串聲音鏈，
   跟讀空白也是播真靜音音檔（不是 setTimeout），audio session 不會斷。 */

import { state, filteredCards, saveState } from './state.js';
import {
  CHINESE_VOICE,
  cancelSpeech,
  estimateTeacherMs,
  logListenEvent,
  playSilenceWithPromise,
  prefetchSpeech,
  speakTextWithPromise,
  speakWithPromise,
  unlockAudioPlayback,
} from './tts.js';
import { escapeHtml } from './ui.js';

let onAdvance = null;   // 切卡後的 callback（由 app.js 注入，用來重繪 UI）
let runVersion = 0;
const PLAYBACK_RATES = [0.6, 0.8, 1, 1.2];
const GAP_OPTIONS = ['auto', 1, 2, 3, 4];

export function renderListenMode(el, cards, advanceCb) {
  onAdvance = advanceCb;

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
        <div class="phase-row"><div class="phase-dot teacher"></div><div class="phase-label" id="phaseTeacherLabel">${state.listen.phase === 'meaning' ? '中文提示' : '老師泰文'}</div></div>
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
          <div class="setting-label">泰文語速</div>
          <div class="listen-rate-seg" id="listenRateSeg">
            ${PLAYBACK_RATES.map(rate => `
              <button class="listen-rate-btn ${state.settings.rate === rate ? 'active' : ''}" data-rate="${rate}">${rate}×</button>
            `).join('')}
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">重複次數</div>
          <div style="font-size:12px;font-weight:500">${rep}×</div>
        </div>
        <div class="setting-row">
          <div class="setting-label">跟讀間隔</div>
          <div class="listen-rate-seg" id="listenGapSeg">
            ${GAP_OPTIONS.map(gap => `
              <button class="listen-rate-btn ${String(state.settings.gap) === String(gap) ? 'active' : ''}" data-gap="${gap}">${gap === 'auto' ? '自動' : gap + 's'}</button>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('lPlay').addEventListener('click', toggleListen);
  document.getElementById('lPrev').addEventListener('click', () => { stopListen(); prevInList(); });
  document.getElementById('lNext').addEventListener('click', () => { stopListen(); nextInList(); });
  document.getElementById('listenRateSeg')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-rate]');
    if (!btn) return;
    state.settings.rate = Number(btn.dataset.rate);
    saveState();
    document.querySelectorAll('#listenRateSeg .listen-rate-btn').forEach(rateBtn => {
      rateBtn.classList.toggle('active', rateBtn === btn);
    });
  });
  document.getElementById('listenGapSeg')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-gap]');
    if (!btn) return;
    state.settings.gap = btn.dataset.gap === 'auto' ? 'auto' : Number(btn.dataset.gap);
    saveState();
    document.querySelectorAll('#listenGapSeg .listen-rate-btn').forEach(gapBtn => {
      gapBtn.classList.toggle('active', gapBtn === btn);
    });
  });

  updateMediaSessionMetadata(card);
}

export function toggleListen() {
  if (state.listen.playing) stopListen();
  else startListen();
}

export function startListen() {
  const version = ++runVersion;
  state.listen.playing = true;
  state.listen.repeatCount = 0;
  state.listen.phase = 'meaning';
  unlockAudioPlayback();
  registerMediaSessionHandlers();
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing');
  logListenEvent('start');
  void runListenStep(version);
  updatePlayBtn('❚❚', '暫停');
}

export function stopListen() {
  runVersion++;
  if (state.listen.playing) logListenEvent('stop');
  state.listen.playing = false;
  state.listen.phase = 'idle';
  cancelSpeech();
  cancelAnimationFrame(state.listen.rafId);
  clearTimeout(state.listen.timeoutId);
  const barT = document.getElementById('barT'); if (barT) barT.style.width = '0';
  const barR = document.getElementById('barR'); if (barR) barR.style.width = '0';
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused');
  updatePlayBtn('▶', '播放');
}

function updatePlayBtn(label, aria) {
  const btn = document.getElementById('lPlay');
  if (!btn) return;
  btn.textContent = label;
  btn.setAttribute('aria-label', aria);
}

async function runListenStep(version) {
  if (!state.listen.playing || version !== runVersion) return;
  const cards = filteredCards();
  if (!cards.length) { stopListen(); return; }
  const card = cards[state.cardIndex];

  // Phase 1：每張卡只唸一次中文提示。
  if (state.listen.repeatCount === 0) {
    state.listen.phase = 'meaning';
    updateTeacherLabel('中文提示');
    logListenEvent(`c${state.cardIndex} meaning`);
    await speakTextWithPromise({
      text: card.zh,
      voice: CHINESE_VOICE,
      lang: 'zh-TW',
      rate: 1,
    });
    if (!state.listen.playing || version !== runVersion) return;
  }

  // Phase 2：老師泰文。真實播放時間會拿來算跟讀長度。
  state.listen.phase = 'teacher';
  updateTeacherLabel('老師泰文');
  logListenEvent(`c${state.cardIndex} r${state.listen.repeatCount} teacher`);
  const nextCard = cards[(state.cardIndex + 1) % cards.length];
  if (nextCard?.zh) prefetchSpeech(nextCard.zh, CHINESE_VOICE); // 先抓下一張的中文
  const estimatedTeacherMs = estimateTeacherMs(card);
  animateBar('barT', estimatedTeacherMs);
  const playedTeacherMs = await speakWithPromise(card);
  if (!state.listen.playing || version !== runVersion) return;

  // Phase 3：跟讀空白。短字至少留 1.5 秒，長句用老師時間的 1.8 倍。
  // 播等長靜音而不是 setTimeout，背景 / 鎖屏中流程才不會被凍結。
  state.listen.phase = 'repeat';
  const teacherMs = playedTeacherMs > 0 ? playedTeacherMs : estimatedTeacherMs;
  const gapMs = state.settings.gap === 'auto'
    ? Math.max(1500, teacherMs * 1.8)
    : Number(state.settings.gap) * 1000;
  if (gapMs > 0) {
    logListenEvent(`c${state.cardIndex} r${state.listen.repeatCount} gap ${Math.round(gapMs)}`);
    animateBar('barR', gapMs);
    const silentMs = await playSilenceWithPromise(gapMs);
    if (!state.listen.playing || version !== runVersion) return;
    if (silentMs <= 0) await wait(gapMs); // 靜音播放失敗才退回計時器
    if (!state.listen.playing || version !== runVersion) return;
  }

  state.listen.repeatCount++;
  resetBars();

  if (state.listen.repeatCount < state.settings.repeat) {
    onAdvance?.('rerender');
    void runListenStep(version);
  } else {
    state.listen.repeatCount = 0;
    if (state.cardIndex + 1 < cards.length) state.cardIndex++;
    else state.cardIndex = 0;
    onAdvance?.('rerender');
    void runListenStep(version);
  }
}

function updateTeacherLabel(label) {
  const el = document.getElementById('phaseTeacherLabel');
  if (el) el.textContent = label;
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

/* ===== Media Session（鎖屏顯示 + 控制鍵） ===== */

function registerMediaSessionHandlers() {
  if (!navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler('play', () => { if (!state.listen.playing) startListen(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (state.listen.playing) stopListen(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { stopListen(); prevInList(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { stopListen(); nextInList(); });
}

function updateMediaSessionMetadata(card) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: card.thai || '清心安神',
      artist: card.karaoke || '',
      album: card.zh || '',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (e) {}
}
