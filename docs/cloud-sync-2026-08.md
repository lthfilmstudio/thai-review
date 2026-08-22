# 跨裝置同步（Supabase Google 登入）

**狀態**：Phase A（登入 + 每張卡的評分排程 / 評分歷史）**已實作**。
Phase B（連續天數、安神保護、成就、重新複習游標、收藏、卡片編輯）未做。
**日期**：2026-08-22

## 為什麼要做

thai-review 原本是純單機 App：學習紀錄全在各裝置自己的 `localStorage`。
Nalin 手機、平板、電腦都會拿來複習，結果三台的 SRS 排程各走各的——今天在
手機上評過的字，明天在平板上還是顯示到期，等於重複評分。

（既有的 `/progress` 只同步「今天累積秒數」一個數字給 22:00 推播用，見
`mastery-sprint-plan-2026-08.md`，跟排程資料無關。）

## 架構決策

| 決策 | 原因 |
|---|---|
| 只 vendor `@supabase/auth-js`，不用整個 `supabase-js` | 專案零建置（無 npm / bundler，部署是 rsync）。完整包會塞進 realtime(websocket)、storage、functions 三個用不到的東西，還需要 node buffer/process polyfill。PostgREST 那幾支請求用 fetch 手寫就夠 |
| 認證包**動態 import** | 沒登入的人不該為 100KB 付解析成本。已驗證：登出狀態下零 Supabase 請求、bundle 完全不載入 |
| 用新式 `sb_publishable_` key，不用舊 anon JWT | 可獨立輪替，將來換掉不影響共用同一個 Supabase 專案的 Roughcut。repo 是 public，但 publishable key 設計上就是公開的，真正防護是 RLS |
| **逐列**存（每張卡一列），不是整包 JSON | 13,632 張卡；整包上傳約 2.4MB，手機上不可接受。逐列才能用 `row_updated_at=gt.<watermark>` 增量拉 |
| 衝突解決放在 **DB trigger**，不靠客戶端自律 | 客戶端可以無腦 upsert；離線裝置晚一步上傳也不會蓋掉較新的紀錄 |
| 每日日誌（Phase B）打算做成**每台裝置一列** | 每台只寫自己那列，結構上不可能衝突；讀取時 group by 日期加總。跟現有 `/progress` 秒數同一套語意 |

## 資料表 `public.thai_cards`

主鍵 `(user_id, card_key)`，`card_key` 就是本機的 `"lessonId:thai"`。
RLS：`user_id = auth.uid()`。索引 `(user_id, row_updated_at)` 給增量拉用。

欄位分三組，**各自帶時間戳**，避免「A 裝置評分、B 裝置編輯」互相蓋掉：

- 進度組：`grade, reviewed_at, next_review_at, interval_days, ease_factor,
  reps, device_id` + `progress_updated_at`
- 歷史組：`history` + `history_updated_at`
- 編輯組：`edit` + `edit_updated_at`（欄位已建好，Phase B 才會用）

`interval` 是 Postgres 保留字，所以叫 `interval_days`。

### trigger `thai_cards_merge`（BEFORE UPDATE）

逐組比時間戳，`NEW.*_updated_at > OLD.*_updated_at` 才採用新值，否則整組
還原成舊值；最後一律 `row_updated_at = now()`。

已用真的 SQL 驗過（不是只讀 code）：
- 較舊的進度寫入（1000、1500）被擋掉，`grade` 維持較新的那筆
- 同一筆 upsert 裡「進度較舊 + 編輯較新」→ 進度保留舊的、編輯採用新的
  （**欄位組獨立性成立**）
- 較新的進度寫入正常採用，`row_updated_at` 有更新

## 客戶端

| 檔案 | 職責 |
|---|---|
| `src/vendor/supabase-auth.js` | vendor 的 auth-js v2.112.3（自帶依賴、無對外 import） |
| `src/cloud-auth.js` | 登入 / 登出 / 取 session / 清掉導回時網址上的 PKCE `?code=` |
| `src/cloud-merge.js` | **純函式**合併語意，有 19 個測試 |
| `src/cloud-sync.js` | 拉 → 合併寫回本機 → 推；watermark 存 `thai-review-sync-v1` |

### 合併規則（`cloud-merge.js`，必須跟 DB trigger 一致）

- **進度**：last-write-wins，比 `updatedAt`（舊資料沒有就退回 `reviewedAt`
  再退回 0）。平手保留本機，避免每次同步都判定成有變動
- **評分歷史**：**聯集**不是覆蓋——兩台各評過的都該留下。依時間排序、
  同秒同評分去重、保留最近 5 筆（對齊 `grade-history.js` 的 `MAX_PER_CARD`）

合併必須**可交換又冪等**：不管誰先同步、同一批資料合併幾次，收斂結果一樣。
所以一律用資料自身的時間戳決定勝負，不看「誰後到」。

### watermark 的兩個時鐘

`thai-review-sync-v1` 存 `{ pulledAt, pushedAt, at }`：

- `pulledAt` ＝ 已拉到哪個 `row_updated_at`（**server 時鐘**，ISO 字串）。
  取「這批列裡最大的 `row_updated_at`」，不是取本機 `now()`——用本機時鐘當
  基準的話，裝置時間偏差會直接變成漏資料
- `pushedAt` ＝ 已推到哪個 `updatedAt`（**本機時鐘**，毫秒）

**兩個時鐘刻意分開存、不互相換算。**

#### `pushedAt` 為什麼取「同步開始時間」而不是「推上去的最大時間戳」

如果另一台裝置的時鐘比較快，拉回來的紀錄會帶未來的時間戳。拿它當 watermark
的話，本機在那之後評的分（時間戳比較小）會永遠被跳過＝**評分遺失**。

所以 `pushedAt = max(舊值, 同步開始時間 - 1 秒)`。退 1 秒當安全邊際：寧可
重推幾筆（DB 的 LWW trigger 會判定沒變動、無害），也不要漏掉任何一次評分。
成本是不對稱的。

## 觸發時機

- App 開機、處理完登入導回之後跑一次
- 切到背景（`visibilitychange` → hidden）跑一次——換到另一台裝置才看得到最新進度
- 既有的 15 秒 ticker 裡節流呼叫（最密 2 分鐘一次）
- 設定面板點「已登入的 email」＝手動同步一次（逃生口）

**所有失敗靜默吞掉、不阻塞複習**（紀律對齊 `src/progress-sync.js`）。
沒登入 / 離線 / Supabase 掛掉，行為都跟同步功能上線前一模一樣。

## 前置作業（Dashboard，程式無法代勞）

Supabase 專案 `roughcut-tracker`（ref `ntxqnvgpvshqwodagupt`）的
**Authentication → URL Configuration → Redirect URLs** 要加：

```
https://thai-review.lthfilmstudio.com
```

漏加的話登入後轉不回來（記憶 `roughcut_tracker_supabase_poc.md` 記過這個坑）。
本機開發要測再加 `http://localhost:8934`。

Google provider 本來就已啟用（Roughcut production 在用），不用重開。

## 重置進度：epoch 而不是逐張墓碑

「重置進度」在登入狀態下要擴散到所有裝置。同步模型原本只有「這張卡被評成
什麼」，沒有「這筆紀錄被清掉了」的概念，所以要補刪除語意。

作法是 `thai_meta.reset_at`（毫秒）記一個 **epoch**：**任何
`progress_updated_at <= reset_at` 的紀錄，一律視為已清除**。

為什麼不用逐張卡寫墓碑：
- 漏寫一張就復活一張；epoch 是一個值，不存在漏寫
- **第一次登入的新裝置**也會正確套用（它 watermark 是空的，會把雲端所有列
  拉下來，靠 epoch 過濾才不會把已重置的舊資料收進來）
- 重複套用結果一樣（冪等）
- 當下離線、事後才連上來的裝置也會被涵蓋

三個地方都要用同一個 epoch 過濾，缺一就會漏：
1. `keysClearedByReset()` — 清本機既有的
2. `mergeRemoteRows(..., resetAt)` — 拉下來的不收
3. `collectLocalChanges(..., resetAt)` — 本機舊的不推回去

`thai_meta` 的 trigger 讓 `reset_at` **只能往前走**（`greatest`）：離線裝置
帶著舊值上來，不能把別台已經做過的重置往回倒，否則已清掉的資料會復活。

雲端那幾列也會一併 DELETE，但那只是為了不讓表堆垃圾——正確性由 epoch 保證，
就算刪除失敗也不影響。

執行順序是**先標記雲端、再清本機**：反過來的話中途失敗會變成「本機清了、
雲端沒清」，下次同步又把資料拉回來，使用者會以為重置沒生效。

UI 照 Nalin 定過的破壞性操作防呆（`feedback_destructive_typing_confirm.md`）：
紅框紅標題、執行前揭露會清幾張卡與影響範圍（登入時明講「所有裝置」）、
要完整輸入「重置進度」才解鎖紅色按鈕。

## Phase B 待辦

- `thai_days`（每裝置一列，讀時加總）→ 連續天數、安神保護、月曆熱度
- `thai_meta`（帳號層級單列）→ 重新複習游標取 `GREATEST`、成就取聯集且保留
  較早解鎖時間、收藏用 `{泰文: {v, ts}}` tombstone（不能單純聯集，否則
  「取消收藏」永遠同步不出去）、`protection` 等純量走 LWW 再交給
  `settleStreakOnOpen()` 收斂
- `favorites` 目前用**泰文字串**當 key（不是 `lessonId:thai`），不能塞進
  `thai_cards`，要放 `thai_meta`
- `favorites` / `edits` / `days` 目前都**沒有時間戳**，Phase B 要先補上才能
  做 last-write-wins
