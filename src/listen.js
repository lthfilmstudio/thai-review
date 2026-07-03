/* 被動聽力模式：老師語音 → 跟讀空白 → 重複 N 次 → 下一張。
   手機背景 / 鎖屏播放：全程用 tts.js 的共用 <audio> 串聲音鏈，
   跟讀空白也是播真靜音音檔（不是 setTimeout），audio session 不會斷。 */

import { state, filteredCards, saveState } from './state.js';
import { prepareLockListenSession } from './listen-lock.js';
import {
  CHINESE_VOICE,
  buildListenCycle,
  cancelSpeech,
  downloadLessonAudio,
  estimateTeacherMs,
  getCachedCycle,
  getSilenceUrl,
  isPlaybackStalled,
  logListenEvent,
  playSilenceWithPromise,
  playUrlWithPromise,
  prefetchSpeech,
  speakTextWithPromise,
  speakWithPromise,
  supportsCycleAssembly,
  unlockAudioPlayback,
} from './tts.js';
import { escapeHtml } from './ui.js';

let onAdvance = null;   // 切卡後的 callback（由 app.js 注入，用來重繪 UI）
let runVersion = 0;
let fillerRuns = 0;     // 背景中連續播過場空白的次數（保命機制）
let warming = false;
let dlState = null;     // { key, done, total, failed, running } 這堂課音檔下載進度
let playbackMode = localStorage.getItem('thai-review-listen-playback-mode') || 'normal';
let lockSession = null;
let lockPreparing = false;
let lockStatus = '';
const WARM_AHEAD = 20;  // 播放中預先拼好後面幾張卡（約 5 分鐘鎖屏糧倉）
const LOCK_CARD_LIMIT = 40;
const PLAYBACK_RATES = [0.6, 0.8, 1, 1.2];
const GAP_OPTIONS = ['auto', 1, 2, 3, 4];

/* 按播放就把整堂課來源音檔抓下來，之後拼卡不碰網路。 */
function kickLessonDownload(cards) {
  const key = `${state.currentLessonId}|${state.settings.voiceProvider}|${state.settings.voice}`;
  if (dlState?.key === key && (dlState.running || dlState.done === dlState.total)) return;
  dlState = { key, done: 0, total: cards.length, failed: 0, running: true };
  renderDlStatus();
  void downloadLessonAudio(cards, (done, total, failed) => {
    if (dlState?.key !== key) return;
    Object.assign(dlState, { done, total, failed });
    renderDlStatus();
  }).then(r => {
    if (dlState?.key !== key) return;
    dlState.running = false;
    logListenEvent(`lesson-audio ${r.done - r.failed}/${r.total} ready${r.failed ? ` (${r.failed} failed)` : ''}`);
    renderDlStatus();
  });
}

function renderDlStatus() {
  const el = document.getElementById('listenDlStatus');
  if (!el || !dlState) return;
  const ok = dlState.done - dlState.failed;
  el.textContent = dlState.running
    ? `下載中 ${dlState.done}/${dlState.total}`
    : `${ok}/${dlState.total} 已備妥${dlState.failed ? `（${dlState.failed} 失敗）` : ''}`;
}

/* 播放中把後面幾張卡的循環先拼好（趁還有網路 / 還沒被凍結）。 */
async function warmUpcomingCycles(cards, version) {
  if (warming || !supportsCycleAssembly()) return;
  warming = true;
  try {
    for (let i = 1; i <= Math.min(WARM_AHEAD, cards.length - 1); i++) {
      if (!state.listen.playing || version !== runVersion) return;
      const card = cards[(state.cardIndex + i) % cards.length];
      if (!card || getCachedCycle(card)) continue;
      try {
        await buildListenCycle(card);
      } catch (e) {
        logListenEvent(`warm-fail +${i} ${e?.name || e?.message || e}`);
      }
    }
  } finally {
    warming = false;
  }
}

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
          <button class="l-main" id="lPlay" aria-label="${mainButtonAria()}">${mainButtonLabel()}</button>
          <button class="l-btn" id="lNext" aria-label="下一張">▶▶</button>
        </div>
      </div>
      <div class="listen-settings">
        <div class="setting-row">
          <div class="setting-label">播放模式</div>
          <div class="listen-rate-seg" id="listenPlaybackSeg">
            <button class="listen-rate-btn ${playbackMode === 'normal' ? 'active' : ''}" data-playback="normal">一般</button>
            <button class="listen-rate-btn ${playbackMode === 'lock' ? 'active' : ''}" data-playback="lock">鎖屏</button>
          </div>
        </div>
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
          <div class="setting-label">離線音檔</div>
          <div style="font-size:12px;font-weight:500" id="listenDlStatus">按播放自動下載</div>
        </div>
        <div class="setting-row" id="lockStatusRow" style="${playbackMode === 'lock' ? '' : 'display:none'}">
          <div class="setting-label">鎖屏音檔</div>
          <div style="font-size:12px;font-weight:500" id="lockListenStatus">${lockStatus || '先按準備'}</div>
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
  renderDlStatus();
  renderLockStatus();
  document.getElementById('lPrev').addEventListener('click', () => { stopListen(); clearLockSession(); prevInList(); });
  document.getElementById('lNext').addEventListener('click', () => { stopListen(); clearLockSession(); nextInList(); });
  document.getElementById('listenPlaybackSeg')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-playback]');
    if (!btn) return;
    stopListen();
    clearLockSession();
    playbackMode = btn.dataset.playback === 'lock' ? 'lock' : 'normal';
    localStorage.setItem('thai-review-listen-playback-mode', playbackMode);
    onAdvance?.('rerender');
  });
  document.getElementById('listenRateSeg')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-rate]');
    if (!btn) return;
    state.settings.rate = Number(btn.dataset.rate);
    clearLockSession();
    saveState();
    document.querySelectorAll('#listenRateSeg .listen-rate-btn').forEach(rateBtn => {
      rateBtn.classList.toggle('active', rateBtn === btn);
    });
  });
  document.getElementById('listenGapSeg')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-gap]');
    if (!btn) return;
    state.settings.gap = btn.dataset.gap === 'auto' ? 'auto' : Number(btn.dataset.gap);
    clearLockSession();
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
  if (playbackMode === 'lock') {
    if (lockSession) startLockListen();
    else void prepareLockSession();
    return;
  }

  const version = ++runVersion;
  state.listen.playing = true;
  state.listen.repeatCount = 0;
  state.listen.phase = 'meaning';
  fillerRuns = 0;
  unlockAudioPlayback();
  if (supportsCycleAssembly()) kickLessonDownload(filteredCards());
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
  clearUiTimers();
  const barT = document.getElementById('barT'); if (barT) barT.style.width = '0';
  const barR = document.getElementById('barR'); if (barR) barR.style.width = '0';
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused');
  updateMainButton();
}

function mainButtonLabel() {
  if (state.listen.playing) return '❚❚';
  if (playbackMode === 'lock') {
    if (lockPreparing) return '…';
    if (!lockSession) return '準備';
  }
  return '▶';
}

function mainButtonAria() {
  if (state.listen.playing) return '暫停';
  if (playbackMode === 'lock' && !lockSession) return '準備鎖屏長音檔';
  return '播放';
}

function updatePlayBtn(label, aria) {
  const btn = document.getElementById('lPlay');
  if (!btn) return;
  btn.textContent = label;
  btn.setAttribute('aria-label', aria);
}

function updateMainButton() {
  updatePlayBtn(mainButtonLabel(), mainButtonAria());
}

function setLockStatus(text) {
  lockStatus = text;
  renderLockStatus();
}

function renderLockStatus() {
  const el = document.getElementById('lockListenStatus');
  if (el) el.textContent = lockStatus || '先按準備';
}

function clearLockSession() {
  if (lockSession?.url) {
    try { URL.revokeObjectURL(lockSession.url); } catch {}
  }
  lockSession = null;
  lockPreparing = false;
  lockStatus = '';
  updateMainButton();
  renderLockStatus();
}

async function prepareLockSession() {
  if (lockPreparing) return;
  lockPreparing = true;
  setLockStatus('準備中…');
  updateMainButton();
  logListenEvent('lock-prepare');
  try {
    const cards = filteredCards();
    const session = await prepareLockListenSession(cards, {
      startIndex: state.cardIndex,
      limit: Math.min(LOCK_CARD_LIMIT, cards.length),
      repeat: state.settings.repeat,
      gap: state.settings.gap,
      rate: state.settings.rate,
    });
    lockSession = session;
    logListenEvent(`lock-ready ${session.count} cards ${(session.totalMs / 60000).toFixed(1)}m`);
    setLockStatus(`${session.count} 張 / ${(session.totalMs / 60000).toFixed(1)} 分鐘已備妥`);
  } catch (e) {
    logListenEvent(`lock-fail ${e?.message || e}`);
    setLockStatus(`失敗：${e?.message || e}`);
  } finally {
    lockPreparing = false;
    updateMainButton();
  }
}

async function startLockListen() {
  if (!lockSession) return;
  const version = ++runVersion;
  state.listen.playing = true;
  state.listen.repeatCount = 0;
  state.listen.phase = 'teacher';
  registerMediaSessionHandlers();
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing');
  logListenEvent('lock-play');
  updateMainButton();
  scheduleLockUi(lockSession);
  const playedMs = await playUrlWithPromise(lockSession.url);
  clearUiTimers();
  if (!state.listen.playing || version !== runVersion) return;
  state.listen.playing = false;
  navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused');
  if (playedMs > 0) {
    state.cardIndex = lockSession.nextIndex;
    logListenEvent('lock-done');
  }
  clearLockSession();
  onAdvance?.('rerender');
}

async function runListenStep(version) {
  if (!state.listen.playing || version !== runVersion) return;
  const cards = filteredCards();
  if (!cards.length) { stopListen(); return; }
  const card = cards[state.cardIndex];

  // 主路徑：整卡循環拼成一個 ≥5 秒的音檔一次播（Chrome 才給背景播放待遇）。
  // 只在卡片開頭走這條；拼不出來（離線、TTS 失敗）就掉回逐段模式。
  if (state.listen.repeatCount === 0 && supportsCycleAssembly()) {
    let cycle = getCachedCycle(card);
    if (!cycle) {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        // 前景：可以等網路現拼
        try {
          cycle = await buildListenCycle(card);
        } catch (e) {
          logListenEvent(`cycle-build-fail ${e?.name || e?.message || e}`);
        }
        if (!state.listen.playing || version !== runVersion) return;
      } else {
        // 背景 / 鎖屏：await 網路會被系統凍住 → 播 8 秒過場空白保住媒體工作階段，
        // 同時非同步拼這張，過場播完再回來查快取。連續 5 次拼不出來才放棄。
        void buildListenCycle(card).catch(e => logListenEvent(`cycle-build-fail ${e?.name || e?.message || e}`));
        fillerRuns++;
        if (fillerRuns > 5) { logListenEvent('filler-give-up'); stopListen(); return; }
        logListenEvent(`filler ${fillerRuns}`);
        const fillerMs = await playUrlWithPromise(getSilenceUrl(8000));
        if (!state.listen.playing || version !== runVersion) return;
        if (fillerMs <= 0) await wait(2000);
        if (!state.listen.playing || version !== runVersion) return;
        void runListenStep(version);
        return;
      }
    }
    if (cycle) {
      fillerRuns = 0;
      logListenEvent(`c${state.cardIndex} cycle ${(cycle.totalMs / 1000).toFixed(1)}s`);
      void warmUpcomingCycles(cards, version); // 持續補貨後面幾張
      scheduleCycleUi(cycle.timeline);
      const playedMs = await playUrlWithPromise(cycle.url);
      clearUiTimers();
      if (!state.listen.playing || version !== runVersion) return;
      if (playedMs > 0) {
        logListenEvent(`c${state.cardIndex} done`);
        state.listen.repeatCount = 0;
        state.cardIndex = (state.cardIndex + 1) % cards.length;
        onAdvance?.('rerender');
        void runListenStep(version);
        return;
      }
      // 整卡播放失敗 → 往下掉回逐段模式播這張
    }
  }

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

/* ===== 整卡循環的 UI 排程（純畫面用；背景中 timer 被凍結沒關係，聲音在同一個音檔裡） ===== */

let uiTimers = [];

function clearUiTimers() {
  uiTimers.forEach(clearTimeout);
  uiTimers = [];
}

function scheduleCycleUi(timeline) {
  clearUiTimers();
  timeline.forEach(seg => {
    uiTimers.push(setTimeout(() => {
      if (!state.listen.playing) return;
      state.listen.phase = seg.phase;
      if (typeof seg.rep === 'number') state.listen.repeatCount = seg.rep;
      if (seg.phase === 'meaning') {
        updateTeacherLabel('中文提示');
        animateBar('barT', seg.durMs);
      } else if (seg.phase === 'teacher') {
        updateTeacherLabel('老師泰文');
        animateBar('barT', seg.durMs);
        const barR = document.getElementById('barR'); if (barR) barR.style.width = '0';
        updateRepeatInfo();
      } else if (seg.phase === 'repeat') {
        animateBar('barR', seg.durMs);
      }
    }, seg.startMs));
  });
}

function scheduleLockUi(session) {
  clearUiTimers();
  session.entries.forEach(entry => {
    uiTimers.push(setTimeout(() => {
      if (!state.listen.playing) return;
      state.cardIndex = entry.cardIndex;
      state.listen.repeatCount = 0;
      onAdvance?.('rerender');
    }, entry.startMs));
    entry.timeline.forEach(seg => {
      uiTimers.push(setTimeout(() => {
        if (!state.listen.playing) return;
        if (state.cardIndex !== entry.cardIndex) {
          state.cardIndex = entry.cardIndex;
          onAdvance?.('rerender');
        }
        state.listen.phase = seg.phase;
        if (typeof seg.rep === 'number') state.listen.repeatCount = seg.rep;
        updateRepeatInfo();
      }, seg.startMs + 30));
    });
  });
}

function updateRepeatInfo() {
  const el = document.querySelector('.listen-info');
  if (!el) return;
  const cards = filteredCards();
  el.textContent = `第 ${state.cardIndex + 1} / ${cards.length} · 重複 ${Math.min(state.listen.repeatCount + 1, state.settings.repeat)}/${state.settings.repeat}`;
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

/* ===== 回前景自救：頁面被凍結時聲音鏈可能卡死，偵測到就從當下這張卡重新開始 ===== */

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.listen.playing) return;
    setTimeout(() => {
      if (!state.listen.playing) return;
      if (isPlaybackStalled()) {
        logListenEvent('resume-after-freeze');
        const version = ++runVersion;
        cancelSpeech();
        state.listen.repeatCount = 0;
        onAdvance?.('rerender');
        void runListenStep(version);
      }
    }, 600);
  });
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
