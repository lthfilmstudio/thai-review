# 交接：把正式評分接進 IndexedDB 練習帳本（U4 runtime write path）

寫給下一個接手的人（預期是 Codex）。2026-09-01 21:30 Asia/Taipei，Claude Code 寫。

## 先看這裡：現在的狀態

- 權威分支 `origin/codex/hybrid-mastery-release`，HEAD `125dda5`。**尚未 merge `main`**，不要自行 merge。
- 正式站已部署 `4f37476`（`https://6680c3e7.thai-review.pages.dev`，`sw_cache=thai-review-v95`）。
- `TZ=Asia/Taipei node --test tests/*.test.mjs` = 401/401、python unittest = 134/134。
  **測試一定要帶 `TZ=Asia/Taipei`**，不然每日結算那批綁台北日界線的測資會噴 13 個假紅字。
  `scripts/update-audio-deploy.sh` 的 deploy gate 已經把 TZ 釘進去了。
- 這輪為什麼有兩個 hotfix、以及一份被推翻的舊敘述，見
  `000_Agent/memory/codex_to_claude_handoff.md` 檔頭那兩則（2026-09-01 20:45 與 21:16）。

## 這件事是什麼

`src/practice-db.js` / `src/practice-events.js` / `src/practice-commit.js` 已經蓋好一套
per-workspace 的 IndexedDB 事件帳本（U4），有完整測試。**但它沒有任何 production 呼叫端**：

```
$ grep -rn "commitPracticeAttempt\|createPracticeTransactionPort" src/
src/practice-commit.js:114:export async function commitPracticeAttempt({
src/practice-db.js:242:export function createPracticeTransactionPort(connection, {
```

使用者實際按評分走的是 `src/app.js:219` 的 `gradeAndAdvance()`，它只做 localStorage
投影（`setGrade` / `recordGrade` / `logReview`）然後同步排程，**一筆 event、outbox、
SRS v2 都沒寫**。所以帳本目前支撐不了 replay、耐久同步或重建。

**這不是線上故障**：現行評分與跨裝置同步走的是既有、跑了幾個月的路徑，沒有資料遺失。
這是「新基礎設施蓋好但沒啟用」。不要把它當 P0 硬幹。

## 動工前必須先問 Nalin 的三個問題

`commitPracticeAttempt` 要求每筆 attempt 標明 lane 與 phase：

```js
// src/practice-events.js:9-10
export const PRACTICE_LANES  = Object.freeze(['sweep', 'due', 'weak', 'output']);
export const PRACTICE_PHASES = Object.freeze(['first', 'retry-1', 'retry-2']);
```

而 U6 的四軌佇列 UI **還沒做**，所以目前的畫面動作對應不到 lane。以下三題的答案會直接
決定連續天數、統計與成就的數字，**不要自己挑一個解讀硬做**：

1. **`__TODAY__` 模式裡，由 resweep 掃描游標帶出來的卡（不是到期的）**評分時算 `sweep`
   還是 `due`？（`src/today.js:32` 的 `buildDailyQueue()` 目前把兩種來源混在同一個隊列，
   `state.dailyQueueResweepKeys` 記得住哪些是掃描來源。）
2. **「全部卡片」清單裡隨手翻到一張評分**算哪一軌？還是根本不進帳本？
3. **同一天同一張卡評第二次**算不算正式？帳本已有 `formalDueClaims` / `dailyLaneClaims`
   兩個 store 做每日唯一性，語意要對齊使用者預期。

把這三題連同「會影響什麼數字」一起端給 Nalin 選，不要用工程語言問。

## 拍板後的實作起點

- 連線已經在 boot 建好了：`src/app.js:713` `openPracticeDatabase(...)`，變數
  `practiceConnection`（`src/app.js:703`），logout 與 versionchange 都有 `close()`
  （`:774`、`:1034`）。接線時重用它，不要另開連線。
- `createPracticeTransactionPort(connection, { workspaceId, assertActive })`
  （`src/practice-db.js:242`）——`assertActive` 要綁當次 boot，boot 換掉後舊 port 必須失效。
- `commitPracticeAttempt({ port, workspaceId, attempt, now, createId, deviceId })`
  （`src/practice-commit.js:114`）。注意 `formal Due` 必須帶 per-workspace installation ID
  （不是裝置全域 ID），拿 `getOrCreateWorkspaceInstallationId`（`src/storage-scope.js:662`）。
- `gradeAndAdvance()` 要改成 async，**交易完成前 UI 不得前進**；失敗時留在原卡並顯示
  可重試的狀態（U4 的 fail-closed 契約）。這會牽動鍵盤 `1`~`4`（`src/app.js:1146-1149`）
  與點擊（`:1243`）兩個呼叫端。
- 對照規格：`docs/plans/2026-08-23-1752-feat-hybrid-mastery-practice-plan.md` 的
  **U4 §Approach 3/5 與 §Test scenarios**（10 個必測場景：交易中止、commit 後 crash、
  兩分頁交錯、同日雙重 formal Due、離線分叉、quota/blocked…），以及 U7 的 UI 契約。

## 這輪踩過、你也會踩的坑

1. **測試寫 `foo: undefined` 想測「值不見了」是假的**——JS 顯式傳 `undefined` 會觸發預設
   參數，實際吃到的是預設值。要用 `null` 或壞格式才走得到守衛。
2. **測函式行為 ≠ 測接線**。`precache()` 的單元測試在 install 被改回 `cache.add()` 時
   照樣全綠，因為測的是函式本身。**每個新函式除了行為測試，要另外斷言呼叫端真的有用它。**
   這件事對本次任務特別要緊——整個任務就是「接線」。
3. **`scripts/build-card-id-lineage.mjs` 不要隨便重跑**：它會打 Cloudflare API 列出所有
   production 部署，重跑會納入新部署、改掉 `expectedRevisions` 與 `evidenceId`，
   等於重做整份 lineage 證據，還要同步更新 `src/production-lineage-trust.js` 的
   `evidenceSha256`（有測試釘住兩者一致）。
4. **`data/` 一定要在部署清單裡**（`scripts/update-audio-deploy.sh` 的
   `ensure_preview_shell()`）。漏掉的話 Pages 回 SPA fallback 的 `200 text/html`，
   已登入又有 legacy 資料的人會卡在 `recoverable-failure` 進不了 App。已有測試把
   `sw.js` 的 `SHELL` 跟部署清單對起來。
5. **改 `src/*.js` 或 `sw.js` 要升 `sw.js` 的 `CACHE` 版本**（現在 `thai-review-v95`），
   `tests/service_worker.test.mjs` 有斷言釘住版本字串。
6. **push ≠ 部署**。CF Pages 沒接 Git，正式指令是 `bash scripts/update-audio-deploy.sh --deploy`。
   正式網域在 Cloudflare Access 後面，curl 只拿得到 302，內容要請 Nalin 開瀏覽器確認；
   per-deployment 的 `<hash>.thai-review.pages.dev` 沒有 Access，可以自動化驗。

## 不要動的東西

- `src/production-lineage-trust.js` 的常數（除非同時重跑產生器並更新 artifact）。
- lineage 目前刻意 fail closed；沒有新決策不要改成猜測性放行。
- v2 證據的欄位形狀檢查（`storage-scope.js` 的 `COMPACT_LINEAGE_*`）是防 FNV 碰撞填充
  的，要改先看 `tests/learning_migration.test.mjs` 的 `paddableEvidence()`。
