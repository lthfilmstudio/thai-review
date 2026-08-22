/* 遊戲化：一次性布林成就徽章（不做 XP 數值）。
   純判定清單 + 獨立 localStorage key，跟主 STORAGE_KEY 分開；ctx 由呼叫端組裝餵入，
   這裡保持 stateless，不碰 DOM／state.js。 */

const KEY = 'thai-review-achievements-v1';

export const ACHIEVEMENT_DEFS = [
  { id: 'streak7', iconId: 'flame', label: '連續 7 天', check: ctx => ctx.streak >= 7 },
  { id: 'streak30', iconId: 'flame', label: '連續 30 天', check: ctx => ctx.streak >= 30 },
  { id: 'streak100', iconId: 'flame', label: '連續 100 天', check: ctx => ctx.streak >= 100 },
  { id: 'daily50', iconId: 'calendar', label: '單日複習 50 張', check: ctx => ctx.maxDailyReviewed >= 50 },
  { id: 'lessonMastered', iconId: 'cap', label: '課程全通關', check: ctx => ctx.hasFullyMatureLesson },
  {
    id: 'allGraded',
    iconId: 'book',
    label: ctx => ctx.allLessonsLoaded === false ? '全部卡片上手' : `${ctx.totalCards} 張全上手`,
    check: ctx => ctx.allLessonsLoaded && ctx.totalCards > 0 && ctx.gradedCards >= ctx.totalCards,
  },
  { id: 'cumulative1000', iconId: 'star', label: '千張複習', check: ctx => ctx.totalReviewed >= 1000 },
  {
    id: 'weeklyAccuracy90',
    iconId: 'target',
    label: '一週正確率 90%+',
    check: ctx => ctx.weeklyAccuracy !== null && ctx.weeklyAccuracy >= 90,
  },
];

const ICON_PATHS = {
  flame: '<path d="M12.2 3.5c.3 2.7-1.4 4-2.8 5.4-1.2 1.2-2.4 2.5-2.4 4.6a5 5 0 0 0 10 0c0-2.1-1.1-3.7-2.7-5.1-.3 1.5-1 2.5-2 3.1.4-2.8-.4-5.3-.1-8z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9h16M8 13h2M14 13h2M8 17h2"/>',
  cap: '<path d="M3 9l9-5 9 5-9 5-9-5zM7 12v4c2.8 2.1 7.2 2.1 10 0v-4M21 9v6"/>',
  book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 4H11v15H7.5A3.5 3.5 0 0 0 4 20.5v-15zM20 5.5A3.5 3.5 0 0 0 16.5 4H13v15h3.5a3.5 3.5 0 0 1 3.5 1.5v-15z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6M15 6h3v3"/>',
};

export function achievementIconSvg(def) {
  const paths = ICON_PATHS[def?.iconId] || ICON_PATHS.star;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

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

/* 跨裝置同步用：把合併好的解鎖清單整份寫回。合併語意（聯集取較早解鎖時間）
   歸 src/cloud-merge.js 的 mergeAchievements，這裡只負責落地。 */
export function writeUnlocked(unlocked) {
  saveUnlocked(unlocked);
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
