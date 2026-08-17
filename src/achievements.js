/* 遊戲化：一次性布林成就徽章（不做 XP 數值）。
   純判定清單 + 獨立 localStorage key，跟主 STORAGE_KEY 分開；ctx 由呼叫端組裝餵入，
   這裡保持 stateless，不碰 DOM／state.js。 */

const KEY = 'thai-review-achievements-v1';

export const ACHIEVEMENT_DEFS = [
  { id: 'streak7', icon: '🔥', label: '連續 7 天', check: ctx => ctx.streak >= 7 },
  { id: 'streak30', icon: '🔥', label: '連續 30 天', check: ctx => ctx.streak >= 30 },
  { id: 'daily50', icon: '📅', label: '單日複習 50 張', check: ctx => ctx.maxDailyReviewed >= 50 },
  { id: 'lessonMastered', icon: '🎓', label: '課程全通關', check: ctx => ctx.hasFullyMatureLesson },
  {
    id: 'allGraded',
    icon: '📚',
    label: ctx => `${ctx.totalCards} 張全上手`,
    check: ctx => ctx.totalCards > 0 && ctx.gradedCards >= ctx.totalCards,
  },
  { id: 'cumulative1000', icon: '🌟', label: '千張複習', check: ctx => ctx.totalReviewed >= 1000 },
  {
    id: 'weeklyAccuracy90',
    icon: '🎯',
    label: '一週正確率 90%+',
    check: ctx => ctx.weeklyAccuracy !== null && ctx.weeklyAccuracy >= 90,
  },
];

export function loadUnlocked() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : {};
  } catch {
    return {};
  }
}

function saveUnlocked(unlocked) {
  try {
    localStorage.setItem(KEY, JSON.stringify(unlocked));
  } catch (e) {
    console.warn('achievements save failed:', e.message);
  }
}

/* 檢查 ctx 是否觸發新成就，寫入 localStorage，回傳這次新解鎖的清單（給呼叫端顯示 toast）。 */
export function checkAndUnlock(ctx) {
  const unlocked = loadUnlocked();
  const justUnlocked = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (unlocked[def.id]) continue;
    if (def.check(ctx)) {
      unlocked[def.id] = Date.now();
      justUnlocked.push(def);
    }
  }
  if (justUnlocked.length) saveUnlocked(unlocked);
  return justUnlocked;
}

export function achievementLabel(def, ctx) {
  return typeof def.label === 'function' ? def.label(ctx) : def.label;
}
