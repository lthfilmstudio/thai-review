/* 跨裝置同步引擎：拉 → 合併寫回本機 → 推。

   紀律（對齊 src/progress-sync.js）：**任何失敗都靜默吞掉、不阻塞複習**。
   沒登入、離線、Supabase 掛掉，App 的行為都要跟同步功能上線前一模一樣。

   合併規則本身在 src/cloud-merge.js（純函式、有測試）；這裡只負責搬運。 */

import { state, saveState } from './state.js';
import { loadGradeHistory, writeMergedHistory } from './grade-history.js';
import { getDeviceId } from './srs.js';
import { saveRemoteDays, applySyncedMeta, syncableMeta, settleStreakOnOpen } from './today.js';
import { loadUnlocked, writeUnlocked } from './achievements.js';
import { loadResweepState, setResweepPosition } from './resweep.js';
import { SUPABASE_URL, SUPABASE_KEY, getSession as authGetSession, readStoredSession } from './cloud-auth.js';
import {
  mergeRemoteRows, collectLocalChanges, keysClearedByReset,
  remoteDaysFromRows, ownDaysToRows, mergeAchievements, mergeFavorites,
  normalizeCardRows, changedDayRows,
} from './cloud-merge.js';

const REST = `${SUPABASE_URL}/rest/v1/thai_cards`;
const META = `${SUPABASE_URL}/rest/v1/thai_meta`;
const DAYS = `${SUPABASE_URL}/rest/v1/thai_days`;
const SYNC_KEY = 'thai-review-sync-v1';
const PAGE = 1000;          // 一次拉幾列（PostgREST 有預設上限，要自己分頁）
const CHUNK = 500;          // 一次推幾列，避免單次 payload 過大
const THROTTLE_MS = 120000; // 自動同步最密 2 分鐘一次
const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 250;
const KEEPALIVE_MAX_BYTES = 60 * 1024; // 保守留在瀏覽器 64 KiB 上限以下

let lastSyncAt = 0;
let lastSyncStorage = null;
let inFlight = null;
let inFlightStorage = null;
let resetInFlight = null;
let operationGeneration = 0;
let currentOperation = null;

const defaultSyncDeps = {
  getSession: authGetSession,
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxRetries: REQUEST_MAX_RETRIES,
  retryDelayMs: RETRY_DELAY_MS,
};
let syncDeps = { ...defaultSyncDeps };

/* 遠端進度併進本機後通知呼叫端。用 hook 而不是直接 import，理由跟 today.js 的
   setLogChangeHook 一樣：那邊已經 import 這個檔，互 import 會變成循環相依。
   ledger 用它 bump context epoch——卡片與課程沒變，但底下的到期狀態變了，
   還在路上的那筆評分不該把結果套到已經換過內容的畫面上（AE7）。 */
let remoteProgressHook = null;
let remoteResetHook = null;
export function setRemoteProgressHook(fn) { remoteProgressHook = fn; }

/* 別台裝置按的重置會以 epoch 傳過來。本機除了刪掉 progress 鍵，還得清掉 IndexedDB
   的權威 SRS，否則下次評分 getSrs() 會讀到重置前那一列當基準，排程整個跳回去，
   而且會以新的 updatedAt 通過 epoch 過濾推上雲端——別台的重置等於沒發生。
   跟 notifyRemoteProgress 不同，這條不吞例外：清不掉就讓整輪 sync 中止重來。 */
export function setRemoteResetHook(fn) { remoteResetHook = fn; }

function notifyRemoteProgress(reason) {
  try {
    remoteProgressHook?.(reason);
  } catch (e) {
    console.warn('remote progress hook failed:', e.message);
  }
}

/* 測試只替換 transport／session／clock，不改 production merge 語意。 */
export function __setSyncTestDeps(overrides = {}) {
  syncDeps = { ...defaultSyncDeps, ...overrides };
  return () => { syncDeps = { ...defaultSyncDeps }; };
}

function createOperation(storage = localStorage) {
  const controller = new AbortController();
  const op = {
    generation: ++operationGeneration,
    controller,
    userId: null,
    token: null,
    storage,
  };
  currentOperation = op;
  return op;
}

function ownsOperation(op, userId = op?.userId) {
  return !!op
    && currentOperation === op
    && op.generation === operationGeneration
    && !op.controller.signal.aborted
    && (!userId || op.userId === userId);
}

function ownershipError() {
  const error = new Error('sync operation lost ownership');
  error.code = 'SYNC_OWNERSHIP_LOST';
  return error;
}

function assertOwnership(op, userId = op?.userId) {
  if (!ownsOperation(op, userId)) throw ownershipError();
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function timeoutError() {
  const error = new Error('sync request timeout');
  error.code = 'SYNC_TIMEOUT';
  error.name = 'TimeoutError';
  return error;
}

function retryDelay(attempt) {
  return Math.max(0, Number(syncDeps.retryDelayMs) || 0) * (2 ** attempt);
}

async function request(url, init = {}, op = null) {
  const maxRetries = Math.max(0, Number(syncDeps.maxRetries) || 0);
  for (let attempt = 0; ; attempt++) {
    if (op) assertOwnership(op);

    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    let detachOperationAbort = () => {};
    const fetchPromise = Promise.resolve().then(() => syncDeps.fetch(url, {
      ...init,
      signal: controller.signal,
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, Math.max(0, Number(syncDeps.timeoutMs) || 0));
    });
    const pending = [fetchPromise, timeoutPromise];
    if (op) {
      const ownershipPromise = new Promise((_, reject) => {
        const abort = () => {
          controller.abort();
          reject(ownershipError());
        };
        if (op.controller.signal.aborted) abort();
        else {
          op.controller.signal.addEventListener('abort', abort, { once: true });
          detachOperationAbort = () => op.controller.signal.removeEventListener('abort', abort);
        }
      });
      pending.push(ownershipPromise);
    }

    try {
      const res = await Promise.race(pending);
      if (op) assertOwnership(op);
      if (!isRetryableStatus(res.status) || attempt >= maxRetries) return res;
    } catch (error) {
      if (error?.code === 'SYNC_OWNERSHIP_LOST' || (op && !ownsOperation(op))) {
        throw ownershipError();
      }
      // A caller-initiated AbortSignal is never retried.  Only our own timeout
      // and ordinary transport failures are eligible for bounded retry.
      if (isAbortError(error) && !timedOut) throw error;
      if (attempt >= maxRetries) throw error;
    } finally {
      clearTimeout(timer);
      detachOperationAbort();
    }

    if (op) assertOwnership(op);
    await syncDeps.sleep(retryDelay(attempt));
    if (op) assertOwnership(op);
  }
}

/* watermark：
   pulledAt  ＝ 已經拉到哪個 row_updated_at（server 時鐘，ISO 字串）
   pushedAt  ＝ 已經推到哪個 progress updatedAt（本機時鐘，毫秒）
   metaAt    ＝ 這台上次推 meta 時寫進 meta_updated_at 的值（本機時鐘，毫秒）
   resetAt   ＝ 上次同步看到的重置 epoch，給關頁補送用（那時來不及拉雲端）
   前兩個時鐘刻意分開存，不互相換算——混用會在裝置時間不準時漏資料。 */
function loadWatermark(storage = localStorage) {
  try {
    const raw = storage.getItem(SYNC_KEY);
    const w = raw ? JSON.parse(raw) : null;
    return {
      pulledAt: w?.pulledAt || null, pushedAt: w?.pushedAt || 0,
      pulledKey: w?.pulledKey || null,
      metaAt: w?.metaAt || 0, resetAt: w?.resetAt || 0, at: w?.at || 0,
    };
  } catch {
    return { pulledAt: null, pulledKey: null, pushedAt: 0, metaAt: 0, resetAt: 0, at: 0 };
  }
}

function saveWatermark(w, storage = localStorage) {
  try {
    storage.setItem(SYNC_KEY, JSON.stringify(w));
  } catch { /* 存不進去頂多下次多拉一輪，不影響正確性 */ }
}

export function lastSyncedAt(storage = localStorage) {
  return loadWatermark(storage).at;
}

/* 登出時清掉同步狀態。兩件事都必要：
   - watermark 留著的話，改用另一個帳號登入會沿用舊的 pulledAt，比它舊的列
     一輩子拉不下來。
   - remote days 留著的話，登出後統計/月曆還在混入別台裝置的數字，
     跟「這台不再同步」的說法對不上。 */
export function clearSyncState(storage = localStorage) {
  invalidateSync();
  try {
    storage.removeItem(SYNC_KEY);
  } catch { /* 清不掉頂多多拉一輪 */ }
  saveRemoteDays({}, storage);
  lastSyncAt = 0;
  lastSyncStorage = null;
}

/* 登出／切換帳號前先切斷所有舊 operation。舊 fetch 即使忽略 AbortSignal，
   回來後也會因 generation 不同而不能碰新 workspace。 */
export function invalidateSync() {
  clearTimeout(settleTimer);
  settleTimer = null;
  settleTimerStorage = null;
  const old = currentOperation;
  operationGeneration++;
  currentOperation = null;
  old?.controller.abort();
  inFlight = null;
  inFlightStorage = null;
  resetInFlight = null;
  lastSyncAt = 0;
  lastSyncStorage = null;
}

function headers(token) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function quoteFilterValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function setKeysetAfter(params, columns, cursor) {
  if (!cursor?.[columns[0]] || !cursor?.[columns[1]]) return;
  const [first, second] = columns;
  const firstValue = cursor[first];
  const secondValue = cursor[second];
  const firstFilter = quoteFilterValue(firstValue);
  const secondFilter = quoteFilterValue(secondValue);
  params.set('or', `(${first}.gt.${firstFilter},and(${first}.eq.${firstFilter},${second}.gt.${secondFilter}))`);
}

function cardCursor(row) {
  if (!row?.row_updated_at || !row?.card_key) return null;
  return { row_updated_at: String(row.row_updated_at), card_key: String(row.card_key) };
}

function dayCursor(row) {
  if (!row?.date || !row?.device_id) return null;
  return { date: String(row.date), device_id: String(row.device_id) };
}

/* 拉回 watermark 之後變動的列，使用雙欄 keyset 分頁。
   舊版只有 pulledAt 沒有 pulledKey，不能安全地從同 timestamp 繼續，故完整重拉。 */
async function pullRows(token, watermark, op) {
  const rows = [];
  let cursor = cardCursor({ row_updated_at: watermark.pulledAt, card_key: watermark.pulledKey });
  for (;;) {
    const params = new URLSearchParams({
      select: '*',
      order: 'row_updated_at.asc,card_key.asc',
      limit: String(PAGE),
    });
    // 沒有 pulledKey 時刻意不帶 pulledAt filter，確保舊 watermark 不漏同 timestamp 的列。
    setKeysetAfter(params, ['row_updated_at', 'card_key'], cursor);
    const res = await request(`${REST}?${params}`, { headers: headers(token) }, op);
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    const nextCursor = cardCursor(page[page.length - 1]);
    if (page.length < PAGE) {
      cursor = nextCursor || cursor;
      break;
    }
    if (!nextCursor || (cursor && nextCursor.row_updated_at === cursor.row_updated_at
      && nextCursor.card_key === cursor.card_key)) {
      throw new Error('pull pagination cursor missing or stalled');
    }
    cursor = nextCursor;
  }
  return { rows, cursor: cursor || cardCursor(rows[rows.length - 1]) };
}

/* 讀帳號層級的 meta（重置 epoch＋結算純量＋成就＋收藏＋重新複習游標）。
   沒有那列（第一次同步）回一個全空的預設值。 */
async function pullMeta(token, op) {
  const res = await request(`${META}?select=*`, { headers: headers(token) }, op);
  if (!res.ok) throw new Error(`meta ${res.status}`);
  const row = (await res.json())?.[0];
  return {
    reset_at: row?.reset_at ?? 0,
    protection: row?.protection ?? null,
    protection_refill_checkpoint: row?.protection_refill_checkpoint ?? null,
    makeup_pending: row?.makeup_pending ?? null,
    resweep_position: row?.resweep_position ?? 0,
    resweep_started_at: row?.resweep_started_at ?? 0,
    achievements: row?.achievements ?? {},
    favorites: row?.favorites ?? {},
    meta_updated_at: row?.meta_updated_at ?? 0,
  };
}

/* 拉所有裝置的每日日誌。刻意每次拉全部而不做增量：日誌只有每天一列、
   資料量小（一年 365 列 × 裝置數），而且 remote 視圖是「整份覆蓋」的語意，
   增量拉會讓「別台刪掉某天」這種情況算不對。 */
async function pullDays(token, op) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({
      select: '*', order: 'date.asc,device_id.asc', limit: String(PAGE),
    });
    setKeysetAfter(params, ['date', 'device_id'], cursor);
    const res = await request(`${DAYS}?${params}`, { headers: headers(token) }, op);
    if (!res.ok) throw new Error(`days ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
    const nextCursor = dayCursor(page[page.length - 1]);
    if (!nextCursor || (cursor && nextCursor.date === cursor.date
      && nextCursor.device_id === cursor.device_id)) {
      throw new Error('days pagination cursor missing or stalled');
    }
    cursor = nextCursor;
  }
  return rows;
}

async function pushDays(token, rows, userId, op) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(r => ({ ...r, user_id: userId }));
    const res = await request(DAYS, {
      method: 'POST',
      headers: { ...headers(token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    }, op);
    if (!res.ok) throw new Error(`pushDays ${res.status}`);
  }
}

async function pushMeta(token, userId, fields, op) {
  const res = await request(META, {
    method: 'POST',
    headers: { ...headers(token), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: userId, ...fields }]),
  }, op);
  if (!res.ok) throw new Error(`pushMeta ${res.status}`);
}

async function pushRows(token, rows, userId, op) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    // normalizeCardRows：PostgREST 要求同一批每列 key 完全一致，否則整批 400
    const chunk = normalizeCardRows(rows.slice(i, i + CHUNK)).map(r => ({ ...r, user_id: userId }));
    const res = await request(REST, {
      method: 'POST',
      headers: { ...headers(token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    }, op);
    if (!res.ok) throw new Error(`push ${res.status}`);
  }
}

/* 跑一輪完整同步。回傳 { pulled, pushed } 或 null（沒登入 / 出錯）。
   同一時間只跑一輪，重複呼叫會共用同一個 promise。 */
export function syncNow(storage = localStorage) {
  if ((inFlight && inFlightStorage !== storage)
      || (settleTimer !== null && settleTimerStorage !== storage)) {
    invalidateSync();
  }
  if (resetInFlight) return Promise.resolve(null);
  if (inFlight) return inFlight;
  const op = createOperation(storage);
  const promise = runSync(op).finally(() => {
    if (inFlight === promise) {
      inFlight = null;
      inFlightStorage = null;
    }
    if (currentOperation === op) currentOperation = null;
  });
  inFlight = promise;
  inFlightStorage = storage;
  return promise;
}

async function runSync(op) {
  let session;
  try {
    session = await syncDeps.getSession();
  } catch {
    return null;
  }
  if (!ownsOperation(op)) return null;
  const token = session?.access_token;
  const userId = session?.user?.id;
  if (!token || !userId) return null;
  op.userId = userId;
  op.token = token;
  if (!ownsOperation(op, userId)) return null;

  const w = loadWatermark(op.storage);
  // 在收集本機變更「之前」就記下時間：同步跑到一半評的分，時間戳一定大於
  // 這個值，下一輪才不會被跳過（見下面 pushedAt 的說明）。
  const startedAt = syncDeps.now();

  try {
    // 0) 先拉 meta。順序很重要：要先知道重置 epoch「哪個時間點以前的都不算數」，
    //    後面的合併跟上傳才不會把已經被別台裝置清掉的資料收回來或推回去。
    const meta = await pullMeta(token, op);
    assertOwnership(op, userId);
    const resetAt = meta.reset_at;
    const clearedKeys = keysClearedByReset(state.progress, resetAt);
    if (clearedKeys.length) {
      // 先清 IDB 的權威 SRS，再清本機鏡射。順序跟手動重置一致，理由見
      // setRemoteResetHook 上面那段。
      await remoteResetHook?.();
      for (const k of clearedKeys) delete state.progress[k];
      saveState(op.storage);
      notifyRemoteProgress('reset-epoch');
    }

    // 1) 拉遠端變動並合併進本機
    const pulled = await pullRows(token, w, op);
    assertOwnership(op, userId);
    const rows = pulled.rows;
    const history = loadGradeHistory(op.storage);
    const { progress, history: mergedHistory, edits } = mergeRemoteRows(
      rows, state.progress, history.cards, resetAt, state.edits);

    const changedKeys = Object.keys(progress);
    const editKeys = Object.keys(edits);
    if (changedKeys.length || editKeys.length) {
      for (const k of changedKeys) state.progress[k] = progress[k];
      for (const k of editKeys) state.edits[k] = edits[k];
      saveState(op.storage);
      notifyRemoteProgress('remote-merge');
    }
    writeMergedHistory(mergedHistory, op.storage);

    // watermark 取「這批列裡最大的 row_updated_at」，不是取 now()——
    // 用本機時鐘當基準的話，裝置時間偏差會直接變成漏資料。
    const pulledAt = pulled.cursor?.row_updated_at || w.pulledAt || null;
    const pulledKey = pulled.cursor?.card_key || w.pulledKey || null;

    // 2) 推本機變動。即使 progress 剛從遠端採納，也要保留同卡本機較新的
    //    history／edit 欄位一起送出；DB trigger 會逐組判斷，重送同一 progress 無害。
    const outgoing = collectLocalChanges(
      state.progress, loadGradeHistory(op.storage).cards, w.pushedAt, resetAt, state.edits);
    if (outgoing.length) await pushRows(token, outgoing, userId, op);
    assertOwnership(op, userId);

    /* pushedAt 用「同步開始的本機時間」，不是「這批推上去的最大時間戳」。
       原因：另一台裝置的時鐘可能比較快，拉回來的紀錄會帶未來的時間戳；
       如果拿它當 watermark，本機在那之後評的分（時間戳比較小）就會永遠
       被跳過＝評分遺失。退 1 秒當安全邊際——寧可重推幾筆（DB 的 LWW
       trigger 會判定沒變動、無害），也不要漏掉任何一次評分。 */
    const pushedAt = Math.max(w.pushedAt, startedAt - 1000);

    // 3) 每日日誌：拉回所有裝置的列，扣掉自己那台後存成 remote 視圖。
    //    漏掉「扣掉自己」會自己加自己，當天數字直接翻倍。
    const deviceId = getDeviceId();
    const dayRows = await pullDays(token, op);
    assertOwnership(op, userId);
    saveRemoteDays(remoteDaysFromRows(dayRows, deviceId), op.storage);

    // 4) 遠端的結算純量比較新的話，先收下來再結算。
    //    比較對象是「這台上次推 meta 時寫的 meta_updated_at」，不是 startedAt——
    //    拿 startedAt 比等於在問「別台的時鐘有沒有超前我」，正常情況永遠是否，
    //    保護數量就永遠同步不下來，別台花掉的保護會被這台原封不動推回去。
    assertOwnership(op, userId);
    if ((meta.meta_updated_at || 0) > w.metaAt && meta.protection !== null) {
      applySyncedMeta({
        protection: meta.protection,
        protectionRefillCheckpoint: meta.protection_refill_checkpoint,
        makeupPending: meta.makeup_pending,
      }, op.storage);
    }

    // 5) 結算 streak——**一定要在合併完 days、收下遠端純量之後跑**，這樣它是
    //    看著所有裝置的出席紀錄與最新的保護數量做決定（在手機上複習過的那天
    //    不會被誤判成缺口）。結算完才讀 syncableMeta()，推上去的才是結算結果。
    assertOwnership(op, userId);
    settleStreakOnOpen(undefined, op.storage);

    // 6) 推自己的 days + 合併後的 meta。只推跟雲端不一樣的日子——整份重推的話
    //    每次同步都會白寫一年份的列（thai_days_touch 每次都會動 row_updated_at）。
    const local = syncableMeta(op.storage);
    const ownRows = changedDayRows(
      ownDaysToRows(local.ownDays, deviceId),
      dayRows.filter(r => r.device_id === deviceId));
    if (ownRows.length) await pushDays(token, ownRows, userId, op);
    assertOwnership(op, userId);

    const mergedAchv = mergeAchievements(loadUnlocked(op.storage), meta.achievements);
    const mergedFavs = mergeFavorites(state.favorites, meta.favorites);
    assertOwnership(op, userId);
    writeUnlocked(mergedAchv, op.storage);
    state.favorites = mergedFavs;

    const resweep = loadResweepState(op.storage);
    const mergedResweepPos = Math.max(resweep.position || 0, meta.resweep_position || 0);
    if (mergedResweepPos !== resweep.position) setResweepPosition(mergedResweepPos, op.storage);

    await pushMeta(token, userId, {
      protection: local.protection,
      protection_refill_checkpoint: local.protectionRefillCheckpoint,
      makeup_pending: local.makeupPending,
      resweep_position: mergedResweepPos,
      resweep_started_at: resweep.startedAt || 0,
      achievements: mergedAchv,
      favorites: mergedFavs,
      meta_updated_at: startedAt,
    }, op);
    assertOwnership(op, userId);
    saveState(op.storage);

    const at = syncDeps.now();
    lastSyncAt = at;
    lastSyncStorage = op.storage;
    saveWatermark({ pulledAt, pulledKey, pushedAt, metaAt: startedAt, resetAt, at }, op.storage);
    return { pulled: changedKeys.length, pushed: outgoing.length, cleared: clearedKeys.length };
  } catch (e) {
    if (e?.code === 'SYNC_OWNERSHIP_LOST') return null;
    // 同步失敗不影響複習；watermark 不動，下次會重試同一段。
    console.warn('雲端同步失敗（不影響本機複習）：', e.message);
    return null;
  }
}

/* 重置所有裝置的學習進度。

   做法是寫一個「重置時間」epoch 到雲端，任何評分時間早於它的紀錄，所有裝置
   在下次同步時都會自己清掉——包含當下離線、之後才連上來的裝置，以及第一次
   登入的新裝置。不是逐張卡寫墓碑：那樣漏寫一張就會復活一張。

   雲端那幾列也一併刪掉，只是為了不讓資料表堆垃圾；正確性由 epoch 保證，
   就算刪除失敗、或有離線裝置事後把舊紀錄推回來，也會被 epoch 濾掉。

   回傳 true 代表雲端已標記成功。沒登入回 null——呼叫端要據此決定要不要
   提示使用者「只清掉這台」。 */
export function resetProgressEverywhere(storage = localStorage) {
  if (resetInFlight) return resetInFlight;
  // Reset 是破壞性 operation；先中止普通 sync，避免兩者交錯寫 watermark。
  invalidateSync();
  const op = createOperation(storage);
  const promise = runReset(op).finally(() => {
    if (resetInFlight === promise) resetInFlight = null;
    if (currentOperation === op) currentOperation = null;
  });
  resetInFlight = promise;
  return promise;
}

async function runReset(op) {
  try {
    const session = await syncDeps.getSession();
    if (!ownsOperation(op)) return null;
    const token = session?.access_token;
    const userId = session?.user?.id;
    if (!token || !userId) return null;
    op.userId = userId;
    op.token = token;
    assertOwnership(op, userId);

    const resetAt = syncDeps.now();
    const res = await request(META, {
      method: 'POST',
      headers: { ...headers(token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: userId, reset_at: resetAt }]),
    }, op);
    if (!res.ok) throw new Error(`reset ${res.status}`);
    // epoch 已經寫入遠端，但後續本機寫入仍須確認 ownership。
    assertOwnership(op, userId);

    // 清掉雲端既有列（失敗不致命，epoch 已經生效）
    try {
      await request(`${REST}?user_id=eq.${userId}`, { method: 'DELETE', headers: headers(token) }, op);
    } catch (e) {
      if (e?.code === 'SYNC_OWNERSHIP_LOST') return null;
      /* 留著也無妨，之後同步一律被 epoch 濾掉 */
    }

    // 本機 watermark 重來：pulledAt 清空讓下次同步重新對齊，
    // pushedAt 推到 resetAt 之後，避免把剛清掉的資料又推上去。
    assertOwnership(op, userId);
    saveWatermark({ pulledAt: null, pulledKey: null, pushedAt: resetAt, metaAt: 0,
      resetAt, at: syncDeps.now() }, op.storage);
    return true;
  } catch (e) {
    if (e?.code === 'SYNC_OWNERSHIP_LOST') return null;
    throw e;
  } finally {
    if (currentOperation === op) currentOperation = null;
  }
}

/* 節流版，給 app.js 的 15 秒 ticker 呼叫。 */
export function syncThrottled(storage = localStorage) {
  if (resetInFlight) return;
  if (lastSyncStorage !== storage) lastSyncAt = 0;
  if (Date.now() - lastSyncAt < THROTTLE_MS) return;
  const pending = syncNow(storage);
  lastSyncAt = Date.now();   // 先卡住，避免慢請求期間被重複觸發
  lastSyncStorage = storage;
  void pending;
}

/* 評分後的即時同步（去抖動）。
   為什麼需要這支：只靠「切背景」跟「每 2 分鐘節流」不夠——評完分就把 App
   關掉的話，切背景那次的 fetch 會被瀏覽器連同分頁一起砍掉，那批評分就留在
   本機上不去（2026-08-22 實測踩到）。連續評卡時每張都同步太吵，所以去抖動
   ：停手 SETTLE_MS 才送，中途再評分就重新計時。 */
const SETTLE_MS = 4000;
let settleTimer = null;
let settleTimerStorage = null;

export function syncSoon(storage = localStorage) {
  clearTimeout(settleTimer);
  settleTimerStorage = storage;
  settleTimer = setTimeout(() => {
    const queuedStorage = settleTimerStorage;
    settleTimer = null;
    settleTimerStorage = null;
    void syncNow(queuedStorage);
  }, SETTLE_MS);
}

/* 關頁/切背景時的保險：只補送「還沒推上去的」那幾筆，不做拉取——關頁當下
   也沒機會處理回應。

   用 fetch + keepalive 而不是 sendBeacon：sendBeacon 不能自訂 header，只能
   把 token 塞進 query string，那會讓 token 留在各層存取紀錄裡，不能這樣做。
   keepalive 一樣能在分頁關閉後把請求送完，而且 header 照常帶。
   代價是 keepalive 有 64KB payload 上限，所以這裡只送最多 MAX_FLUSH 筆；
   沒送完的下次開 App 會補推（watermark 沒動）。 */
const MAX_FLUSH = 60;

export function flushOnHide(storage = localStorage) {
  const session = readStoredSession();
  if (!session?.access_token || !session?.user?.id) return false;

  const w = loadWatermark(storage);
  const rows = collectLocalChanges(
    state.progress, loadGradeHistory(storage).cards, w.pushedAt, w.resetAt, state.edits);
  if (!rows.length) return false;

  const candidates = normalizeCardRows(rows.slice(0, MAX_FLUSH))
    .map(r => ({ ...r, user_id: session.user.id }));
  const encoder = new TextEncoder();
  let payload = [];
  let body = '[]';
  for (const row of candidates) {
    const nextBody = JSON.stringify([...payload, row]);
    if (encoder.encode(nextBody).byteLength >= KEEPALIVE_MAX_BYTES) break;
    payload = [...payload, row];
    body = nextBody;
  }
  // 單筆就超過上限時不發 keepalive，留給一般 sync；這裡不碰 watermark。
  if (!payload.length) return false;
  try {
    // 一次只送一個請求；剩餘資料交給下次普通 sync，避免多個 keepalive 合計超額。
    void Promise.resolve(syncDeps.fetch(REST, {
      method: 'POST',
      headers: { ...headers(session.access_token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body,
      keepalive: true,
    })).catch(() => {});
  } catch {
    return false;
  }
  // 刻意不更新 watermark：這批有沒有真的送達無從得知，留給下次同步用 LWW
  // 重推一次（DB 端會判定沒變動，無害），比誤以為送出去了安全。
  return true;
}
