# Runtime practice ledger — 上線前的狀態與步驟

分支 `codex/hybrid-mastery-release`。這份記到 U7「不碰 production」的部分為止；
真正的部署還沒做，最後一段是給執行的人照著走的。

## 目前狀態

U1–U7 的本機部分都完成了。**production 還沒動過**，線上跑的仍是舊版。

| 單元 | 內容 | 狀態 |
|---|---|---|
| U1 | runtime 分類器／operation token | 已有（Codex） |
| U2 | IDB v3、add-only runtime baseline | 完成 |
| U3 | daily-card claim、daily／history／resweep 投影 | 完成 |
| U4 | legacy + ledger 共用 materializer | 完成 |
| U5 | 開機鏡射、catalog fence、重置、v1 匯入 | 邏輯完成，cloud-sync 接線見下 |
| U6 | ledger-first 評分 controller、Today 接線、失敗 UI | 完成（`__ALL__` 未接） |
| U7 | SW／release gate／read-back | 本機部分完成，部署未執行 |

## 三個要知道的偏離

計畫書對應段落都有 `Deviation` 註記。

1. **R11 重置只清 `runtime-context`，保留 `seededAliases`。** 那份紀錄是「重置掉的
   進度不准被 legacy progress 救回來」的唯一依據，清掉等於重置無效。Nalin 已確認。
2. **U5c 的 cloud-sync／app.js 接線移到 U6 之後。** `planLegacyV1Import`／
   `commitLegacyV1Import` 都寫好也測過了，但還沒有 caller——在 ledger 真的開始寫入
   之前，把 practice port 注進 production 同步流程是純風險。**這條還沒做。**
3. **`__ALL__` 沒接 ledger，維持 legacy。** `classifyPracticeLane` 對 `__ALL__` 要求
   權威 SRS，那份資料在 IDB 要 async 讀，而 controller 的 `readContext()` 是同步的。
   接之前要先決定 context 讀取要不要非同步化。

## 使用者會感覺到的改變

- **Today 的評分改走帳本**：交易先寫進 IndexedDB，成功才前進。失敗會顯示說明與
  「再試一次」，不會靜默吞掉。
- **Sweep（重新複習掃描）不再重排程**。掃到的卡評完不改變到期時間，改由掃描游標
  往前走。這是 R5 定的 lane 語意，不是 bug，但體感上跟以前不一樣。
- 單堂課、收藏、搜尋完全沒變。

## 部署步驟（還沒做）

前置：`docs/plans/2026-09-02-1157-...-plan.md` 的 Verification Contract 全過。

```bash
cd /Users/lth/Downloads/thai-review-worktrees/ledger-runtime

# 1. 本機 gate（deploy 腳本自己也會跑一次）
TZ=Asia/Taipei node --test tests/*.test.mjs
TZ=Asia/Taipei python3 -m unittest discover -s tests -p '*_test.py'
git diff --check

# 2. served-origin fixture。每次改完 code 要換 port，否則瀏覽器餵你上一版的
#    src/ 模組（?v= 只擋進入點，整個 import graph 沒有 cache busting）
python3 -m http.server 8951 --bind 127.0.0.1
#    開 http://127.0.0.1:8951/tests/browser/practice-db.html，等 status: passed

# 3. dry-run。有付費缺口就會停下來不打 API
bash scripts/update-audio-deploy.sh

# 4. 真的部署（會動到 production，執行前先問 Nalin）
bash scripts/update-audio-deploy.sh --deploy
```

`--deploy` 會自己做 read-back：把 `RUNTIME_READBACK_ASSETS` 裡的每個檔案的 SHA
跟部署後 URL 抓回來的比對，包含 `data/card-id-lineage.json` 與全部 ledger runtime
模組。不一致就報錯。

## 部署後要人工確認的（自動化擋不到）

per-deployment URL（`<hash>.thai-review.pages.dev`）不在 Cloudflare Access 後面，
可以直接開。

1. **fresh page**：DevTools → Application → Service Workers 確認 cache 是
   `thai-review-v98`；Network 確認 `src/practice-grade-session.js` 拿到的是
   `text/javascript` 不是 `text/html`。
2. **Today Due**：評一張，畫面正常前進；Application → IndexedDB →
   `thai-review-practice-v2` 應該多一筆 `practice_events`、一筆 `daily_card_claims`。
3. **連點**：同一顆按鈕連點三次，`practice_events` 只能多一筆。
4. **離線**：關網路重開，App 要照常開得起來（SHELL 完整）。
5. **既有進度**：用真的有 legacy progress 的裝置開一次，確認 `srs_v2` 有 seed 到、
   或 quarantine 的原因合理（`current_catalog_collision` 之類是正常的）。

## 已知還沒做的

- U5c 的 cloud-sync 接線（上面第 2 點）
- `__ALL__` 的 ledger 路徑（上面第 3 點）
- practice outbox 沒有上傳路徑——本輪範圍就不含新的 Supabase schema
- v1 `thai_days` 沒有 `practice` 欄位，所以 practice-only 的出席只保證本機連續性，
  不宣稱跨裝置同步
