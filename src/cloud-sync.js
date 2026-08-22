/* 跨裝置同步引擎：拉 → 合併寫回本機 → 推。

   紀律（對齊 src/progress-sync.js）：**任何失敗都靜默吞掉、不阻塞複習**。
   沒登入、離線、Supabase 掛掉，App 的行為都要跟同步功能上線前一模一樣。

   合併規則本身在 src/cloud-merge.js（純函式、有測試）；這裡只負責搬運。 */

import { state, saveState } from './state.js';
import { loadGradeHistory, writeMergedHistory } from './grade-history.js';
import { SUPABASE_URL, SUPABASE_KEY, getSession, readStoredSession } from './cloud-auth.js';
import { mergeRemoteRows, collectLocalChanges } from './cloud-merge.js';

const REST = `${SUPABASE_URL}/rest/v1/thai_cards`;
const SYNC_KEY = 'thai-review-sync-v1';
const PAGE = 1000;          // 一次拉幾列（PostgREST 有預設上限，要自己分頁）
const CHUNK = 500;          // 一次推幾列，避免單次 payload 過大
const THROTTLE_MS = 120000; // 自動同步最密 2 分鐘一次

let lastSyncAt = 0;
let inFlight = null;

/* watermark：
   pulledAt  ＝ 已經拉到哪個 row_updated_at（server 時鐘，ISO 字串）
   pushedAt  ＝ 已經推到哪個 progress updatedAt（本機時鐘，毫秒）
   兩個時鐘刻意分開存，不互相換算——混用會在裝置時間不準時漏資料。 */
function loadWatermark() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    const w = raw ? JSON.parse(raw) : null;
    return { pulledAt: w?.pulledAt || null, pushedAt: w?.pushedAt || 0, at: w?.at || 0 };
  } catch {
    return { pulledAt: null, pushedAt: 0, at: 0 };
  }
}

function saveWatermark(w) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(w));
  } catch { /* 存不進去頂多下次多拉一輪，不影響正確性 */ }
}

export function lastSyncedAt() {
  return loadWatermark().at;
}

function headers(token) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/* 拉回 watermark 之後變動的列，分頁拉到拉完為止。 */
async function pullRows(token, since) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      select: '*',
      order: 'row_updated_at.asc',
      limit: String(PAGE),
      offset: String(offset),
    });
    if (since) params.set('row_updated_at', `gt.${since}`);
    const res = await fetch(`${REST}?${params}`, { headers: headers(token) });
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

async function pushRows(token, rows, userId) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(r => ({ ...r, user_id: userId }));
    const res = await fetch(REST, {
      method: 'POST',
      headers: { ...headers(token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
  }
}

/* 跑一輪完整同步。回傳 { pulled, pushed } 或 null（沒登入 / 出錯）。
   同一時間只跑一輪，重複呼叫會共用同一個 promise。 */
export function syncNow() {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function runSync() {
  let session;
  try {
    session = await getSession();
  } catch {
    return null;
  }
  const token = session?.access_token;
  const userId = session?.user?.id;
  if (!token || !userId) return null;

  const w = loadWatermark();
  // 在收集本機變更「之前」就記下時間：同步跑到一半評的分，時間戳一定大於
  // 這個值，下一輪才不會被跳過（見下面 pushedAt 的說明）。
  const startedAt = Date.now();

  try {
    // 1) 拉遠端變動並合併進本機
    const rows = await pullRows(token, w.pulledAt);
    const history = loadGradeHistory();
    const { progress, history: mergedHistory } = mergeRemoteRows(rows, state.progress, history.cards);

    const changedKeys = Object.keys(progress);
    if (changedKeys.length) {
      for (const k of changedKeys) state.progress[k] = progress[k];
      saveState();
    }
    writeMergedHistory(mergedHistory);

    // watermark 取「這批列裡最大的 row_updated_at」，不是取 now()——
    // 用本機時鐘當基準的話，裝置時間偏差會直接變成漏資料。
    let pulledAt = w.pulledAt;
    for (const r of rows) {
      if (r.row_updated_at && (!pulledAt || r.row_updated_at > pulledAt)) pulledAt = r.row_updated_at;
    }

    // 2) 推本機變動。剛剛從遠端合併進來的那幾張不用再推回去（server 上本來
    //    就有），推回去只是白費頻寬。
    const pulledBack = new Set(changedKeys);
    const outgoing = collectLocalChanges(state.progress, loadGradeHistory().cards, w.pushedAt)
      .filter(r => !pulledBack.has(r.card_key));
    if (outgoing.length) await pushRows(token, outgoing, userId);

    /* pushedAt 用「同步開始的本機時間」，不是「這批推上去的最大時間戳」。
       原因：另一台裝置的時鐘可能比較快，拉回來的紀錄會帶未來的時間戳；
       如果拿它當 watermark，本機在那之後評的分（時間戳比較小）就會永遠
       被跳過＝評分遺失。退 1 秒當安全邊際——寧可重推幾筆（DB 的 LWW
       trigger 會判定沒變動、無害），也不要漏掉任何一次評分。 */
    const pushedAt = Math.max(w.pushedAt, startedAt - 1000);

    const at = Date.now();
    lastSyncAt = at;
    saveWatermark({ pulledAt, pushedAt, at });
    return { pulled: changedKeys.length, pushed: outgoing.length };
  } catch (e) {
    // 同步失敗不影響複習；watermark 不動，下次會重試同一段。
    console.warn('雲端同步失敗（不影響本機複習）：', e.message);
    return null;
  }
}

/* 節流版，給 app.js 的 15 秒 ticker 呼叫。 */
export function syncThrottled() {
  if (Date.now() - lastSyncAt < THROTTLE_MS) return;
  lastSyncAt = Date.now();   // 先卡住，避免慢請求期間被重複觸發
  void syncNow();
}

/* 評分後的即時同步（去抖動）。
   為什麼需要這支：只靠「切背景」跟「每 2 分鐘節流」不夠——評完分就把 App
   關掉的話，切背景那次的 fetch 會被瀏覽器連同分頁一起砍掉，那批評分就留在
   本機上不去（2026-08-22 實測踩到）。連續評卡時每張都同步太吵，所以去抖動
   ：停手 SETTLE_MS 才送，中途再評分就重新計時。 */
const SETTLE_MS = 4000;
let settleTimer = null;

export function syncSoon() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { void syncNow(); }, SETTLE_MS);
}

/* 關頁/切背景時的保險：只補送「還沒推上去的」那幾筆，不做拉取——關頁當下
   也沒機會處理回應。

   用 fetch + keepalive 而不是 sendBeacon：sendBeacon 不能自訂 header，只能
   把 token 塞進 query string，那會讓 token 留在各層存取紀錄裡，不能這樣做。
   keepalive 一樣能在分頁關閉後把請求送完，而且 header 照常帶。
   代價是 keepalive 有 64KB payload 上限，所以這裡只送最多 MAX_FLUSH 筆；
   沒送完的下次開 App 會補推（watermark 沒動）。 */
const MAX_FLUSH = 60;

export function flushOnHide() {
  const session = readStoredSession();
  if (!session?.access_token || !session?.user?.id) return false;

  const w = loadWatermark();
  const rows = collectLocalChanges(state.progress, loadGradeHistory().cards, w.pushedAt);
  if (!rows.length) return false;

  const payload = rows.slice(0, MAX_FLUSH).map(r => ({ ...r, user_id: session.user.id }));
  try {
    void fetch(REST, {
      method: 'POST',
      headers: { ...headers(session.access_token), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    return false;
  }
  // 刻意不更新 watermark：這批有沒有真的送達無從得知，留給下次同步用 LWW
  // 重推一次（DB 端會判定沒變動，無害），比誤以為送出去了安全。
  return true;
}
