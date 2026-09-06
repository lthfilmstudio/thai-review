# Runtime practice ledger — 上線前的狀態與步驟

分支 `codex/hybrid-mastery-release`。這份記到 U7「不碰 production」的部分為止；
真正的部署還沒做，最後一段是給執行的人照著走的。

## 目前狀態

**已於 2026-09-06 15:37 部署**：`d4308a2`、deployment `83a0685d`、`sw_cache=thai-review-v98`，
read-back 18 個資產 SHA 全部相符。之後又補了 U5c（見下），**那部分還沒部署**。

部署後在 per-deployment URL 驗過：IndexedDB 是 `thai-review-practice-v2@2`（版本沒動，
回滾安全）、所有 `.js` 的 content-type 正確、lineage evidence 有 12,324 個 resolved alias、
帳本寫入鏈完整（`practice_events` + `formal_due_claims` + daily/history 投影 + outbox）、
連點三次只產生一筆。

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
2. ~~**U5c 的 cloud-sync／app.js 接線移到 U6 之後。**~~ **2026-09-06 已接**，見下面
   「U5c：讓帳本收得回被 legacy 改過的卡」。
3. **`__ALL__` 沒接 ledger，維持 legacy。** `classifyPracticeLane` 對 `__ALL__` 要求
   權威 SRS，那份資料在 IDB 要 async 讀，而 controller 的 `readContext()` 是同步的。
   接之前要先決定 context 讀取要不要非同步化。

## 使用者會感覺到的改變

- **Today 的評分改走帳本**：交易先寫進 IndexedDB，成功才前進。失敗會顯示說明與
  「再試一次」，不會靜默吞掉。
- **Sweep（重新複習掃描）不再重排程**。掃到的卡評完不改變到期時間，改由掃描游標
  往前走。這是 R5 定的 lane 語意，不是 bug，但體感上跟以前不一樣。
- 單堂課、收藏、搜尋完全沒變。

## 部署步驟

前置：`docs/plans/2026-09-02-1157-...-plan.md` 的 Verification Contract 全過。

> ⚠️ 這個 worktree 的 `out/` 是空的（build artifact 沒進 git），直接跑會看到「缺 10189
> 個音檔、估 US$16.88」。那是假警報——把主 checkout 的 `out/site-preview/{audio,
> audio-manifest.json,real-manifest.json,zh-manifest.json}` symlink 過來就會變成
> `missing_audio_files: 0`。`rsync -aL` 會解引用成實體檔，不影響部署內容。

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
#    跑之前先清掉那個 origin 的 IndexedDB：獨立審查遇過一次無法重現的假紅，
#    origin 上有 v2 釘死之前留下的 version 3 化石資料庫

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
   `thai-review-v99`（**要跟線上前一版不同才有意義**——填成當時線上那個版號的話，
   裝置停在舊 bundle 也會「通過」）；Network 確認 `src/practice-grade-session.js`
   拿到的是 `text/javascript` 不是 `text/html`。
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
> 任何 reader、線上也是空的——`0726965` **出貨的 `src/`** 裡沒有任何檔案 import
> `practice-commit.js`（`tests/` 有，但 `update-audio-deploy.sh` 不把 `tests/` 連進部署目錄）。

鏡射把帳本的數字加進 `day` 的 top-level 欄位（`reviewed`／四檔／`practice`），
`day.ledger` 只留「帳本貢獻了多少」給下次算差額用。所以回滾之後，只讀 top-level 的舊版
仍然看得到那些日子有複習，不會把它們判成缺口去燒安神保護。

殘留限制：**practice-only 的日子回滾後仍會被判成沒來過**。舊版的 `cameOnDay()` 只看
`reviewed`／`games`／`bridged`，沒有任何欄位能表達「只掃過沒正式複習」。這種日子在
回滾後會消耗一個安神保護。要完全避免的話得等 practice 有 v1 欄位。

## U5c：讓帳本收得回被 legacy 改過的卡（2026-09-06）

部署後在線上實測發現帳本會隨著使用一路空轉，原因有兩層：

1. **卡片被 baseline seed 進 IDB 的那一輪，評分仍然走 legacy。** `authoritativeSrsRows`
   取自 `bootResult.hydration`，而 hydration 在 `startPracticeLedgerRuntime` 跑 baseline
   之前就讀完了，剛寫進去的列看不到 → 逐卡閘門判定「沒有權威列但本機有進度」。
2. **legacy 評過一次，那張卡就永久離開帳本。** legacy 評完 localStorage 的時間戳比 IDB
   新，而閘門要求「IDB 不比本機舊」；baseline 是 add-only 又會跳過 `seededAliases`，
   沒有任何機制讓 IDB 追上。**單堂課評分一律走 legacy**，所以越用覆蓋率越低。

線上對照（per-deployment URL，同一張卡）：

| | IDB `srs_v2` | localStorage |
|---|---|---|
| 種完當下那輪評 | v0 / interval 30（沒動） | interval 78 |
| 重載一次再評 | v1 / interval 100 | 同步 |

修法兩處，都走既有的 `planLegacyV1Import`／`commitLegacyV1Import`（同一套信任閘門、
同一套單調保護、同一套冪等）：

- **開機採納**（`startPracticeLedgerRuntime`）：baseline 之後重讀權威列並交給評分 session
  用（`app.js` 不再吃 hydration 快照），再把「本機比 IDB 新」的 alias 匯入。沒有待採納的
  就完全不動，也不白抓一次 lineage evidence。
- **cloud-sync 匯入**（U5c 原本的範圍）：`setLegacyImportHook`，遠端比較新的 winner 即時
  寫進權威列，並更新 session 的快取（`adoptAuthoritative`）。**fail-open**——本機合併本身
  已經正確，匯入只是讓帳本跟上，失敗就這輪不收那些卡，開機採納是後備。
  （這點跟 `setRemoteResetHook` 相反，那條是 fail-closed。）

**兩條路的不變式不一樣，別把它們寫成同一條**（第六輪審查抓到這份文件原本就寫錯）：

- **開機採納**：只處理「IDB 有那一列而且比本機舊」。列不存在就不碰——重置會清光
  `srs_v2` 但刻意保留 `seededAliases`，若採納在列不存在時也寫入，等於讓 legacy
  progress 把重置掉的進度救回來（R11）。守衛在 `storage-scope.js` 的
  `pendingLegacyAdoptions`（`!stampByCardId.has(cardId)` 就 continue），有測試釘住。
- **cloud-sync 匯入**：**會**建立不存在的列，而且必須會——baseline 只對「有 legacy
  progress 的 alias」種列（`planRuntimeSrsBaseline` 是從 `progress` 展開的），所以
  「只在別台裝置評過、本機從沒評過」的卡在本機根本沒有那一列，不建就永遠收不進帳本。
  它擋重置資料靠的是別的東西：`mergeRemoteRows` 的 `resetAt` epoch 過濾（winner 一定
  是重置後的資料），加上下面那道圍籬。

**重置圍籬**（`ledgerAuthorityGeneration`）：hook 中間 `await` 了一次最長 10 秒的 lineage
fetch，使用者在那段期間按重置的話，winners 就變成「重置前的排程」。寫回剛清空的 `srs_v2`
之後 `state.progress` 已經是空的，`ledgerCardEligible` 的 `!legacyProgress → true` 會放行，
評分從重置前的 interval 續算，再以新的 `updatedAt` 通過 epoch 過濾推上雲端擴散——**重置
靜默失效**。所以 `resetLedgerAuthorityOrThrow` 在第一個 `await` 之前就同步遞增世代，hook
進來時抓一份、緊貼著寫入前比對一次，中間不准再有 `await`。三個要素各自反證過會紅。

本機真瀏覽器實測修正後：種完當下那輪評就走帳本（`practice_events` 1、`formal_due_claims`
1、`srs_v2` v1/interval 78）；再模擬單堂課評分讓 localStorage 前進到 interval 200，重載後
IDB 被採納到 v2/interval 200、`v1Import.stamp` 對得上。

## AE7 的守衛檢查能證明什麼、不能證明什麼

`tests/practice_ledger_app_contract.test.mjs` 裡的 `CONTEXT_MUTATION_SITES` **不是**
「所有路徑都守住了」的證明。它做的是**盤點**：把所有會改 `cardIndex`／`currentLessonId`／
`mode` 的位置（`app.js`／`listen.js`／`state.js`／`ui.js`，目前 41 處）跟凍結清單逐字比對，
任何新增、刪除、改寫都會紅，逼人打開清單看那個位置、決定它需不需要鎖。

會這樣寫是因為前兩版都被獨立審查當場打穿：第一版逐一列 selector 比字串位置；第二版自己
寫括號配對器切 listener body，被七種寫法規避（無大括號的箭頭 callback、body 裡的 regex
字面值讓配對 desync、mutation 塞在豁免 function 的尾巴、守衛換成含 `isLocked()` 的字串或
沒有 `return` 的死表達式…），而且 46 個 listener 裡有 18 個是認錯 body 的幻影區塊。
**想用靜態分析證明「全部守住了」做不到，而全綠會給假的信心，比沒有更危險。**

所以它擋不住：守衛不存在、守衛無效、守衛排錯位置、經過函式呼叫的間接 mutation。
那些靠 controller 層的行為測試與各自針對性的位置測試。三輪下來漏掉的（搜尋、設定 modal、
rerender 擦掉狀態列）全部都是「沒有人看過那個位置」——這條擋得住的正是那一類。

## 第六輪獨立審查（2026-09-06）：U5c 補的六條

兩個 fresh-context 審查員各自跑，兩邊都給「不能上 production」，各抓到一條 P0。

**P0-1 SW cache 版號沒升，這批對已安裝的 PWA 是 no-op。** `sw.js` 從 `d4308a2` 到
U5c 兩個 commit 一個 byte 都沒動，`CACHE` 還是 `thai-review-v98`＝線上正在跑的那個。
改到的五支 `src/*.js` 全在 SHELL 裡走 cache-first；`sw.js` bytes 沒變瀏覽器就不會
install，precache 不會重跑，裝置永遠拿舊 bundle。審查員在真瀏覽器做了對照：同一個
origin 先裝舊版再切新版，`reg.update()` 之後 `src/app.js` 還是 59,110 bytes、
`setLegacyImportHook` 不在；只把版號改成 v99，同樣的切換就變成 60,350 bytes、hook 在。
**部署會成功、read-back 會全對、文件會說 bug 修好了，而 Nalin 的手機跑的是舊 code。**
→ 升 v99，`tests/service_worker.test.mjs` 那條寫死的斷言一起改，並在部署後確認清單
裡註明「版號要跟線上前一版不同才有意義」。

**P0-2 匯入 hook 沒有重置圍籬。** 見上一節「重置圍籬」。審查員用真的
`src/cloud-sync.js` 寫了 repro，讓 hook 停在可控 promise 上、中途重置，實測
`FINAL: idb=1 gateCache=1 progressKeys=0`——重置後 IDB 又有列、閘門快取又被填滿。
→ `ledgerAuthorityGeneration` 圍籬，三個要素各自反證過會紅。

**P1-3 權威列讀失敗會連鏡射一起賠掉。** `readRuntimeAuthoritativeSrs` 原本在所有
inner try 之外，一丟就變 `status:'unavailable'`，`reconcileLedgerMirror` 永遠跑不到。
相對線上版是回歸（線上只是不開放 ledger 評分，數字照樣鏡射）。
→ 包 try，讀不到就當沒有權威列（閘門自然退回 legacy，安全方向），有測試釘住。

**P1-4 採納在主執行緒上是 O(alias × 卡片)。** `resolveLegacyAlias` 每次呼叫都把整個
alias index 攤平重數一遍 `cardIdCounts`，而呼叫端是每個 alias 叫一次。真資料
（13,738 張卡、13,074 個 alias）實測：

| alias 數 | 修正前 | 修正後 |
|---|---|---|
| 20 | 20.6 ms | 4.4 ms |
| 100 | 90.0 ms | 0.1 ms |
| 500 | 422.3 ms | 0.4 ms |
| 2000 | 1596.2 ms | 1.4 ms |

resolved 筆數兩邊完全一樣。這條每天都會走到，而且**這批上線後的第一次開機**待採納
的量最大（被 legacy 吃掉的卡越多集合越大，那正是這批要修的 bug）。
→ 照 index 物件記住 `cardIdCounts`（`WeakMap`，連 `size` 一起記，index 變了就重算）。

**P1-5 cloud-sync 每一輪有變動的同步都重抓 1.46 MB。** hook 每次都呼叫
`fetchProductionLineageEvidence()`，而那支帶 `cache: 'no-store'`，瀏覽器不會幫忙。
→ `loadProductionLineageEvidence()` 記憶化，**只記成功的那份**（記住失敗會把一次網路
問題變成整個 session 都認領不了）。

**P2-6 死掉的 fallback。** `authoritativeSrsRows` 原本串了
`?? bootResult.hydration?.snapshot?.srs ?? null`，但 runtime 在 `status !== 'unavailable'`
時一定給陣列、session 只在 `'ready'` 才建——那條永遠走不到，留著是假的保護。
→ 拿掉，contract test 改成 `assert.doesNotMatch`。

**沒有照審查員建議做的一條**：其中一位建議把「IDB 沒那一列就不寫」搬進
`commitLegacyV1Import`。**沒有照做，因為那會弄壞 cloud-sync 那條路**——baseline 只對
「有 legacy progress 的 alias」種列，所以「只在別台裝置評過、本機從沒評過」的卡在本機
根本沒有那一列，不建就永遠收不進帳本。正確的處理是把兩條路的不變式分開寫清楚（已改，
見上一節），不是把嚴格的那條套到兩邊。

## 已知的降級（不擋部署，但要知道）

**別台裝置按重置之後，`stamp > resetAt` 而倖存的那些卡會永久留在 legacy。**
`resetRuntimeLedgerAuthority` 把 IDB 的 srs 列全刪，但 `keysClearedByReset` 只刪
本機比 resetAt 舊的鍵，所以那些卡變成「本機有、IDB 沒有」。逐卡閘門會讓它們退回
legacy（本機那份才是對的，**不會掉資料**），但 `runtime-srs-baseline-v1` 的
`seededAliases` 是刻意保留的，baseline 不會再補寫回去，所以它們回不了帳本。
沒有任何 UI 或 log 說得出這件事。

## 已知還沒做的

- `__ALL__` 的 ledger 路徑（上面第 3 點）
- practice outbox 沒有上傳路徑——本輪範圍就不含新的 Supabase schema
- Gate B manifest 停在 2026-08-24，之後 `data.json` 又多了 106 張卡，那些 alias 認領不到
  （quarantine 成 `missing_historical_evidence`）。要涵蓋就得重跑一次 Gate B。
- v1 `thai_days` 沒有 `practice` 欄位，所以 practice-only 的出席只保證本機連續性，
  不宣稱跨裝置同步
- **cloud-sync 那半的匯入 hook 沒有執行層級的測試**。`tests/cloud_sync.test.mjs` 驗的是
  cloud-sync 這側何時呼叫 hook（用 stub），`tests/practice_ledger_app_contract.test.mjs`
  驗的是 `app.js` 的**原始碼文字**。hook 裡面
  `planLegacyV1Import → commitLegacyV1Import → adoptAuthoritative` 那串只在本機真瀏覽器
  手動走過開機採納那半；cloud 那半沒有跑過。
- **`RUNTIME_READBACK_ASSETS` 涵蓋不到 `src/app.js` 與 `src/cloud-sync.js`**，而 U5c 的
  接線全在這兩支。守門測試的 regex（`^src/(practice-|ledger-|storage-scope|…)`）結構上
  就挑不到它們。
- **遠端 winner 只要 `device_id` 是 NULL 就永遠匯不進帳本**：`rowToProgress` 會給
  `deviceId: null`，`isSrsStateSnapshot` 只收 `undefined` 或字串 → quarantine 成
  `invalid_srs_snapshot`，而且那筆已經寫進 `state.progress`，下次開機的採納也一樣擋掉。
  正常路徑的 `nextReview` 一定會填 deviceId，所以只有早期版本寫的列會踩到。
  **待查**：`select count(*) from thai_cards where device_id is null and grade is not null;`
  不是 0 的話，那些卡帳本永遠收不回來。
- **採納失敗完全不可見**：開機採納失敗只寫進 `result.adopted`（沒人讀），cloud hook 失敗
  只有 `console.warn`。手機上看不到 console，覆蓋率會靜默下滑——這次的 bug 就是這樣拖到
  線上實測才發現的。
