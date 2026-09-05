# Runtime practice ledger — 上線前的狀態與步驟

分支 `codex/hybrid-mastery-release`。這份記到 U7「不碰 production」的部分為止；
真正的部署還沒做，最後一段是給執行的人照著走的。

## 目前狀態

U1–U7 的本機部分都完成了。**production 還沒動過**，線上跑的仍是舊版。

| 單元 | 內容 | 狀態 |
|---|---|---|
| U1 | runtime 分類器／operation token | 已有（Codex） |
| U2 | add-only runtime baseline（IDB 維持 v2，見「回滾」） | 完成 |
| U3 | daily-card claim、daily／history／resweep 投影 | 完成 |
| U4 | legacy + ledger 共用 materializer | 完成 |
| U5 | 開機鏡射、catalog fence、重置、v1 匯入 | 邏輯完成，cloud-sync 接線見下 |
| U6 | ledger-first 評分 controller、Today 接線、失敗 UI | 完成（`__ALL__` 未接） |
| U7 | SW／release gate／read-back | 本機部分完成，部署未執行 |
| — | lineage 認領規則放寬（見下） | 完成 |
| — | 獨立審查找到的 4 個 P0 | 已修，各自有反證 |

### 兩輪獨立審查找到的 4 個 P0（都已修）

四條的爆炸半徑都隨 lineage 放寬從 94 張變 12324 張，所以先放寬再修。

| # | 缺陷 | 改在哪 |
|---|---|---|
| 1 | 開機 hydration 用 IDB 舊值無條件蓋掉本機，排程回捲後還會推上雲端 | `src/state.js` `mergeWorkspaceHydration` 逐卡比 `progressStamp` |
| 2 | 手動重置守在 ledger runtime 的 port 上，runtime 沒起來就靜默跳過 | `src/app.js` 改用不依賴 runtime 狀態的 `practiceResetPort`，清不掉就中止 |
| 3 | 別台裝置按的重置完全沒碰本機 IDB（手機重置、筆電每評一張還原一張） | `src/cloud-sync.js` 加 `setRemoteResetHook`，先 IDB 再本機鏡射，不吞例外 |
| 4 | `retry()` 重拍 operation 再跟自己比，把 A 卡的排程寫進 B 卡 | `src/practice-grade-controller.js` 改用送出當下那張 operation；補上滑動與 click 的 saving 鎖 |
| 5 | IDB 版本 2→3 讓回滾後 App 開不起來 | 見下面「回滾」 |

## lineage 認領規則放寬（2026-09-04）

原本 12968 個 legacy alias 只認得出 **94** 個（0.7%），帳本形同空轉。原因不是規則太嚴，
是內容指紋含 `karaoke`：2026-08-18 那次部署把整份 catalog 的 karaoke 改制
（`sawatdee kha` → `saˇ watˇ dhī kaˋ`），於是 08-18 之前的 14 份 snapshot 對每一張卡
的指紋都對不上，被當成「認領失敗」。

改法是把「沒有證據」跟「證據互相矛盾」分開：某份 revision 沒有這張卡、或指紋對不上，
只代表那份認不出來，跳過；只有那份明確指出這個 alias 是**另一張**卡（`lineage_changed`／
`duplicate_stable_card_id`／`invalid_lineage_identity`／collision）才 fail closed。

- 認領 **94 → 12324**（12968 個 alias 的 95.0%）
- 剩下 644 筆全是真碰撞：618 筆是 Sheet 裡同一課有重複泰文（legacy 本來就共用一筆進度），
  26 筆歷史碰撞
- 走 runtime 真實路徑（`planRuntimeSrsBaseline`）驗過，12324 筆 seed 裡 **0 筆**的
  cardId 不等於「該 alias 在現行 catalog 唯一的 card_id」
- seedable 94 → 12324，quarantine 750（618 current collision + 26 historical +
  106 是 Gate B 之後新加的卡）

**這條規則實際擔保什麼（兩輪獨立審查都指出原本的說法是空的，這裡更正）**：

20 份歷史 catalog 的 246,718 筆卡片列裡，帶 `card_id` 的是 **0 筆**——`card_id` 是
2026-08-24 Gate B backfill 之後才有的欄位。所以「證據矛盾」那三個 fail-closed 理由
（`lineage_changed`／`duplicate_stable_card_id`／`invalid_lineage_identity`）在現有
資料上一次都觸發不了。原本寫的「跨 79 個 revision 沒有任何 alias 指到過第二個
card_id」是真的，但它為真只是因為歷史語料裡一個 card_id 觀測值都沒有，**證明不了
身分穩定性**。

真正擋住「把進度接到錯的卡」的是：alias 在現行 catalog 解析到恰好一張卡時，沒有
第二張卡可以認錯。這套機制只能拒絕，不能改指向；644 筆未認領正好就是有第二個候選的
那些。歷史 snapshot 剩下的作用是內容穩定性（這個 alias 至少在一份部署裡以相同內容
出現過，中位數 26 份）。

要不要在這個前提下把 12324 張卡交給帳本，是產品決定，不是技術結論。

evidence schema、reason 詞彙、runtime validator 都沒動，所以 `src/storage-scope.js`
一行都沒改；只換 `data/card-id-lineage.json` 與 `src/production-lineage-trust.js`。

**規模副作用（已實測）**：第一次開機要 seed 的列數從 94 變 12324，而 seeding 是每列兩個
sequential await 包在同一個 IDB 交易裡。Chromium 桌機實測 **首次 1470ms、之後每次
28ms**，交易撐得住、列數正確（`tests/browser/practice-db-browser.mjs` 的 scale 探針）。
手機會更慢，但只有換 catalog 後的第一次。

### 重新產生 lineage（離線，不打 Cloudflare API）

```bash
node scripts/build-card-id-lineage.mjs \
  --offline-deployment-manifest data/production-deployments.json \
  --gate-manifest <Gate B manifest 路徑> \
  --lineage-output data/card-id-lineage.json \
  --trust-output src/production-lineage-trust.js \
  --generated-at "$(TZ=Asia/Taipei date '+%Y-%m-%dT%H:%M:%S%z')"
```

離線模式用 manifest 記的 `matchingCatalogCommit` 從 git 重建每一份歷史 catalog，逐份比對
`catalogSha256`，對不上就中止。要**納入新的 production 部署**仍然得走原本的線上模式。

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
   `thai-review-practice-v2` 應該多一筆 `practice_events`、一筆 `formal_due_claims`
   （daily-card claim 的實體 store 就是它）。
3. **連點**：同一顆按鈕連點三次，`practice_events` 只能多一筆。
4. **離線**：關網路重開，App 要照常開得起來（SHELL 完整）。
5. **既有進度**：用真的有 legacy progress 的裝置開一次，確認 `srs_v2` 有 seed 到、
   或 quarantine 的原因合理（`current_catalog_collision` 之類是正常的）。

## 回滾

**bundle 回滾是安全的，IndexedDB 不會擋。**

`PRACTICE_DB_NAME` 與 `PRACTICE_DB_VERSION` 都跟線上一模一樣：`thai-review-practice-v2`、
version **2**。新版需要的 13 個實體 store，線上那份早就全部建好了（機械比對過，集合
完全一致），所以部署時不會觸發 `onupgradeneeded`，回滾時舊版 `indexedDB.open(name, 2)`
也照樣開得起來。

> 線上跑的是**哪一版**：2026-09-01 Codex 直接部署的 `codex/hybrid-mastery-release`
> 的 `0726965`（Cloudflare deployment `023a3bb9`、`sw_cache=thai-review-v93`，見
> `000_Agent/memory/codex_to_claude_handoff.md` 那則）。**不是** `codex/hybrid-mastery-design`，
> 也不是 `data/production-deployments.json` 裡最後那筆——那份 manifest 是 08-24 產的，
> 停在 08-23，已經過期。上面的比對是拿 `0726965` 做的。

> 這件事一度是壞的。原本 `daily_card_claims` 是新開的 store，逼著把版本升到 3；一旦升上去，
> 開過新版之後回滾，舊版會拿到 `VersionError` → `storage-unavailable`，**App 完全開不起來**，
> 而且只能進 DevTools 砍掉 IndexedDB 才救得回來。真瀏覽器實測過：停在 v2 舊版開得起來，
> 升到 v3 舊版就是 `VersionError`。現在 daily-card claim 借用 v2 就存在的
> `formal_due_claims`（keyPath 三個欄位一模一樣，只是順序不同，而且那個 store 從來沒有
> 任何 reader、線上也是空的——`0726965` 裡沒有任何檔案 import `practice-commit.js`）。

鏡射把帳本的數字加進 `day` 的 top-level 欄位（`reviewed`／四檔／`practice`），
`day.ledger` 只留「帳本貢獻了多少」給下次算差額用。所以回滾之後，只讀 top-level 的舊版
仍然看得到那些日子有複習，不會把它們判成缺口去燒安神保護。

殘留限制：**practice-only 的日子回滾後仍會被判成沒來過**。舊版的 `cameOnDay()` 只看
`reviewed`／`games`／`bridged`，沒有任何欄位能表達「只掃過沒正式複習」。這種日子在
回滾後會消耗一個安神保護。要完全避免的話得等 practice 有 v1 欄位。

## 已知還沒做的

- U5c 的 cloud-sync 接線（上面第 2 點）
- `__ALL__` 的 ledger 路徑（上面第 3 點）
- practice outbox 沒有上傳路徑——本輪範圍就不含新的 Supabase schema
- Gate B manifest 停在 2026-08-24，之後 `data.json` 又多了 106 張卡，那些 alias 認領不到
  （quarantine 成 `missing_historical_evidence`）。要涵蓋就得重跑一次 Gate B。
- v1 `thai_days` 沒有 `practice` 欄位，所以 practice-only 的出席只保證本機連續性，
  不宣稱跨裝置同步
