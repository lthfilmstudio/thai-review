/* 泰文／中文 TTS。
   泰文主路徑：靜態 MP3 manifest → thai-tts-proxy Worker → 瀏覽器 speechSynthesis。
   中文提示繼續走 Worker → 瀏覽器 speechSynthesis。
   所有雲端音檔共用一個常駐 <audio>（gesture 解鎖一次），
   跟讀空白播真靜音 WAV 而不是 setTimeout —— 背景 / 鎖屏才不會被凍結。 */

import { state } from './state.js';

const WORKER_URL = 'https://thai-tts.lthfilmstudio.workers.dev/tts';
const AUDIO_MANIFEST_URL = 'audio-manifest.json';
const DEFAULT_VOICE = 'th-TH-Neural2-C';
export const CHINESE_VOICE = 'cmn-TW-Wavenet-A';

// 同一段文字 + voice 已經抓過就 reuse blob URL，省 fetch。
const audioCache = new Map();
const bakedAudioCache = new Map();

let currentPlayback = null;
let playbackGeneration = 0;
let audioManifestPromise = null;
let sharedAudio = null;
let audioUnlocked = false;
const silenceUrlCache = new Map();

function getSharedAudio() {
  if (!sharedAudio) sharedAudio = new Audio();
  return sharedAudio;
}

/* ===== 聽力鏈除錯紀錄（設定裡點 App 版本可展開） ===== */

const LISTEN_LOG_KEY = 'thai-review-listen-log';

export function logListenEvent(tag) {
  try {
    const log = JSON.parse(localStorage.getItem(LISTEN_LOG_KEY) || '[]');
    log.push(`${new Date().toTimeString().slice(0, 8)} ${tag}`);
    while (log.length > 40) log.shift();
    localStorage.setItem(LISTEN_LOG_KEY, JSON.stringify(log));
  } catch {}
}

export function getListenLog() {
  try { return JSON.parse(localStorage.getItem(LISTEN_LOG_KEY) || '[]'); } catch { return []; }
}

/* 現場合成指定長度的「跟讀空白」WAV（16-bit mono 8kHz），依 100ms 取整做 cache。
   不能是純數位靜音：Chrome 只在「有能量的聲音」播放時保持背景喚醒（audio wakelock），
   純 0 訊號會被判定沒在出聲 → 鎖屏後整頁被凍結、聲音鏈卡死。
   改埋一個 35Hz、約 -30dBFS 的極低頻訊號：能量偵測看得到、人耳與手機喇叭聽不到。 */
function silenceWavBuffer(ms) {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(sampleRate * ms / 1000));
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  const amp = 1000; // ≈ -30dBFS
  const step = 2 * Math.PI * 35 / sampleRate;
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin(i * step) * amp), true);
  }
  return buf;
}

export function getSilenceUrl(ms) {
  const key = Math.max(100, Math.round(ms / 100) * 100);
  if (!silenceUrlCache.has(key)) {
    const blob = new Blob([silenceWavBuffer(key)], { type: 'audio/wav' });
    silenceUrlCache.set(key, URL.createObjectURL(blob));
  }
  return silenceUrlCache.get(key);
}

/* 在使用者手勢裡先播一小段靜音，之後背景中換音源續播才不會被擋。 */
export function unlockAudioPlayback() {
  if (audioUnlocked) return;
  const audio = getSharedAudio();
  try {
    audio.src = getSilenceUrl(100);
    audio.play().then(() => { audioUnlocked = true; }).catch(() => {});
  } catch {}
}

function normalizeThaiAudioText(text) {
  return String(text || '').trim().replace(/\s+/g, '');
}

function pickVoice() {
  return state.settings?.voice || DEFAULT_VOICE;
}

function pickVoiceProvider() {
  return state.settings?.voiceProvider === 'gcp' ? 'gcp' : 'elevenlabs';
}

function pickRate() {
  return state.settings?.rate || 1;
}

function isThaiLang(lang) {
  return String(lang || '').toLowerCase().startsWith('th');
}

function absoluteAudioUrl(path) {
  try {
    return new URL(path, globalThis.location?.href || document.baseURI).href;
  } catch {
    return path;
  }
}

function buildAudioMap(manifest) {
  const map = new Map();
  const items = manifest?.items || manifest?.entries || manifest?.audio;
  const entries = Array.isArray(items) ? items : Object.values(items || {});
  entries.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const path = String(entry.path || entry.url || '').trim();
    if (!path) return;
    const url = absoluteAudioUrl(path);
    const promptText = String(entry.tts_prompt || entry.ttsPrompt || '').trim();
    const texts = (
      promptText
        ? [promptText]
        : [entry.text, entry.thai]
    ).map(value => String(value || '').trim()).filter(Boolean);
    texts.forEach(text => {
      map.set(text, url);
      const normalized = normalizeThaiAudioText(text);
      if (normalized && !map.has(normalized)) map.set(normalized, url);
    });
  });
  return map;
}

async function loadAudioManifest() {
  if (!audioManifestPromise) {
    audioManifestPromise = fetch(AUDIO_MANIFEST_URL)
      .then(res => (res.ok ? res.json() : null))
      .then(buildAudioMap)
      .catch(() => new Map());
  }
  return audioManifestPromise;
}

async function findBakedAudioUrl(text, lang) {
  const trimmed = (text || '').trim();
  if (!trimmed || !isThaiLang(lang)) return null;
  if (bakedAudioCache.has(trimmed)) return bakedAudioCache.get(trimmed);

  const manifest = await loadAudioManifest();
  const url = manifest.get(trimmed) || manifest.get(normalizeThaiAudioText(trimmed)) || null;
  bakedAudioCache.set(trimmed, url);
  return url;
}

async function fetchWorkerTtsBlob(text, voice) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const cacheKey = `${voice}|${trimmed}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, voice }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.audio) return null;

    const bin = atob(data.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);
    audioCache.set(cacheKey, url);
    return url;
  } catch {
    return null;
  }
}

function pickBrowserVoice(lang) {
  if (!('speechSynthesis' in window)) return null;
  const wanted = lang.toLowerCase();
  const base = wanted.split('-')[0];
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang?.toLowerCase() === wanted)
    || voices.find(v => v.lang?.toLowerCase().startsWith(base))
    || null;
}

export function cancelSpeech() {
  playbackGeneration++;
  const playback = currentPlayback;
  currentPlayback = null;
  if (playback?.audio) {
    try { playback.audio.pause(); } catch {}
  }
  try { window.speechSynthesis?.cancel(); } catch {}
  playback?.resolve?.(0);
}

export function speakTextWithPromise({ text, voice, lang, rate = 1, preferBaked = true }) {
  cancelSpeech();
  const generation = playbackGeneration;

  return new Promise(resolve => {
    let settled = false;
    const finish = durationMs => {
      if (settled) return;
      settled = true;
      if (currentPlayback?.generation === generation) currentPlayback = null;
      resolve(durationMs);
    };

    const trimmed = (text || '').trim();
    if (!trimmed) { finish(0); return; }

    const fallback = () => {
      if (generation !== playbackGeneration) { finish(0); return; }
      // 背景中 speechSynthesis 不會出聲、也常不回 onend，直接跳過避免聲音鏈卡死。
      if (typeof document !== 'undefined' && document.hidden) { finish(0); return; }
      if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
        finish(0);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.lang = lang;
      utterance.rate = rate;
      const browserVoice = pickBrowserVoice(lang);
      if (browserVoice) utterance.voice = browserVoice;

      // speechSynthesis 偶爾一個事件都不回，保險絲逾時直接放行。
      const watchdog = setTimeout(() => finish(0), Math.max(4000, trimmed.length * 300));
      let startedAt = Date.now();
      utterance.onstart = () => { startedAt = Date.now(); };
      utterance.onend = () => { clearTimeout(watchdog); finish(Date.now() - startedAt); };
      utterance.onerror = () => { clearTimeout(watchdog); finish(0); };
      currentPlayback = { generation, utterance, resolve: finish };
      window.speechSynthesis.speak(utterance);
    };

    const playAudio = (url, onError) => {
      if (generation !== playbackGeneration) { finish(0); return; }
      if (!url) { onError(); return; }

      const audio = getSharedAudio();
      audio.src = url;
      // 換 src 會把 playbackRate 重設成 defaultPlaybackRate，兩個都要設。
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      let startedAt = Date.now();
      currentPlayback = { generation, audio, resolve: finish };
      audio.onended = () => {
        const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000 / rate
          : Date.now() - startedAt;
        finish(durationMs);
      };
      audio.onerror = () => { logListenEvent('media-error'); onError(); };
      startedAt = Date.now();
      audio.play().catch(err => { logListenEvent(`play-fail ${err?.name || err}`); onError(); });
    };

    const playWorkerAudio = () => {
      fetchWorkerTtsBlob(trimmed, voice).then(url => {
        playAudio(url, fallback);
      });
    };

    const baked = preferBaked ? findBakedAudioUrl(trimmed, lang) : Promise.resolve(null);
    baked.then(url => {
      playAudio(url, playWorkerAudio);
    });
  });
}

/* 跟讀空白：播一段等長靜音，讓 audio session 一直活著。回傳實際靜音毫秒數，失敗回 0。 */
export function playSilenceWithPromise(ms) {
  cancelSpeech();
  const generation = playbackGeneration;

  return new Promise(resolve => {
    let settled = false;
    const finish = playedMs => {
      if (settled) return;
      settled = true;
      if (currentPlayback?.generation === generation) currentPlayback = null;
      resolve(playedMs);
    };

    if (!(ms > 0)) { finish(0); return; }

    const audio = getSharedAudio();
    try {
      audio.src = getSilenceUrl(ms);
    } catch {
      finish(0);
      return;
    }
    audio.defaultPlaybackRate = 1;
    audio.playbackRate = 1;
    currentPlayback = { generation, audio, resolve: finish };
    audio.onended = () => finish(ms);
    audio.onerror = () => { logListenEvent('gap-media-error'); finish(0); };
    audio.play().catch(err => { logListenEvent(`gap-play-fail ${err?.name || err}`); finish(0); });
  });
}

/* 提前抓語音進 cache（換卡瞬間不用等網路，背景中更穩）。 */
export function prefetchSpeech(text, voice) {
  const trimmed = (text || '').trim();
  if (trimmed) void fetchWorkerTtsBlob(trimmed, voice);
}

/* ===== 整卡循環組裝（背景播放的關鍵） =====
   Chrome Android 只對「長度 ≥ 5 秒」的媒體請求完整 audio focus 與媒體通知
   （web.dev/articles/media-session）；逐段播 2-3 秒短音會被當音效，
   鎖屏後整頁被凍結。所以把「中文 + (泰文 + 跟讀空白) × N」離線拼成
   一個十幾秒的 WAV 一次播，Chrome 才會給 podcast 等級的背景播放待遇。 */

const cycleCache = new Map(); // key → { url, totalMs, timeline }
let decodeCtx = null;

export function supportsCycleAssembly() {
  return typeof OfflineAudioContext !== 'undefined';
}

function getDecodeCtx() {
  if (!decodeCtx) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    decodeCtx = new Ctx();
  }
  return decodeCtx;
}

async function fetchAudioBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio fetch ${res.status}`);
  const bytes = await res.arrayBuffer();
  return await getDecodeCtx().decodeAudioData(bytes);
}

async function resolveThaiAudioUrl(card) {
  const usePrompt = pickVoiceProvider() === 'elevenlabs' && !card?._edited && card?.tts_prompt;
  const text = ((usePrompt ? card.tts_prompt : card?.thai) || '').trim();
  if (!text) throw new Error('no-thai-text');
  if (pickVoiceProvider() === 'elevenlabs') {
    const baked = await findBakedAudioUrl(text, 'th-TH');
    if (baked) return baked;
  }
  const url = await fetchWorkerTtsBlob(text, pickVoice());
  if (!url) throw new Error('no-thai-tts');
  return url;
}

/* 純函式：算整卡時間軸。teacherMs 是原速長度，rate 只套在老師泰文上。 */
export function computeCycleTimeline(zhMs, teacherMs, { rate = 1, gap = 'auto', repeat = 1 }) {
  const teacherEffMs = teacherMs / rate;
  const gapMs = gap === 'auto' ? Math.max(1500, teacherEffMs * 1.8) : Number(gap) * 1000;
  const timeline = [];
  let t = 0;
  if (zhMs > 0) { timeline.push({ phase: 'meaning', startMs: 0, durMs: zhMs }); t = zhMs; }
  for (let r = 0; r < repeat; r++) {
    timeline.push({ phase: 'teacher', startMs: t, durMs: teacherEffMs, rep: r });
    t += teacherEffMs;
    timeline.push({ phase: 'repeat', startMs: t, durMs: gapMs, rep: r });
    t += gapMs;
  }
  return { timeline, totalMs: t, gapMs, teacherEffMs };
}

function encodeWav(buffer) {
  const data = buffer.getChannelData(0);
  const dataSize = data.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

export async function buildListenCycle(card) {
  const rate = pickRate();
  const repeat = state.settings?.repeat || 1;
  const gap = state.settings?.gap ?? 'auto';
  const key = [
    card?.thai, card?.tts_prompt || '', card?.zh || '',
    pickVoiceProvider(), pickVoice(), rate, gap, repeat,
  ].join('|');
  if (cycleCache.has(key)) return cycleCache.get(key);

  const thaiUrl = await resolveThaiAudioUrl(card);
  const zhText = (card?.zh || '').trim();
  const zhUrl = zhText ? await fetchWorkerTtsBlob(zhText, CHINESE_VOICE) : null;
  const [thaiBuf, zhBuf] = await Promise.all([
    fetchAudioBuffer(thaiUrl),
    zhUrl ? fetchAudioBuffer(zhUrl) : Promise.resolve(null), // 中文抓不到就略過，不擋整卡
  ]);

  const { timeline, totalMs } = computeCycleTimeline(
    (zhBuf?.duration || 0) * 1000,
    thaiBuf.duration * 1000,
    { rate, gap, repeat },
  );
  const sampleRate = 32000;
  const ctx = new OfflineAudioContext(1, Math.ceil(totalMs / 1000 * sampleRate), sampleRate);
  timeline.forEach(seg => {
    if (seg.phase === 'repeat') return; // 空白＝什麼都不排
    const src = ctx.createBufferSource();
    src.buffer = seg.phase === 'meaning' ? zhBuf : thaiBuf;
    if (seg.phase === 'teacher') src.playbackRate.value = rate;
    src.connect(ctx.destination);
    src.start(seg.startMs / 1000);
  });
  const rendered = await ctx.startRendering();
  const cycle = { url: URL.createObjectURL(encodeWav(rendered)), totalMs, timeline };
  cycleCache.set(key, cycle);
  while (cycleCache.size > 8) {
    const oldest = cycleCache.keys().next().value;
    try { URL.revokeObjectURL(cycleCache.get(oldest).url); } catch {}
    cycleCache.delete(oldest);
  }
  return cycle;
}

/* 播一整個組裝好的循環（rate 已內嵌，播放器固定 1×）。回傳實際播放毫秒數。 */
export function playUrlWithPromise(url) {
  cancelSpeech();
  const generation = playbackGeneration;

  return new Promise(resolve => {
    let settled = false;
    const finish = ms => {
      if (settled) return;
      settled = true;
      if (currentPlayback?.generation === generation) currentPlayback = null;
      resolve(ms);
    };

    const audio = getSharedAudio();
    audio.src = url;
    audio.defaultPlaybackRate = 1;
    audio.playbackRate = 1;
    let startedAt = Date.now();
    currentPlayback = { generation, audio, resolve: finish };
    audio.onended = () => finish(Date.now() - startedAt);
    audio.onerror = () => { logListenEvent('cycle-media-error'); finish(0); };
    startedAt = Date.now();
    audio.play().catch(err => { logListenEvent(`cycle-play-fail ${err?.name || err}`); finish(0); });
  });
}

/* 頁面被凍結後回前景時，用這個判斷聲音鏈是不是卡死了。 */
export function isPlaybackStalled() {
  return !!(currentPlayback?.audio && currentPlayback.audio.paused);
}

/* 非阻塞播放（按鈕點擊用）。 */
export function speakCard(card) {
  void speakWithPromise(card);
}

/* Promise 版本（被動聽力用），回傳實際播放毫秒數。 */
export function speakWithPromise(card) {
  const usePrompt = pickVoiceProvider() === 'elevenlabs' && !card?._edited && card?.tts_prompt;
  return speakTextWithPromise({
    text: usePrompt ? card.tts_prompt : card?.thai,
    voice: pickVoice(),
    lang: 'th-TH',
    rate: pickRate(),
    preferBaked: pickVoiceProvider() === 'elevenlabs',
  });
}

/* 估計播放長度只供進度條與無法取得 duration 時 fallback。 */
export function estimateTeacherMs(card) {
  const len = (card?.thai || '').length;
  const baseMs = Math.min(Math.max(len * 120, 800), 5000);
  return baseMs / pickRate();
}

export function warmupVoices() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}
