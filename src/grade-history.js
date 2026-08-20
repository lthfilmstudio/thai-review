/* 精簡評分歷史：每張卡最近 5 次評分，給 Phase 3「進步時刻」用。
   跟 progress 分開存，不動現有 SRS 結構；歷史沒辦法回溯生成，所以結構
   從 Phase 1 就開始默默累積，功能本身留到 Phase 3 才做（見設計書 9.2）。
   這個模組目前只寫不讀。 */

const KEY = 'thai-review-grade-history-v1';
const MAX_PER_CARD = 5;
const GRADE_CODE = { again: 0, hard: 1, good: 2, easy: 3 };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { v: 1, cards: {} };
    const h = JSON.parse(raw);
    if (!h || typeof h.cards !== 'object') return { v: 1, cards: {} };
    return h;
  } catch {
    return { v: 1, cards: {} };
  }
}

function save(h) {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch (e) {
    console.warn('grade history save failed:', e.message);
  }
}

export function loadGradeHistory() {
  return load();
}

/* 記一筆評分。gradeStr 不是四檔之一就略過（例如清掉評分時 setGrade 傳 undefined）。 */
export function recordGrade(cardKey, gradeStr, ts = Date.now()) {
  const code = GRADE_CODE[gradeStr];
  if (code === undefined || !cardKey) return;
  const h = load();
  const list = h.cards[cardKey] || [];
  list.push([code, Math.round(ts / 1000)]);
  while (list.length > MAX_PER_CARD) list.shift();
  h.cards[cardKey] = list;
  save(h);
}
