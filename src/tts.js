/* 泰文 TTS。Stage 1 用瀏覽器內建 speechSynthesis；
   Stage 3 會改成依 start_ms/end_ms 跳播老師原音。 */

import { state } from './state.js';

function pickThaiVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang && v.lang.toLowerCase().startsWith('th')) || null;
}

/* 非阻塞播放（按鈕點擊用） */
export function speakCard(card) {
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(card.thai);
  u.lang = 'th-TH';
  u.rate = state.settings.rate || 1;
  const thai = pickThaiVoice();
  if (thai) u.voice = thai;
  window.speechSynthesis.speak(u);
}

/* Promise 版本（被動聽力用，等唸完才往下走） */
export function speakWithPromise(card) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(card.thai);
    u.lang = 'th-TH';
    u.rate = state.settings.rate || 1;
    const thai = pickThaiVoice();
    if (thai) u.voice = thai;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export function estimateTeacherMs(card) {
  const len = (card.thai || '').length;
  return Math.min(Math.max(len * 120, 800), 5000);
}

/* 觸發 voices 載入（Safari 第一次 getVoices 可能是空的） */
export function warmupVoices() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}
