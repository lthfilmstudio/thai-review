/* 跨裝置同步的合併語意。全部是純函式（不碰 localStorage、不發網路請求），
   方便在 tests/cloud_merge.test.mjs 裡窮舉各種先後順序。

   最重要的性質：**合併必須可交換又冪等**——不管兩台裝置誰先同步、同一批
   資料被合併幾次，收斂結果都要一樣。所以一律用資料自身帶的時間戳決定勝負，
   不看「誰後到」。

   這裡的規則必須跟 DB 的 thai_cards_merge trigger 一致（見
   docs/cloud-sync-2026-08.md）；兩邊不一致的話，本機看到的跟雲端存的會不同。 */

export const HISTORY_MAX = 5;   // 對齊 src/grade-history.js 的 MAX_PER_CARD

/* progress entry 的有效時間戳。舊資料可能沒有 updatedAt（migrate 進來的
   只有 nextReviewAt），退回 reviewedAt，再退回 0 當「最舊」。 */
export function progressStamp(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  return entry.updatedAt ?? entry.reviewedAt ?? 0;
}

/* 本機 progress entry → DB 列。cardKey 是 "lessonId:thai"。 */
export function progressToRow(cardKey, entry) {
  return {
    card_key: cardKey,
    grade: entry.grade ?? null,
    reviewed_at: entry.reviewedAt ?? null,
    next_review_at: entry.nextReviewAt ?? null,
    interval_days: entry.interval ?? null,
    ease_factor: entry.easeFactor ?? null,
    reps: entry.reps ?? null,
    device_id: entry.deviceId ?? null,
    progress_updated_at: progressStamp(entry),
  };
}

/* DB 列 → 本機 progress entry。沒評過分（grade 為空）的列回 null，
   讓呼叫端知道不要寫進 state.progress。 */
export function rowToProgress(row) {
  if (!row || !row.grade) return null;
  return {
    grade: row.grade,
    reviewedAt: row.reviewed_at ?? 0,
    nextReviewAt: row.next_review_at ?? 0,
    interval: row.interval_days ?? 0,
    easeFactor: row.ease_factor ?? 2.5,
    reps: row.reps ?? 0,
    updatedAt: row.progress_updated_at ?? 0,
    deviceId: row.device_id ?? null,
  };
}

/* 兩筆 progress 取較新的那筆（last-write-wins）。
   平手時保留 local，避免每次同步都判定成「有變動」而反覆寫回。 */
export function mergeProgress(local, remote) {
  if (!remote) return local ?? null;
  if (!local) return remote;
  return progressStamp(remote) > progressStamp(local) ? remote : local;
}

/* 評分歷史合併：兩邊都是 [[code, tsSeconds], ...]，時間戳單位是「秒」
   （src/grade-history.js:47 存的是 Math.round(ts / 1000)）。
   取聯集、依時間排序、同一秒同一評分視為同一筆去重，最後保留最近 HISTORY_MAX 筆。
   刻意不做 last-write-wins——歷史是累積的，兩台各評過的都該留下。 */
export function mergeHistory(local, remote) {
  const seen = new Set();
  const all = [];
  for (const item of [...(local || []), ...(remote || [])]) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [code, ts] = item;
    if (!Number.isFinite(code) || !Number.isFinite(ts)) continue;
    const sig = `${code}:${ts}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    all.push([code, ts]);
  }
  all.sort((a, b) => a[1] - b[1]);
  return all.slice(-HISTORY_MAX);
}

/* 拉下來的一批列 → 要寫回本機的變更。
   回傳 { progress, history }，兩個都是 { cardKey: 值 } 的 map，只包含
   「遠端比較新、需要覆蓋本機」的項目；沒有變動的卡不會出現在結果裡，
   呼叫端可以用有沒有 key 判斷要不要存檔。 */
export function mergeRemoteRows(rows, localProgress, localHistory, resetAt = 0) {
  const progress = {};
  const history = {};

  for (const row of rows || []) {
    const key = row?.card_key;
    if (!key) continue;

    // 重置 epoch 之前的紀錄一律當作已清除。這行讓「第一次登入的新裝置」也能
    // 正確套用重置——它的 watermark 是空的，會把雲端所有列都拉下來，沒有這個
    // 過濾就會把已經重置掉的舊資料當成新資料收進來。
    if ((row.progress_updated_at ?? 0) <= resetAt) continue;

    const remoteEntry = rowToProgress(row);
    if (remoteEntry) {
      const merged = mergeProgress(localProgress?.[key], remoteEntry);
      if (merged === remoteEntry) progress[key] = merged;
    }

    if (Array.isArray(row.history)) {
      const mergedHistory = mergeHistory(localHistory?.[key], row.history);
      const before = JSON.stringify(localHistory?.[key] || []);
      if (JSON.stringify(mergedHistory) !== before) history[key] = mergedHistory;
    }
  }

  return { progress, history };
}

/* ===== 每日日誌（Phase B）=====

   關鍵前提：**本機的「自己的紀錄」跟「合併後的顯示值」是兩份東西。**
   `thai-review-daily-v1` 的 days 永遠只放這台自己的計數（推送就推這份），
   合併後的視圖另外算。混在一起的話，這台下次會把別台的數字當成自己的推
   上去，加總後爆增。 */

const DAY_COUNTERS = ['reviewed', 'again', 'hard', 'good', 'easy', 'games', 'seconds'];

/* thai_days 的各列 → 「排除自己那台」的 remote 視圖。
   `excludeDeviceId` 漏掉的話就會自己加自己，當天數字直接翻倍。 */
export function remoteDaysFromRows(rows, excludeDeviceId) {
  const out = {};
  for (const row of rows || []) {
    if (!row?.date) continue;
    if (excludeDeviceId && row.device_id === excludeDeviceId) continue;
    const day = out[row.date] || (out[row.date] = {
      reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0,
      gameIds: [], bridged: false,
    });
    for (const k of DAY_COUNTERS) day[k] += Math.max(0, row[k] || 0);
    for (const g of row.game_ids || []) if (!day.gameIds.includes(g)) day.gameIds.push(g);
    if (row.bridged) day.bridged = true;
  }
  return out;
}

/* 自己的 days ＋ 其他裝置的 days → 顯示用的合併視圖。
   計數相加、gameIds 聯集、bridged 取 OR。
   沒有 remote 資料時結果必須等同於原本的 own（未登入回歸的硬條件）。 */
export function mergedDays(own, remote) {
  if (!remote || !Object.keys(remote).length) return own || {};
  const out = {};
  for (const key of new Set([...Object.keys(own || {}), ...Object.keys(remote)])) {
    const a = (own || {})[key];
    const b = remote[key];
    if (!b) { out[key] = a; continue; }
    if (!a) { out[key] = b; continue; }
    const day = { ...a };
    for (const k of DAY_COUNTERS) day[k] = (a[k] || 0) + (b[k] || 0);
    const ids = [...(a.gameIds || [])];
    for (const g of b.gameIds || []) if (!ids.includes(g)) ids.push(g);
    day.gameIds = ids;
    day.bridged = !!(a.bridged || b.bridged);
    out[key] = day;
  }
  return out;
}

/* 自己的 days → 要上傳的列。只挑有內容的日子，空白日不佔一列。 */
export function ownDaysToRows(days, deviceId) {
  const rows = [];
  for (const date in days || {}) {
    const d = days[date];
    if (!d) continue;
    const hasAny = DAY_COUNTERS.some(k => (d[k] || 0) > 0) || d.bridged || (d.gameIds || []).length;
    if (!hasAny) continue;
    rows.push({
      date, device_id: deviceId,
      reviewed: d.reviewed || 0, again: d.again || 0, hard: d.hard || 0,
      good: d.good || 0, easy: d.easy || 0, games: d.games || 0, seconds: d.seconds || 0,
      game_ids: d.gameIds || [],
      bridged: !!d.bridged,
    });
  }
  return rows;
}

/* 成就：聯集，同一個成就取較早的解鎖時間。沒有「取消解鎖」。 */
export function mergeAchievements(a, b) {
  const out = { ...(a || {}) };
  for (const k in b || {}) {
    const cur = out[k];
    const incoming = b[k];
    if (!cur || (incoming > 0 && incoming < cur)) out[k] = incoming;
  }
  return out;
}

/* 收藏：{泰文: {v:0|1, ts}} tombstone，逐 key 比 ts。
   v=0 是「取消收藏」的墓碑，必須能蓋掉舊的 v=1——所以不能用聯集。 */
export function mergeFavorites(a, b) {
  const out = { ...(a || {}) };
  for (const k in b || {}) {
    const cur = out[k];
    if (!cur || (b[k]?.ts ?? 0) > (cur.ts ?? -1)) out[k] = b[k];
  }
  return out;
}

/* 套用重置 epoch：挑出本機該清掉的卡（評分時間早於等於 reset_at 的）。
   回傳要刪的 key 陣列；呼叫端負責真的刪、存檔。
   刻意不直接改傳進來的物件——純函式好測，也避免呼叫端沒預期到被就地修改。 */
export function keysClearedByReset(localProgress, resetAt) {
  if (!resetAt) return [];
  const keys = [];
  for (const key in localProgress) {
    const entry = localProgress[key];
    if (!entry || typeof entry !== 'object') continue;
    if (progressStamp(entry) <= resetAt) keys.push(key);
  }
  return keys;
}

/* 挑出「本機比 watermark 新、需要上傳」的卡。
   history 沒有自己的時間戳，跟著同一張卡的 progress 一起上傳即可
   （歷史只在評分當下變動，跟 progress 同步發生）。 */
export function collectLocalChanges(localProgress, localHistory, since, resetAt = 0) {
  const rows = [];
  for (const key in localProgress) {
    const entry = localProgress[key];
    if (!entry || typeof entry !== 'object') continue;
    const stamp = progressStamp(entry);
    if (stamp <= since) continue;
    // 重置之前的紀錄不再上傳，否則離線裝置一連上線就會把已清掉的資料推回雲端
    if (stamp <= resetAt) continue;
    const row = progressToRow(key, entry);
    const hist = localHistory?.[key];
    if (Array.isArray(hist) && hist.length) {
      row.history = hist;
      row.history_updated_at = stamp;
    }
    rows.push(row);
  }
  return rows;
}
