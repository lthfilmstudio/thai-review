/* 精簡評分歷史：每張卡最近 5 次評分，給 Phase 3「進步時刻」用。
   跟 progress 分開存，不動現有 SRS 結構；歷史沒辦法回溯生成，所以結構
   從 Phase 1 就開始默默累積；Phase 3 起也用它判斷「進步時刻」
   （見設計書 9.2）。 */

const KEY = 'thai-review-grade-history-v1';
const MAX_PER_CARD = 5;
const GRADE_CODE = { again: 0, hard: 1, good: 2, easy: 3 };
const GRADE_BY_CODE = Object.freeze(['again', 'hard', 'good', 'easy']);

/* ledger 的 history 投影存的是 code，鏡射回本機時要換回四檔名稱。 */
export function gradeFromCode(code) {
  return GRADE_BY_CODE[code] ?? null;
}
const IMPROVEMENT_AGE_SECONDS = 14 * 24 * 60 * 60;

function load(storage = localStorage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { v: 1, cards: {} };
    const h = JSON.parse(raw);
    if (!h || typeof h.cards !== 'object') return { v: 1, cards: {} };
    return h;
  } catch {
    return { v: 1, cards: {} };
  }
}

function save(h, storage = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(h));
  } catch (e) {
    console.warn('grade history save failed:', e.message);
  }
}

export function loadGradeHistory(storage = localStorage) {
  return load(storage);
}

/* 跨裝置同步用的批次寫入：把合併好的 { cardKey: [[code, ts], ...] } 覆蓋進去。
   合併語意歸 src/cloud-merge.js 的 mergeHistory，這裡只負責落地。 */
export function writeMergedHistory(merged, storage = localStorage) {
  const keys = Object.keys(merged || {});
  if (!keys.length) return false;
  const h = load(storage);
  for (const k of keys) h.cards[k] = merged[k];
  save(h, storage);
  return true;
}

/* 記一筆評分。gradeStr 不是四檔之一就略過（例如清掉評分時 setGrade 傳 undefined）。
   ledger 路徑會多帶一個 eventId：那條路可能在當掉重開後重播，靠 eventId 認出
   同一筆評分才不會愈記愈多（R8）。legacy 路徑不帶，行為完全不變。 */
export function recordGrade(
  cardKey, gradeStr, ts = Date.now(), storage = localStorage, eventId = null,
) {
  const code = GRADE_CODE[gradeStr];
  if (code === undefined || !cardKey) return false;
  const h = load(storage);
  const list = h.cards[cardKey] || [];
  if (eventId && list.some(entry => Array.isArray(entry) && entry[2] === eventId)) return false;
  const [previousGrade, previousTs] = list[list.length - 1] || [];
  const nowSeconds = Math.round(ts / 1000);
  const improvementMoment = (gradeStr === 'good' || gradeStr === 'easy')
    && previousGrade === GRADE_CODE.again
    && Number.isFinite(previousTs)
    && nowSeconds - previousTs >= IMPROVEMENT_AGE_SECONDS;
  list.push(eventId
    ? [code, Math.round(ts / 1000), eventId]
    : [code, Math.round(ts / 1000)]);
  while (list.length > MAX_PER_CARD) list.shift();
  h.cards[cardKey] = list;
  save(h, storage);
  return improvementMoment;
}
