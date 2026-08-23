/* 重新複習掃描：照課程順序（初 1 → … → 最新一堂）從頭走一輪，新舊卡都重新
   評分，不看到期狀態。純函式 + 一個 localStorage 游標，跟主 STORAGE_KEY
   分開存（設計書 docs/mastery-sprint-plan-2026-08.md 第 2 段）。 */

const RESWEEP_KEY = 'thai-review-resweep-v1';

export function loadResweepState() {
  try {
    const raw = localStorage.getItem(RESWEEP_KEY);
    if (!raw) return { startedAt: null, position: 0 };
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return { startedAt: null, position: 0 };
    return {
      startedAt: s.startedAt || null,
      position: typeof s.position === 'number' && s.position >= 0 ? s.position : 0,
    };
  } catch {
    return { startedAt: null, position: 0 };
  }
}

function saveResweepState(s) {
  try {
    localStorage.setItem(RESWEEP_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('resweep state save failed:', e.message);
  }
}

/* 從游標位置往後切 n 張，orderedCards 是 state.lessons 攤平後、課程原始順序的
   卡片陣列（跟 allCardsWithLessonId() 一致）。游標超過總數時回傳空陣列
   （代表這一輪已經掃完，見設計書「要不要自動重掃第二輪」待定項）。 */
export function pickResweepBatch(orderedCards, n, canAdvance = null) {
  if (n <= 0) return [];
  const { position } = loadResweepState();
  if (position >= orderedCards.length) return [];
  const batch = orderedCards.slice(position, position + n);
  if (typeof canAdvance !== 'function') return batch;

  // A flat cursor can only move past a contiguous prefix that this caller can
  // prove was eligible for this resweep.  In particular, do not filter a
  // blocked card out and then return later cards: grading one of those later
  // cards would make the position pretend that the blocked card was answered.
  const prefix = [];
  for (const card of batch) {
    if (!canAdvance(card)) break;
    prefix.push(card);
  }
  return prefix;
}

/* 評完一張才呼叫，往前推進游標；clamp 到 total 避免超出範圍。
   第一次呼叫順便記下 startedAt。 */
export function advanceResweepCursor(delta, total) {
  const s = loadResweepState();
  if (!s.startedAt) s.startedAt = Date.now();
  s.position = Math.min(total, Math.max(0, s.position + delta));
  saveResweepState(s);
  return s;
}

/* 今日頁進度列用：{ position, total, done }。 */
/* 跨裝置同步用：把合併好的游標寫回（別台掃得比較前面時往前跳）。
   刻意不做 clamp／不動 startedAt——合併規則歸呼叫端，這裡只落地。 */
export function setResweepPosition(position) {
  const s = loadResweepState();
  saveResweepState({ ...s, position });
}

export function resweepProgress(total) {
  const { position } = loadResweepState();
  const clamped = Math.min(position, total);
  return { position: clamped, total, done: total > 0 && clamped >= total };
}
