/* SRS 排程：SM-2 簡化版（Anki / Quizlet 同款）。
   純函式 + 一個裝置 ID helper，stateless 方便測試。
   4 檔評分（again/hard/good/easy）對 SM-2 quality：again=0、hard=3、good=4、easy=5；
   again 是獨立分支（重置 reps/interval），但 easeFactor 公式跟其他三檔一樣照跑，
   讓常答錯的字持續往下掉 EF，不是只重來一次卻不記難度。 */

const DAY_MS = 86400000;
const GRADE_Q = { again: 0, hard: 3, good: 4, easy: 5 };

/* 舊版三檔資料（bad/ok/good）讀出來時要能對回新四檔，才能讓清單篩選 / 對話字源
   在混合新舊資料時正確分類，不需要另外寫 migration 改寫已存的 grade 字串。 */
const LEGACY_GRADE_MAP = { bad: 'again', ok: 'hard' };

export function normalizeGrade(gradeStr) {
  return LEGACY_GRADE_MAP[gradeStr] ?? gradeStr;
}

export function nextReview(gradeStr, prev = {}, now = Date.now()) {
  let { interval = 0, easeFactor = 2.5, reps = 0 } = prev;
  const q = GRADE_Q[gradeStr] ?? 4;
  easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (gradeStr === 'again') {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 3;        // 客製：泰文密集學習，原 SM-2 是 6
    else interval = Math.round(interval * easeFactor);
    if (gradeStr === 'hard') interval = Math.max(1, Math.round(interval * 0.7));
    else if (gradeStr === 'easy') interval = Math.round(interval * 1.3);
  }

  return {
    grade: gradeStr,
    reviewedAt: now,
    nextReviewAt: now + interval * DAY_MS,
    interval,
    easeFactor,
    reps,
    updatedAt: now,
    deviceId: getDeviceId(),
  };
}

/* 從既有 reps/interval 推導卡片狀態，不新增獨立欄位。
   new：從沒評過分；learning：評過分但 reps=0（含被 again 重置的）；
   mature：interval ≥ 21 天（沿用 Anki 慣例）；review：介於中間。 */
export function cardStatus(entry) {
  if (!entry || typeof entry !== 'object') return 'new';
  if (!entry.reps) return 'learning';
  if (entry.interval >= 21) return 'mature';
  return 'review';
}

/* due 的定義：「曾經評過分」+「下次複習時間已到」。
   從未評過的新卡不算 due（不會塞爆 SRS 隊列），使用者要去字卡模式手動評才會進排程。
   舊版 string grade 已 migrate 成 {nextReviewAt: 0} → 算 due（時間已過 0）。 */
export function isDue(progressEntry, now = Date.now()) {
  if (!progressEntry || typeof progressEntry !== 'object') return false;
  return (progressEntry.nextReviewAt ?? 0) <= now;
}

/* 相對逾期程度：逾期天數 ÷ interval 天數，越大代表越可能忘記
   （interval 短又逾期的卡，比 interval 長、逾期天數一樣的卡更該優先複習）。
   從沒排過程的卡（interval=0）當作 interval=1 天算，避免除以 0。 */
function overdueRatio(entry, now) {
  const next = entry?.nextReviewAt ?? 0;
  const interval = Math.max(1, entry?.interval || 1);
  return (now - next) / (interval * DAY_MS);
}

/* 從一批 cards 中過濾出 due 卡並排序。
   每張 card 必須帶 _lessonId（虛擬課程已有；真實課程要在組 cards 時補上）。
   opts.lessonId：限定來自某堂課（單課 SRS 用）
   排序依「相對逾期程度」由大到小（設計書 docs/mastery-sprint-plan-2026-08.md），
   不是絕對 nextReviewAt——interval 短又逾期的卡代表更可能忘記，優先排。 */
export function getDueCards(allCards, progress, opts = {}) {
  const now = Date.now();
  return allCards
    .filter(c => {
      if (!c._lessonId) return false;
      if (opts.lessonId && c._lessonId !== opts.lessonId) return false;
      const key = `${c._lessonId}:${c.thai}`;
      return isDue(progress[key], now);
    })
    .sort((a, b) => {
      const ka = `${a._lessonId}:${a.thai}`, kb = `${b._lessonId}:${b.thai}`;
      return overdueRatio(progress[kb], now) - overdueRatio(progress[ka], now);
    });
}

export function countDue(cards, progress, lessonId) {
  const now = Date.now();
  let n = 0;
  for (const c of cards) {
    if (!c._lessonId) continue;
    if (lessonId && c._lessonId !== lessonId) continue;
    if (isDue(progress[`${c._lessonId}:${c.thai}`], now)) n++;
  }
  return n;
}

/* 從 progress 取「下一次」最近的 nextReviewAt（給空狀態顯示「下次複習：明天」用）。
   略過已到期的（≤ now），那些屬於「現在就該複」而非「下一次」。 */
export function nextReviewAtMin(progress, now = Date.now()) {
  let min = Infinity;
  for (const k in progress) {
    const e = progress[k];
    if (!e || typeof e !== 'object') continue;
    if (typeof e.nextReviewAt !== 'number') continue;
    if (e.nextReviewAt <= now) continue;
    if (e.nextReviewAt < min) min = e.nextReviewAt;
  }
  return min === Infinity ? null : min;
}

export function formatNextReview(intervalDays) {
  if (intervalDays < 1) return '< 1 天';
  if (intervalDays === 1) return '明天';
  if (intervalDays < 7) return `${intervalDays} 天後`;
  if (intervalDays < 30) return `${Math.round(intervalDays / 7)} 週後`;
  if (intervalDays < 365) return `${Math.round(intervalDays / 30)} 個月後`;
  return '> 1 年';
}

/* 從現在到目標時間的天數（向上取整、最少 0） */
export function daysUntil(targetMs, now = Date.now()) {
  if (typeof targetMs !== 'number') return 0;
  const ms = targetMs - now;
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

export function getDeviceId() {
  let id = localStorage.getItem('thai-review-device-id');
  if (!id) {
    id = `${navigator.platform}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('thai-review-device-id', id);
  }
  return id;
}
