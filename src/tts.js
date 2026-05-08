/* 泰文 TTS。
   主路徑：thai-tts-proxy Worker → GCP Neural2 / Chirp3-HD → 高品質 MP3
   失敗 / 離線：fallback 回瀏覽器 speechSynthesis（音質普通但可離線）

   保留舊 API：speakCard / speakWithPromise / estimateTeacherMs / warmupVoices
   讓 app.js / listen.js / card.js 不用動。 */

import { state } from './state.js';

const WORKER_URL = 'https://thai-tts.lthfilmstudio.workers.dev/tts';

// 預設女聲 Neural2-C；UI 可改 voice 設定
const DEFAULT_VOICE = 'th-TH-Neural2-C';

// 同一段文字 + voice 已經抓過就 reuse blob URL，省 fetch
const audioCache = new Map();   // key = text|voice → blobUrl

// 目前播放中的 Audio element，切卡時要 cancel
let currentAudio = null;

function pickVoice() {
  return (state.settings && state.settings.voice) || DEFAULT_VOICE;
}

function pickRate() {
  return state.settings?.rate || 1;
}

/* 取得（或產生）泰文音檔的 blob URL；失敗時回傳 null。 */
async function fetchTtsBlob(text, voice) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const cacheKey = `${voice}|${trimmed}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, voice }),  // speed 走 client playbackRate
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.audio) return null;

    // base64 → Blob → object URL
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

function stopCurrentAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
  try { window.speechSynthesis?.cancel(); } catch {}
}

function pickThaiVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang && v.lang.toLowerCase().startsWith('th')) || null;
}

function speakViaWebSpeech(text) {
  if (!('speechSynthesis' in window)) return null;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'th-TH';
  u.rate = pickRate();
  const tv = pickThaiVoice();
  if (tv) u.voice = tv;
  window.speechSynthesis.speak(u);
  return u;
}

/* ===== Public API ===== */

/* 非阻塞播放（按鈕點擊用） */
export function speakCard(card) {
  stopCurrentAudio();
  const text = card?.thai;
  if (!text) return;
  const voice = pickVoice();

  fetchTtsBlob(text, voice).then(url => {
    if (!url) {
      // 拿不到雲端音檔（離線 / Worker 失敗）→ 退回 Web Speech
      speakViaWebSpeech(text);
      return;
    }
    const audio = new Audio(url);
    audio.playbackRate = pickRate();
    currentAudio = audio;
    audio.play().catch(() => {
      // 自動播放被擋（手機鎖屏邊界）→ 退回 Web Speech
      speakViaWebSpeech(text);
    });
  });
}

/* Promise 版本（被動聽力用，等唸完才往下走） */
export function speakWithPromise(card) {
  return new Promise(resolve => {
    stopCurrentAudio();
    const text = card?.thai;
    if (!text) { resolve(); return; }
    const voice = pickVoice();

    const fallback = () => {
      const u = speakViaWebSpeech(text);
      if (!u) { resolve(); return; }
      u.onend = () => resolve();
      u.onerror = () => resolve();
    };

    fetchTtsBlob(text, voice).then(url => {
      if (!url) { fallback(); return; }
      const audio = new Audio(url);
      audio.playbackRate = pickRate();
      currentAudio = audio;
      audio.onended = () => resolve();
      audio.onerror = () => fallback();
      audio.play().catch(() => fallback());
    });
  });
}

/* 估計播放長度（給跟讀間隔的 progress bar 動畫用） */
export function estimateTeacherMs(card) {
  const len = (card?.thai || '').length;
  return Math.min(Math.max(len * 120, 800), 5000);
}

/* 觸發 voices 載入（fallback 用，Safari 第一次 getVoices 可能是空的） */
export function warmupVoices() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}
