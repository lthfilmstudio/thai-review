/* 泰文／中文 TTS。
   泰文主路徑：靜態 MP3 manifest → thai-tts-proxy Worker → 瀏覽器 speechSynthesis。
   中文提示繼續走 Worker → 瀏覽器 speechSynthesis。 */

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
    const thai = String(entry.thai || '').trim();
    const path = String(entry.path || entry.url || '').trim();
    if (thai && path) map.set(thai, absoluteAudioUrl(path));
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
  const url = manifest.get(trimmed) || null;
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
      if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
        finish(0);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.lang = lang;
      utterance.rate = rate;
      const browserVoice = pickBrowserVoice(lang);
      if (browserVoice) utterance.voice = browserVoice;

      let startedAt = Date.now();
      utterance.onstart = () => { startedAt = Date.now(); };
      utterance.onend = () => finish(Date.now() - startedAt);
      utterance.onerror = () => finish(0);
      currentPlayback = { generation, utterance, resolve: finish };
      window.speechSynthesis.speak(utterance);
    };

    const playAudio = (url, onError) => {
      if (generation !== playbackGeneration) { finish(0); return; }
      if (!url) { onError(); return; }

      const audio = new Audio(url);
      audio.playbackRate = rate;
      let startedAt = Date.now();
      currentPlayback = { generation, audio, resolve: finish };
      audio.onended = () => {
        const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000 / rate
          : Date.now() - startedAt;
        finish(durationMs);
      };
      audio.onerror = onError;
      startedAt = Date.now();
      audio.play().catch(onError);
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

/* 非阻塞播放（按鈕點擊用）。 */
export function speakCard(card) {
  void speakWithPromise(card);
}

/* Promise 版本（被動聽力用），回傳實際播放毫秒數。 */
export function speakWithPromise(card) {
  return speakTextWithPromise({
    text: card?.thai,
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
