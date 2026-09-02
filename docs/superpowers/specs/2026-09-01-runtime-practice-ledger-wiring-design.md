# Thai Review runtime 評分接入 IndexedDB 帳本設計

日期：2026-09-01（Asia/Taipei）  
狀態：Nalin 已於 2026-09-01 書面批准，進入 implementation
權威分支：`codex/hybrid-mastery-release`（設計起點 `585481a`）

## 1. 目標

把現行字卡評分接進既有 IndexedDB practice ledger，讓被納入範圍的作答先耐久保存，成功後畫面才前進。這一輪只補 U4 runtime write path，不提前實作完整 U6 四軌 engine、U7 新 practice UI 或 U5 雲端事件同步。

使用者已拍板的產品語意：

1. 「今日複習」裡真正到期的卡算 `due`；尚未到期的重新掃描卡算 `sweep`；既有弱項補位卡算 `weak`。
2. 「全部卡片」裡，真正到期的卡算 `due`；其他作答只算 `sweep` 練習，不推進正式 SRS。
3. 同一天同一張卡第二次作答算 retry，不再次增加正式複習統計，也不再次推進 SRS。

## 2. 範圍與既有規格的關係

本設計只讓 `currentLessonId === '__TODAY__'` 與 `currentLessonId === '__ALL__'` 的評分進 ledger。一般單堂課、收藏、搜尋、正反面自由瀏覽維持舊路徑，避免在 U6/U7 尚未完成前擴大行為改動。

這是對既有 U7 Approach 8 的窄幅使用者決策覆寫：一般 card/reverse 仍不進 practice events，但 `__TODAY__` 與 `__ALL__` 是明確例外。U4 的「transaction complete 前 UI 不前進」與「非 Due 不碰 SRS」仍完整適用。

不在本輪：

- 不新增四軌首頁或 retry 插回 3／4–6 張後的完整回合 UI。
- 不把 practice outbox 接上 Supabase；本輪 ledger 是本機 authoritative。
- 不 merge `main`，不改 production schema，不重跑 lineage 產生器。
- 不拆分 `app.js`／`storage-scope.js` 的既有大型模組。

## 3. 技術方案比較

### A. 先寫舊 localStorage，再 best-effort 寫帳本

改動最少，但帳本失敗時畫面已經前進，會重現「看起來完成、其實沒保存」；不符合 U4，淘汰。

### B. Ledger-first，再更新相容投影（採用）

先在 IndexedDB transaction 保存 claim、event、SRS v2（只有正式 Due first）、每日 ledger projection 與 outbox。成功後才把 authoritative SRS／每日 projection 鏡像到舊 localStorage，再更新 grade history、成就與舊 cloud-sync 投影，最後移除隊列卡並前進。Ledger 是真相；localStorage 鏡像失敗不能回滾已完成 transaction，但 reload 必須能從 IndexedDB 精準修復，不能冒充投影也成功。

### C. Shadow ledger，不改既有 SRS 寫入順序

能蒐集事件，但 ledger 與 `state.progress` 會各算一次 SRS，時間與版本可能分叉；未來無法可靠重建，淘汰。

## 4. Runtime cutover baseline

現有使用者的長期 SRS 多數仍只存在 scoped localStorage `state.progress`。若直接讓 `commitPracticeAttempt()` 在空的 `srsV2` 上計算，第一次 Due 會把舊卡當新卡，重設 reps、interval 與 ease factor。因此 runtime ledger 啟用前必須先做一次 add-only baseline：

1. 用完整 catalog 與既有 trusted production lineage evidence 共同建立 runtime `lessonId:sourceThai` → stable `card_id` 對照。只看目前 catalog 唯一並不足夠：若歷史 production snapshot 曾出現 alias collision，仍必須沿用既有 resolved／quarantined 判定，不能把舊 collision 重新物化成可寫 baseline。
2. 只接受能唯一對應一張卡、且通過既有 SRS snapshot validator 的 progress entry。
3. 在同一 workspace transaction 把尚無 `srsV2` row 的 entry 寫成 version 0 baseline；已存在的 IndexedDB row 永遠勝出，不覆蓋、不降版。
4. runtime key 缺失、同 lesson 同 Thai 碰撞、stable ID 重複或 SRS shape 無效時，不猜 card identity；留下 diagnostics／quarantine，該卡暫不啟用 ledger grade。
5. Baseline 可重跑且冪等；成功後第一筆 Due first 以 baseline state 呼叫 `nextReview()`，產生 version 1，保留原本 interval／ease／reps 的延續性。

這個 cutover 要在 boot hydration 後、畫面可評分前完成。transaction 失敗時維持 fail closed，不允許 UI 退回「先寫 localStorage、稍後再補帳本」。一般瀏覽仍可用，但 ledger-eligible 評分入口顯示儲存不可用。

## 5. 分類與每日唯一性

新增純函式 runtime adapter（建議 `src/practice-runtime.js`），只負責把目前 UI context 轉成 ledger attempt，不碰 DOM、storage 或 network。

### Today queue

`buildDailyQueue()` 除了 `cards`、`resweepKeys`，再回傳每張卡在組隊當下的 `laneByCardKey`：

- due pool → `due`
- resweep pool → `sweep`
- weak pool → `weak`
- 同時是 Due 與 resweep cursor evidence 時，event lane 由 `due` 勝出；`resweepKeys` 仍獨立保留，commit 成功後照常推進 resweep cursor。

`setDailyQueue()` 在記憶體保存 lane map；與既有 queue 一樣不寫 localStorage，reload 後重新組隊。

### All cards

第一次作答時，以目前 authoritative SRS 判斷：`nextReviewAt <= now` 或未排程的 legacy due state 才是 `due`，其他一律 `sweep`。不以使用者按了哪個 grade 反推 lane。

### 同日重複作答

lane 只由該卡當天第一筆已保存 event 決定，後續即使從別的入口作答，也沿用同一 `attemptId`、lane、round 與 cycle：

- 無既有 event → `first`
- 已有 `first` → `retry-1`
- 已有 `retry-1` → `retry-2`
- 已有 `retry-2` → `retry-limit`；不再寫 event、SRS 或統計，顯示低干擾提示後前進。

為了讓兩個 tab、Today 與 All cards 的跨 lane race 仍符合「同日同卡只有一個 first」，IndexedDB 新增 `dailyCardClaims`，唯一 key 為 `[workspaceId, dayKey, cardId]`，保存第一筆 event 的 `attemptId`、lane、roundId、cycleId。既有 `formalDueClaims`／`dailyLaneClaims` 保留做原語意與相容驗證；三者在同一 transaction 取得。

若兩個 tab 同時送 first，只有取得 `dailyCardClaims` 的 transaction 能建立 first；另一個 caller 讀回既有 claim，改以相同 attempt 的下一個 retry phase 重送。不得降級成無紀錄前進。

## 6. ID 與作答結果

- ID 使用 `crypto.randomUUID()`，不可用 runtime `cardKey` 或可碰撞短 hash 偽造 UUID。
- 每個 workspace 建立一個 compatibility cycle（`cycleOrdinal = 1`），保存於既有 scoped cycle key，直到 U6/U7 正式 cycle 接管。
- 每次 Today 開始複習、或 All cards 第一次作答時建立一個 round ID；同一頁面、同一入口持續沿用。retry 一律沿用 first event 的 round/cycle。
- grade → result：`again → failure`、`hard → partial`、`good/easy → success`。
- 只有 `lane=due && phase=first` 帶 `formalGrade` 並產生 SRS v2 after-state；其他 lane／phase 的 `formalGrade` 必須為 `null`。
- Formal Due 使用 `getOrCreateWorkspaceInstallationId()` 取得 per-workspace installation ID，不得退回裝置全域 ID。

## 7. 寫入與畫面流程

1. 點擊或鍵盤送出 grade，立刻鎖住同張卡的四個評分入口並標記 saving。
2. 取得當前 card snapshot、stable `card_id`、workspace、day、lane、phase 與 attempt context。
3. 呼叫 `commitPracticeAttempt()`；workspace boot 變更、IndexedDB blocked/quota/versionchange 或 transaction abort 都視為失敗。
4. 只有 `status=committed` 或 payload 完全一致的 `already-committed` 才套 projection：
   - Due first：直接採用 transaction 回傳的 SRS state，不再呼叫 `nextReview()` 算第二次；把 transaction 回傳的每日 ledger projection 精準鏡像到 daily log，再以 `eventId` 冪等寫 grade history、更新 achievements 與既有 v1 cloud-sync mirror。ledger 路徑不再呼叫會直接累加的舊 `logReview()`。
   - Sweep／Weak／retry：不改 `state.progress`、不寫 grade history、不增加 reviewed／accuracy；每日 ledger projection 只記 practice attendance。
5. Projection 完成後才移除 Today queue card、推進 resweep cursor、翻回正面並前進。Resweep cursor 保存最後套用的 `eventId`；同一 event 重播只補未完成的 cursor 更新，不可推進兩次。
6. Ledger transaction 失敗：解除 saving、留在原卡、同一 attempt 可重試；不得呼叫 `setGrade()`、`logReview()`、移除 queue 或排 cloud sync。
7. Ledger 已成功但相容投影失敗：不重送 transaction，也不倒退 ledger；留可見診斷。當下以同一 attempt 讀回 `already-committed` 即可重套 authoritative snapshot，reload 則由 boot reconciliation 修復。這個狀態不能顯示「全部完成」。

`gradeAndAdvance()` 改為 async。點擊與鍵盤共用同一 pending guard，連點只送一次。登出、workspace switch 或 versionchange 會讓 transaction port 的 `assertActive` 失敗，舊 caller 不得寫入新 workspace。

## 8. Daily attendance 與相容投影

若 event transaction 成功、localStorage 累加前 crash，只靠 `already-committed` 不再累加會永久少算；若每次 read-back 都補加，則會重複灌水。因此每日統計必須先在 IndexedDB transaction 內形成 authoritative projection，再把完整 snapshot 鏡像出去：

1. 使用既有 `projections` store，每天保存一個 ledger-owned row（例如 `practice-daily-v1:2026-09-01`）。新 event 與這列 projection 在同一 transaction 更新；`already-committed` 只讀回，不再增加。
2. Projection 只保存 ledger 貢獻：Due first 增加 `reviewed` 與對應 grade；Sweep／Weak／retry 增加 `practice`。任何其他 phase 都不改數字。
3. 舊 daily row 的 top-level counters 視為 cutover 前或非 ledger 路徑的 legacy contribution；新增 `ledger` 子物件保存 IndexedDB snapshot。所有 streak、reviewed、accuracy、achievement selector 都經過共同 helper 讀取 `legacy + ledger`，不能由各畫面自行相加。
4. `streakDays()` 把合併後的 `practice > 0` 視為「今天有來」；`totalReviewed`、`maxDailyReviewed`、accuracy 與 SRS 成就仍只讀合併後的正式 reviewed。
5. Boot hydration 逐日覆寫 localStorage 的 `ledger` 子物件；舊 row 沒有 `ledger` 或 `practice` 時視為 0，不做破壞式 migration。投影後 crash、重新套用 `already-committed`、多 tab read-back 都得到同一 snapshot。
6. Grade history entry 帶 `eventId`（舊 entry 沒有時仍可讀）；同一 event 重播不重複 append。這保留既有 improvement UI，也能補回 transaction 後、history 寫入前的 crash。

這個切法讓舊資料原封不動，新帳本資料可精準重建；正式統計與 attendance 都不靠「猜上次加到哪裡」。

## 9. 元件與檔案邊界

預計新增／修改：

- 新增 `src/practice-runtime.js`：context/lane/result/phase 的純轉換與 runtime round/cycle adapter。
- 修改 `src/practice-db.js`：additive schema upgrade、runtime SRS baseline、`dailyCardClaims`、每日 ledger projection 與查詢既有 card/day attempt context；claim eligibility 的資料量檢查同步納入新 store。
- 修改 `src/practice-commit.js`：first 取得 daily-card claim；同 transaction 更新每日 ledger projection；collision 回傳可供 caller 接續 retry 的既有 context 與 projection snapshot。
- 修改 `src/state.js`：Today lane map、直接套 authoritative SRS、合併 legacy／ledger daily stats 與 event-aware grade history 的 helper；不讓 UI 再算一次 after-state。
- 修改 `src/today.js`：回傳 lane map；不直接累加 ledger attendance。
- 修改 `src/app.js`：boot-bound transaction port、ledger-first async grading、saving/error/pending guard。
- 視現有 render 邊界最小修改 `src/card.js`／`src/ui.js`，讓 saving 與 save-failed 可辨識且可鍵盤操作。
- 對應新增／修改 Node 與 served-origin browser tests；`sw.js` 只有新增 runtime module 時才補 SHELL 並升 cache version。

不建立第二套 SRS 計算器；`nextReview()` 只由 `commitPracticeAttempt()` 呼叫。

## 10. 驗收條件

### 行為

- Today Due first transaction 成功後，event、daily-card claim、formal-due claim、SRS v2、每日 ledger projection、outbox 同時存在，畫面才前進。
- 既有 localStorage SRS 先以 version 0 baseline 無損 seed；第一筆 Due 延續舊 reps／interval／ease，不當成新卡。
- 已存在的 IndexedDB SRS 永遠勝過 localStorage baseline；runtime key 碰撞或缺少 trusted lineage 證據時不猜 stable ID，也不產生半套 seed。
- Today Sweep／Weak 與 All 非 Due 只寫 event／outbox／attendance，不改 SRS、reviewed 或 accuracy。
- All cards 的到期卡仍走 Due first，與 Today Due 使用同一 daily-card uniqueness。
- 同日同卡第二、第三次分別是 retry-1／retry-2；第四次不灌 event 或統計。
- 兩 tab 同時從不同入口評同卡，只能有一筆 first；另一筆成為 retry 或明確留在原卡等待重試。
- Commit abort、quota、blocked、versionchange、workspace switch 時，沒有半套 event／SRS／outbox，也沒有 UI 假前進。
- Commit 後、localStorage 鏡像前模擬 crash，reload 由 IndexedDB hydration 看到相同 SRS version 與每日 projection，不二次延長 interval，也不遺失或重複 daily counters。
- 一般單堂課、收藏、搜尋的既有評分行為不因本輪改變。

### 驗證

- 新增分類器、daily-card claim、retry phase、ledger daily projection、legacy＋ledger selector、grade-history event idempotence、resweep cursor idempotence、saving guard 的 Node tests。
- 更新 `tests/browser/practice-db-browser.mjs`，實測 schema upgrade、兩 tab race、abort、reload read-back。
- 真 App 本機用 Today Due、Today Sweep、All Due、All 非 Due 各走一次；評分後 reload 檢查。
- `TZ=Asia/Taipei node --test tests/*.test.mjs`、Python unittest、`git diff --check` 全過。
- Fresh-context code review 無未處理 P0/P1；push 後用 direct Cloudflare Pages deploy，回讀 deploy-info、SW、data、lineage 與 manifest hashes。

## 11. 發布與回復邊界

- 實作 commit 只進 `codex/hybrid-mastery-release`；不自行 merge `main`。
- 部署前沿用既有 baked audio，若 dry-run 出現付費缺口就停下揭露成本，不能自動呼叫付費 API。
- 新路徑若在部署前驗收失敗，保留現行 runtime path，不做半套 ledger cutover。
- 一旦 production 接受 practice events，不刪資料或降版 IndexedDB；後續只 roll forward。
