/* 複習數據呈現：正確率趨勢 + 課次弱項 + 最弱字清單。
   純函式，資料即時從 daily log + state.progress 算，不另存彙總表。 */

import { localDateKey } from './state.js';
import { normalizeGrade } from './srs.js';
import { cardKey } from './state.js';

/* 一天的失分數：新舊資料形狀不同（新：again，舊：bad），兩者都當失敗算。 */
function dayFailCount(day) {
  if (!day) return 0;
  return (day.again || 0) + (day.bad || 0);
}

/* 近 windowDays 天的正確率趨勢（含今天），依日期由舊到新排列。
   當天沒複習過（reviewed=0）就回傳 pct=null，畫圖時當空白格處理，不算 0%。 */
export function accuracyTrend(logDays, windowDays, now = Date.now()) {
  const out = [];
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d.getTime());
    const day = logDays[key];
    const reviewed = day?.reviewed || 0;
    const pct = reviewed > 0 ? Math.round(((reviewed - dayFailCount(day)) / reviewed) * 100) : null;
    out.push({ key, reviewed, pct });
  }
  return out;
}

/* 有複習資料那幾天的平均正確率；沒資料回傳 null。 */
export function averageAccuracy(trend) {
  const withData = trend.filter(d => d.pct !== null);
  if (!withData.length) return null;
  return Math.round(withData.reduce((sum, d) => sum + d.pct, 0) / withData.length);
}

/* 依「目前評分為 again/hard 的比例」排出最弱的 5 堂課，樣本數太少的課次先濾掉避免誤導。 */
export function weakLessons(progress, lessons, minSamples = 5) {
  const rows = lessons.map(lesson => {
    let graded = 0, weak = 0;
    for (const card of lesson.cards) {
      const entry = progress[cardKey(card, lesson.id)];
      const raw = typeof entry === 'string' ? entry : entry?.grade;
      if (!raw) continue;
      graded++;
      const grade = normalizeGrade(raw);
      if (grade === 'again' || grade === 'hard') weak++;
    }
    return { lessonId: lesson.id, title: lesson.title, graded, weak, badRate: graded ? weak / graded : 0 };
  }).filter(r => r.graded >= minSamples && r.weak > 0);
  rows.sort((a, b) => b.badRate - a.badRate);
  return rows.slice(0, 5);
}

/* 目前評分卡在 again/hard 的單字，again 排前面，同檔位依 easeFactor 由低到高
  （easeFactor 會隨反覆評 hard 累積下降，是既有欄位裡最接近「常常卡住」的訊號）。 */
export function weakestCards(progress, lessons, limit = 20) {
  const rows = [];
  for (const lesson of lessons) {
    for (const card of lesson.cards) {
      const entry = progress[cardKey(card, lesson.id)];
      if (!entry || typeof entry !== 'object') continue;
      const grade = normalizeGrade(entry.grade);
      if (grade !== 'again' && grade !== 'hard') continue;
      rows.push({
        thai: card.thai,
        zh: card.zh,
        lessonTitle: lesson.title,
        grade,
        easeFactor: entry.easeFactor ?? 2.5,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.grade !== b.grade) return a.grade === 'again' ? -1 : 1;
    return a.easeFactor - b.easeFactor;
  });
  return rows.slice(0, limit);
}
