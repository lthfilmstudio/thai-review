/* 熟練衝刺期 Phase 2：把今天累積複習秒數同步到 lth-tts-proxy 的 /progress
   端點，讓 22:00 Telegram 推播（daily-reminder.py）能顯示即時進度（設計書
   docs/mastery-sprint-plan-2026-08.md「即時進度推播」一節）。

   只送這一個數字，不是完整雲端同步；同步失敗靜默吞掉，不影響複習體驗——
   這條路徑純粹是錦上添花，不是複習隊列運作所需要的東西。 */

import { localDateKey } from './state.js';
import { getDeviceId } from './srs.js';

const ENDPOINT = 'https://thai-tts.lthfilmstudio.workers.dev/progress';
const THROTTLE_MS = 90000; // 90 秒節流一次，不用每個 15 秒 ticker tick 都打

let lastSentAt = 0;
let lastSentSeconds = -1;

function payload(seconds) {
  return JSON.stringify({ date: localDateKey(), deviceId: getDeviceId(), seconds });
}

/* 給既有 15 秒 ticker 每次 tick 呼叫，內部自己決定要不要真的送出。 */
export function syncProgressThrottled(seconds) {
  if (seconds === lastSentSeconds) return;
  const now = Date.now();
  if (now - lastSentAt < THROTTLE_MS) return;
  lastSentAt = now;
  lastSentSeconds = seconds;
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload(seconds),
    keepalive: true,
  }).catch(() => {});
}

/* App 背景化/關閉時補送最後一筆——背景時一般 fetch 容易被系統中斷，
   sendBeacon 是瀏覽器保證會送出的機制。 */
export function syncProgressOnHide(seconds) {
  if (seconds === lastSentSeconds) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  const blob = new Blob([payload(seconds)], { type: 'application/json' });
  navigator.sendBeacon(ENDPOINT, blob);
  lastSentSeconds = seconds;
  lastSentAt = Date.now();
}
