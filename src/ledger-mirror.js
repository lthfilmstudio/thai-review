/* IDB 的 practice 投影 → 本機 localStorage 鏡射。

   IDB 是權威來源，這邊只是給既有 UI 讀的鏡射。所有寫入都是「設定」或「認得出
   重複」的語意，不是累加——開機每次都會重跑一遍，commit 完還沒鏡射就當掉的情況
   也是靠重跑修復，累加的話每修一次就多一次（R12）。 */

import { mirrorLedgerDay } from './today.js';
import { setResweepPosition, loadResweepState } from './resweep.js';
import { gradeFromCode, loadGradeHistory, recordGrade } from './grade-history.js';

const DAILY_PREFIX = 'daily:';
const HISTORY_PREFIX = 'history:';
const RESWEEP_NAME = 'resweep';

function plainRow(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function dailySnapshot(row) {
  return {
    reviewed: row.reviewed || 0,
    again: row.again || 0,
    hard: row.hard || 0,
    good: row.good || 0,
    easy: row.easy || 0,
    practice: row.practice || 0,
  };
}

/* projections 是 hydration 帶回來的 { name: row }。cardKeyById 只有要鏡射
   history 時才需要——IDB 用 stable card ID，本機的歷史用 legacy cardKey，
   對照表只有拿得到 catalog 的呼叫端知道。對不到的卡就跳過，不猜。 */
export function reconcileLedgerMirror({
  projections,
  cardKeyById = null,
  storage = localStorage,
} = {}) {
  const summary = {
    days: 0, resweep: 0, historyCards: 0, historyEntries: 0, skipped: [],
  };
  // hydrateWorkspaceSnapshot() 給的是排序過的陣列，別處拿到的是 { name: row }。
  // 兩種都收，名稱一律以 row.name 為準。
  const byName = Array.isArray(projections)
    ? Object.fromEntries(projections
      .filter(row => plainRow(row) && typeof row.name === 'string' && row.name)
      .map(row => [row.name, row]))
    : projections;
  if (!plainRow(byName)) return summary;

  for (const name of Object.keys(byName).sort()) {
    const row = byName[name];
    if (!plainRow(row) || row.schemaVersion !== 1) {
      summary.skipped.push(name);
      continue;
    }

    if (name.startsWith(DAILY_PREFIX)) {
      const dayKey = name.slice(DAILY_PREFIX.length);
      if (mirrorLedgerDay(dayKey, dailySnapshot(row), storage)) summary.days += 1;
      continue;
    }

    if (name === RESWEEP_NAME) {
      if (!Number.isSafeInteger(row.position) || row.position < 0) {
        summary.skipped.push(name);
        continue;
      }
      // 游標只往前，不往回退：本機可能已經被別的路徑推得更前面（cloud-sync
      // 合併過），退回去會讓已經掃過的卡再冒出來。
      if (row.position > (loadResweepState(storage).position || 0)) {
        setResweepPosition(row.position, storage);
        summary.resweep += 1;
      }
      continue;
    }

    if (name.startsWith(HISTORY_PREFIX)) {
      const cardId = name.slice(HISTORY_PREFIX.length);
      const cardKey = cardKeyById?.get?.(cardId) ?? cardKeyById?.[cardId];
      if (!cardKey || !Array.isArray(row.entries)) {
        summary.skipped.push(name);
        continue;
      }
      // recordGrade 的回傳值是「是不是進步時刻」，正常寫入也會回 false，
      // 不能拿它判斷有沒有寫進去。先看現有的 eventId 再決定要不要寫。
      const existing = loadGradeHistory(storage).cards[cardKey] || [];
      const known = new Set(
        existing.filter(entry => Array.isArray(entry)).map(entry => entry[2]).filter(Boolean),
      );
      let wrote = 0;
      for (const entry of row.entries) {
        if (!Array.isArray(entry) || entry.length < 3) continue;
        const [code, seconds, eventId] = entry;
        const grade = gradeFromCode(code);
        // 沒有 eventId 就認不出重播，寧可不鏡射也不要每次開機多記一筆。
        if (!grade || !Number.isFinite(seconds) || typeof eventId !== 'string' || !eventId) continue;
        if (known.has(eventId)) continue;
        recordGrade(cardKey, grade, seconds * 1000, storage, eventId);
        known.add(eventId);
        wrote += 1;
      }
      if (wrote) {
        summary.historyCards += 1;
        summary.historyEntries += wrote;
      }
      continue;
    }

    summary.skipped.push(name);
  }
  return summary;
}
