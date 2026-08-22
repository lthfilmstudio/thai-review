/* Supabase Google 登入（跨裝置同步用）。

   為什麼只包 auth 不包整個 supabase-js：見 src/vendor/supabase-auth.js 檔頭。
   PostgREST 那幾支請求在 src/cloud-sync.js 裡用 fetch 手寫。

   SUPABASE_KEY 是 publishable key，設計上就是公開的（會跟著前端一起出貨），
   真正的防護是資料表的 RLS：沒有登入後拿到的 user JWT，這把 key 什麼資料
   都讀不到。用新式 sb_publishable_ 而不是舊的 anon JWT，是因為它可以獨立
   輪替，將來要換掉不會影響共用同一個 Supabase 專案的 Roughcut。 */

export const SUPABASE_URL = 'https://ntxqnvgpvshqwodagupt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable__WK4UaYwJ6vBrPsx6gmL0g_U6D3blA0';

const STORAGE_KEY = 'thai-review-auth-v1';

let clientPromise = null;

/* GoTrueClient 有 100KB，沒登入的人不該為它付解析成本，所以動態載入。
   （檔案本身還是進 sw.js 的 SHELL，離線時也拿得到。） */
async function getClient() {
  if (!clientPromise) {
    clientPromise = import('./vendor/supabase-auth.js').then(({ GoTrueClient }) => new GoTrueClient({
      url: `${SUPABASE_URL}/auth/v1`,
      headers: { apikey: SUPABASE_KEY },
      storageKey: STORAGE_KEY,
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    }));
  }
  return clientPromise;
}

/* 這台裝置以前登入過嗎？用來決定要不要在開機時就把 100KB 的 auth 載進來——
   沒登入過的人完全不會碰到網路，行為跟同步功能上線前一模一樣。 */
export function hasStoredSession() {
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

/* 同步版讀 session：關頁那一刻沒時間 await，只能直接讀 GoTrue 存在
   localStorage 的那份。過期的 token 這裡不處理（也來不及 refresh），
   送出去頂多被打回，下次開 App 會用正常流程補推。
   只給 cloud-sync.js 的 flushOnHide 用，其他情況一律走 getSession()。 */
export function readStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // GoTrue 存的形狀是 { access_token, user, ... } 或包一層 currentSession
    return s?.access_token ? s : (s?.currentSession ?? null);
  } catch {
    return null;
  }
}

/* 目前的 session；沒登入或出錯一律回 null，呼叫端不用 try/catch。 */
export async function getSession() {
  if (!hasStoredSession() && !location.search.includes('code=')) return null;
  try {
    const { data } = await (await getClient()).getSession();
    return data?.session ?? null;
  } catch {
    return null;
  }
}

/* 登入導回來時網址上會帶 ?code=&state=，清掉才不會留在網址列，
   也避免重整時重複觸發交換（做法對齊 Roughcut tracker 的 useAuth）。 */
export async function consumeRedirect() {
  if (!location.search.includes('code=')) return null;
  const session = await getSession();
  try {
    history.replaceState(null, '', location.pathname + location.hash);
  } catch { /* 某些 in-app browser 會擋 replaceState，不影響登入本身 */ }
  return session;
}

export async function login() {
  const client = await getClient();
  // redirectTo 用 origin + pathname（不帶 query），Supabase 那邊的
  // Redirect URLs 白名單要有這個網址，否則登入後轉不回來。
  const { error } = await client.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) console.warn('Google 登入失敗：', error.message);
}

export async function logout() {
  try {
    await (await getClient()).signOut();
  } catch (e) {
    console.warn('登出失敗：', e.message);
  }
}
