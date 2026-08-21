# 熟練衝刺期：每日複習排程設計文件

**日期**：2026-08-21（Asia/Taipei），2026-08-22 依 Nalin 回饋改版（見下方「2026-08-22 改版」）
**狀態**：**Phase 1（複習隊列本體）+ Phase 2（22:00 即時推播裝置→雲端同
步）都已實作完成並部署 production**（2026-08-22）。
**影響 repo**：`thai-review`（主要）+ `lth-tts-proxy`（Phase 2 架構改動，見
「即時進度推播」一節——不是原設計的 thai-review 自己的 CF Pages Functions）。

## 2026-08-22 第二次改版：從「每日固定張數」改成「每日 1 小時用時預算」

Nalin 想要的是「一天 1 小時，但不一定連續，一整天分好幾次加起來算」，不是
「每天固定幾張」。查 code 發現 `today.js`/`app.js` **已經有現成的每日累積用
時追蹤**，只是目前只記錄、沒拿來當目標用：`app.js:931-934` 有一個 15 秒
ticker（`document.hidden` 時跳過，只算前景時間），呼叫
`addActiveSeconds(15)`（`src/today.js:82-90`）寫進當天的 `day.seconds`，
**天生就是「不連續、累加、跨好幾次開 App」的用時計算**，跟 `streakDays`／
月曆熱度用的 `day.reviewed` 是分開的兩個欄位。下面「設計」整段的每日張數上
限，改成用這個既有欄位換算的用時預算，原本 60-80／30-40 的固定張數變成
「估算用」，不是實際的 gate 條件。

第一版設計把「從沒評過分的卡」當成要慢慢補的落後進度，用暫定的抽取方向問
Nalin。實際回饋不是這樣——Nalin 要的不是挑漏網之魚，是**從初 1 開始，照課
程順序，把全部課程重新複習一輪、重新評分**，包含早就評過分的舊卡也要重新
來一次（最近複習太少，舊評分很多已經不可信）。這跟第一版「只抽從沒評過分
的卡」是不同機制，下面「設計」整段改寫，第一版的「開放決策」也已經有答
案，直接寫成定案。

## 背景

Nalin 上完中 2-8 之後預計暫停上新課程一段時間，因為最近複習量很少、想把目前
累積的課程全部熟練了再繼續學新的。用 `data.json` 實際盤點現況：

- **48 堂課、共 13,632 張字卡**，從最早的「初 1」到目前最新的「中 2-5」都算
  在內——這正是既有 `allGraded` 成就（`src/achievements.js:14-18`）判定的
  「全部卡片上手」範圍，不是只算最近幾堂課。
- 現有「今日複習」（`src/today.js:496-538` + `src/app.js:828-839`）點下「開始
  複習」會把 `currentLessonId` 設成 `__ALL__`、`mode` 設成 `srs`，接著
  `filteredCards()`（`src/state.js:354-361`）呼叫 `getDueCards()`
  （`src/srs.js:67-82`）——**把全部 48 堂課裡「到期」的卡一次全部撈出來，
  沒有每日張數上限**。

查證業界（Anki 社群 + 認知科學文獻）常見做法後，發現現有設計有三個沒處理到
的缺口，直接對應 Nalin 這次的痛點：

### 缺口 1：現有系統沒有「照課程順序全面重新複習」這種模式

`isDue()`（`src/srs.js:59-62`）的邏輯是「曾經評過分 + 到期時間已到」——
**不管是從沒評過分的卡，還是很久以前評過分、現在早就過了到期時間的卡**，
都只會照到期時間或到期狀態被動出現，沒有一種「從頭開始、依課程順序、不管
新舊全部重新走一遍」的主動模式。這正是 Nalin 這次要的：不是被動等系統排到
期，是主動照 初 1 → 初 2-1 → …… → 中 2-5 的順序整批重新評分一輪，把最近少
複習累積的不可信舊評分全部刷新。

### 缺口 2：沒有每日上限，久沒複習後回來會被巨量到期卡淹沒

Anki 官方與社群一致的建議：**如果累積了大量到期卡，第一步是暫停新卡（Nalin
本來就打算這樣做，方向正確），然後用「相對逾期程度」(relative overdueness)
排序，而不是絕對逾期天數**——一張 interval 只有 3 天、逾期 30 天的卡，代表
的遺忘機率遠高於一張 interval 400 天、也逾期 30 天的卡，但現有
`getDueCards()` 排序是絕對 `nextReviewAt` 由舊到新（`src/srs.js:76-81`），
沒有把這個相對性算進去。另外，回來複習後前幾天答錯率偏高（研究指出可能比平
常高 10-20 個百分點）是正常現象，一週左右會回穩，不代表 SRS 演算法壞了。

### 缺口 3：現有排序容易整堂課黏在一起，不是真正跨課次交錯

同一天評過分的卡（例如某堂課第一次整堂刷完）`nextReviewAt` 會非常接近，排序
後容易連續一整串都是同一堂課，不是研究支持的「跨主題交錯」(interleaved
practice)。語言學習的統合分析顯示分散＋交錯練習對詞彙記憶效果優於集中刷同一
批內容。

## 設計：三段式每日複習隊列

不做成一個要手動切換的「模式」，而是直接改寫「今日複習」背後的隊列組成邏
輯——平常（backlog 不大時）行為幾乎無感，backlog 大的現在這個階段會自動發
揮效果，未來繼續上新課後也一樣適用，不需要之後再切回來。

```
今日複習隊列 = 到期複習（相對逾期排序，優先吃用時預算）
             + 重新複習掃描（照課程順序從初 1 開始，用剩下的用時預算，保底一部分）
             + 弱項加強（還有剩餘預算才補，既有 weakestCards() 抽幾張）
```

三段共用**同一份每日 1 小時用時預算**（可調），不是各自獨立的張數上限。

### 每日用時預算：怎麼讓「不連續、分好幾次」自然成立

- 預算來源：`day.seconds`（`src/today.js:82-90`，已經是「當天不管開幾次
  App，前景時間都累加」的欄位，`app.js:931-934` 的 15 秒 ticker 已經在
  寫）。**不用新增任何時間追蹤機制，直接讀現成的**。
- 目標：每天 60 分鐘（3600 秒），Nalin 這次的預定值，之後想改就是改一個常
  數。
- **每次開「今日」頁或按「開始複習」時，才即時算「今天剩多少預算」**：
  `remaining = max(0, 3600 - day.seconds)`。早上通勤複習了 20 分鐘，中午再
  開，`remaining` 就只剩 40 分鐘份——不用另外記「今天複習過幾次」，
  `day.seconds` 本身就已經是跨次數累加的正確值。
- 每次組隊列，用「剩餘預算」換算成「這次大概要放幾張」：估算值（見下），不
  是精確保證，抓個八九不離十就夠，因為 `day.seconds` 本身才是真正的 gate，
  下一次開 App 又會用實際累積的秒數重新算一次，估算不準也會自我修正，不需
  要做到精確計時每一張卡。
- **不做硬性擋下**：預算用完不強制鎖住，「今天已經複習滿 1 小時」用類似現
  有 `today-checkin done` 的完成態顯示（`src/today.js:503-505` 已有這個視
  覺語彙），底下留一個「還想繼續複習」的路徑（例如直接顯示到期複習/掃描的
  剩餘總數，讓 Nalin 自己選要不要超過目標），不是把功能整個關掉。

### 1. 到期複習：相對逾期排序 + 每日上限

- `getDueCards()` 排序改用「相對逾期」：
  `overdueRatio = (now - nextReviewAt) / (interval * DAY_MS)`，由大到小排序
  （越可能忘記的排越前面）。舊的「絕對 `nextReviewAt` 由舊到新」在 interval
  差異不大時結果幾乎一樣，只有 backlog 差異拉開時才會改變順序，行為變化是漸
  進的，不是砍掉重練。
- **優先吃用時預算**：到期卡是真的在流失記憶的，三段裡優先度最高。一張卡
  評分＋跟讀大概抓 15-20 秒，換算下來理論上可以用掉接近整個 60 分鐘（60分
  ÷17.5秒 ≈ 200 張）——但為了不讓「重新複習掃描」永遠被到期複習擠到沒有，
  到期複習這段**軟性抓一個上限，暫定最多用掉 45 分鐘的預算**（約 150-180
  張），把至少 15 分鐘留給下面的重新複習掃描。到期backlog 剛開始清的頭幾天
  可能整個 45 分鐘都在還這筆債，這是正常的、符合 Anki 官方建議的優先順序，
  backlog 通常幾天內會清掉。
- 沒被今天預算吃到的到期卡不會消失，就是留到明天，因為明天再算一次相對逾
  期排序時，沒複習到的最舊卡還是會排在最前面——不需要另外做「延到明天」的
  狀態記錄，天然靠重新排序達成。
- **不重置任何既有進度**——即使 backlog 很大，也不建議清掉舊的 interval／
  easeFactor 重來。舊資料裡「這張卡上次複習答對了」這個訊號本身還是有效，砍
  掉等於把已經記得的訊號也丟掉。

### 2. 重新複習掃描：照課程順序從初 1 開始，新舊卡都重新評分

**這是這次改版的核心機制，取代第一版的「補課新卡」。**

- **順序**：完全照 `state.lessons` 現有順序走（初 1 → 初 2-1 → …… → 中
  2-5，跟 Sheet 分頁順序一致，本來就是課程開課順序），**不篩選「有沒有評過
  分」**——舊卡、新卡、很久以前評過的卡，一律照順序重新出現一次，讓 Nalin
  重新評分。
- **持久化游標**：獨立存一個 `{ startedAt, position }`（`position` 是「照
  順序攤平後的第幾張卡」，比照 `today.js` 的 `DAILY_KEY` 做法另開一個
  localStorage key，不動主 STORAGE_KEY schema）。每天從上次的 `position`
  繼續往後抓固定張數，評完游標往前推進；不會因為某張卡本來就有舊評分而跳
  過，**掃描到就一定重新評分一次**。
- **用掉到期複習之後剩下的用時預算，但保底至少 15 分鐘**：重新評一張已經
  很熟的卡通常比評一張真正陌生的卡快（大多直接按「簡單」），暫估 10-12
  秒／張。就算到期複習當天把 45 分鐘用滿，掃描仍然保底拿 15 分鐘（約
  75-90 張）；到期複習沒吃那麼多預算的日子（backlog 清完後常態），掃描能
  拿到的時間會更多，不用另外設張數上限，交給剩餘預算自然決定。
- **誠實的範圍估算，不是單一數字**：backlog 剛開始清、到期複習天天吃滿 45
  分鐘的最差情境，掃描每天只能拿保底的 15 分鐘（約 80 張），13,632 張掃完
  一輪要 **~170 天（約 5.5 個月）**；backlog 清完、到期複習用時很少的最佳
  情境，掃描能拿到接近 45-50 分鐘（約 250-270 張），只要 **~50 天（約 7-8
  週）**。實際會落在中間，而且會隨 backlog 清掉而加速——按 Anki 社群經驗，
  backlog 通常幾天內能清完，不會撐滿 170 天那麼久。掃到中 2-5 結尾之後，若
  還沒開始上新課（中 2-6 以後），游標可以選擇停在原地等新內容，或直接從頭
  再掃一輪（要不要自動重掃第二輪，等真的掃完第一輪再問 Nalin，這次不用先
  決定）。
- **游標小風險，先記錄不處理**：如果掃描還沒走到的某堂課，之後又被回頭修
  改卡片數量（像這次 260821 那樣事後補資料到「中 2-5」），扁平游標可能因為
  課次卡數變動而稍微跳過或重複個幾張。影響極小、自我修正（掃過一輪後所有
  卡都至少重新評過一次），不需要為此做複雜的按課次分開計數。

### 熟悉程度怎麼混入之後的每日複習——不用另外設計，既有 SM-2 引擎本來就會做

Nalin 問的「這些新評分要根據熟悉程度混入之後的每日複習」，其實**不需要新
機制**：掃描時每評一次分，就是正常呼叫既有的 `nextReview()`
（`src/srs.js:17-44`），跟平常字卡模式評分完全同一套邏輯——評「簡單」的字
自動排到很久以後才會再出現在到期複習裡，評「重來/有點難」的字幾天內就會回
到到期複習隊列。**掃描（重新複習）跟到期複習（第 1 段）本來就共用同一份
`state.progress`**，掃描只是「主動把很久沒被動到期的卡拉出來重新評分」的
入口，評完之後這張卡的命運就完全交給既有的 SRS 引擎，兩邊隊列不需要另外寫
橋接邏輯。

（比對參考：Nalin 提到的 Speak App「Smart Review」，官方沒有公開詳細排程
演算法，只知道概念是「持續追蹤使用者對每個語言概念的掌握度，據此決定何時
再出現」——這跟現有 SM-2＋4 檔評分的精神是一致的，沒有找到值得額外抄的具
體機制，不需要為了「像 Speak」而改動核心演算法。）

### 3. 弱項加強（已拍板一起做）

三段裡優先度最低，**只有到期複習＋掃描都排完、預算還有剩才補**，沿用既有
`weakestCards()`（`src/stats.js:59-81`，已經算好 again/hard 排序）抽最多
5-10 張混進隊列，即使還沒到正式到期時間也提前複習一次。複雜度低，資料已經
現成，用的也是同一份剩餘用時預算，不用另外設張數上限。

### 交錯排序（呼應研究的 interleaving 效果）

三段組完隊列後，同一 `_lessonId` 的卡如果連續出現超過 2-3 張，做一次輕量重
排（round-robin 分散各課次），避免整段隊列變成「刷完一整堂課才換下一堂」。
不需要複雜演算法，桶分（bucket by `_lessonId`）+ 輪流取一張即可。

### 覆蓋率可視化（已拍板一起做）

`buildAchievementCtx()`（`src/today.js:313-335`）已經算好
`gradedCards`/`totalCards`，只是目前只拿來判定 `allGraded` 成就，沒有平常顯
示出來。這個衝刺期在「今日」頁加一條進度列，例如「涵蓋率 42%（5,725 /
13,632）」，同時可以疊加「重新複習掃描」自己的進度（游標 `position` /
13,632），讓 Nalin 看得到兩種進度：全部卡有沒有評過分、跟這一輪重新複習掃
到哪裡了。

## 已拍板的決策

1. **重新複習掃描順序**：照課程順序從「初 1」開始，不分新舊卡全部重新評分
   （2026-08-22 確認，取代第一版「只抽從沒評過分的卡」的設計）。
2. **每日總量**：改用**每日 1 小時用時預算**（`day.seconds` 累加，不用連
   續，可分好幾次），取代原本固定張數上限（2026-08-22 第二次確認）。到期
   複習軟性上限 45 分鐘、重新複習掃描保底 15 分鐘，60-80／30-40 張只當估
   算參考，不是實際 gate 條件。
3. **弱項加強、涵蓋率進度列**：這次一起做，不拆開排。
4. **距離每日目標的提醒，開 App 被動顯示＋22:00 主動推播都要，推播要即時進
   度**（2026-08-22 兩階段確認：先定被動顯示，後改成連即時推播一起做）：
   - 開 App 被動顯示：今日頁加一行「距離今天 1 小時目標還差 X 分鐘」，套用
     既有 `today-checkin`（`src/today.js:503-505`）的視覺語彙。
   - 22:00 推播：沿用既有 `scripts/daily-reminder.py` 的排程（不用另外開一
     個排程，`.github/workflows/daily-reminder.yml` 的 `cron: "7 14 * * *"`
     = 台北 22:00），在同一則訊息裡加「今天已複習 X 分鐘，距離目標還差 Y
     分鐘」。**這需要裝置進度同步**（見下方獨立一節「即時進度推播：裝置 →
     雲端同步設計」）——`day.seconds` 本來只在裝置端 localStorage，
     `daily-reminder.py` 是雲端跑的，讀不到。這是這個 App 第一次需要任何裝
     置資料離開裝置，範圍刻意壓到最小（只同步「今天累積秒數」這一個數字，
     不是完整 SRS 進度），跟之前排除的「完整雲端同步」是不同量級的決定。

## 即時進度推播：裝置 → 雲端同步設計（Phase 2，2026-08-22 已實作完成）

範圍刻意縮到最小：只同步「今天累積複習秒數」這一個數字，不同步卡片內容、
SRS 進度、評分紀錄，也不做雙向同步，資料 3 天自動過期，跟「完整雲端同步」
（之前明確排除的方向）是不同量級的東西。

### 架構跟原設計不同：改用 lth-tts-proxy，不是 thai-review 自己的 CF Pages Functions

原設計想在 thai-review 自己的 CF Pages 開 Functions + 新 KV，用 Cloudflare
Access Service Token 讓 `daily-reminder.py`（GitHub Actions）通過 thai-review
正式站的 Access 保護。實作時卡住：目前 wrangler OAuth token 的權限範圍沒有
Zero Trust／Access 管理權限（`npx wrangler whoami` 列出的 scope 沒有 Access
Apps/Service Token 相關項目），程式化建立 Service Token 做不到，要嘛改用有
Zero Trust 權限的 API token（沒有），要嘛請 Nalin 自己去 CF 面板點兩下。

**改用已經在服務 thai-review 的 `lth-tts-proxy` Worker 加兩個端點**，完全繞
開這個卡點：

- 那支 Worker本來就不在 CF Access 保護範圍內（`*.workers.dev`，走自己的
  CORS allowlist，不是 thai-review 那個受 Access 保護的自訂網域），不需要
  Service Token。
- 已經有 CORS allowlist 包含 `https://thai-review.lthfilmstudio.com`、已經
  有 `TTS_CACHE` KV 可以借用（key 前綴 `progress:` 分開，不用另開 KV
  namespace）、已經有 `wrangler secret put` 的既有慣例。
- 新增兩個端點：`POST /progress`（裝置回報秒數，沿用既有 CORS 保護，沒有額
  外驗證——低風險：偽造頂多讓 Nalin 自己收到錯的分鐘數）、`GET /progress`
  （`daily-reminder.py` 讀加總，改用 `PROGRESS_READ_KEY` 共享密鑰的 Bearer
  token，比 Service Token 簡單，這個場景夠用）。
- 已部署到 production，curl 驗證過完整 round-trip。

### 已知踩雷：Cloudflare 對 `workers.dev` 網域擋 Python urllib 預設 UA

`daily-reminder.py` 第一次用 `urllib.request` 打 `GET /progress` 直接收到
`403 Forbidden`／`error code: 1010`，跟 Worker 自己的邏輯無關——是 Cloudflare
邊緣層級對 `Python-urllib/3.x` 這種泛用 HTTP client 預設 User-Agent 的擋
（同一支 curl 用預設 UA 打得通，換成 `-A "Python-urllib/3.12"` 就 403，實測
驗證過）。修法：在 request 帶自訂 `User-Agent` header（例如
`thai-review-daily-reminder/1.0 (+github repo url)`）就過了，不需要動
Cloudflare 設定。

### 裝置端怎麼送

`src/progress-sync.js`（新檔）：`syncProgressThrottled(seconds)` 給既有 15
秒 ticker（`app.js` 裡）每次 tick 呼叫，內部節流成 90 秒送一次；
`syncProgressOnHide(seconds)` 掛在新的 `visibilitychange` 監聽上，背景化時
用 `navigator.sendBeacon()` 補送最後一筆（背景時一般 fetch 容易被系統中
斷）。`deviceId` 沿用既有 `getDeviceId()`（`src/srs.js`，改成 export）。

### 附帶好處

因為現有 `day.seconds` 是每個裝置各自獨立算的（手機複習 20 分、筆電再複習
20 分，兩邊 localStorage 互不知道對方），22:00 推播的 `fetch_progress_seconds()`
**把同一天所有 `deviceId` 的秒數加總**，反而會比任何單一裝置自己算的還
準——這不是這次要解的問題，只是同步機制順便補上的效果，值得記一筆。

複雜度：實際落地後是**中**（比原估的中-高低，因為繞開了 CF Access／Service
Token 這個最貴的部分；bot UA 擋這個雷花了一輪除錯，但一次就抓到根因）。

## 複雜度與要改的檔案（Phase 1 已實作完成，2026-08-22）

- `src/srs.js`：`getDueCards()` 加相對逾期排序（純函式改動）。
- 新檔 `src/resweep.js`：`loadResweepState()` / `pickResweepBatch(orderedCards, n)`
  / `advanceResweepCursor(delta, total)` / `resweepProgress(total)`。獨立
  localStorage key `thai-review-resweep-v1`（比照 `DAILY_KEY` 做法），不動主
  STORAGE_KEY schema。
- `src/today.js`：新增 `buildDailyQueue(allCards, progress, lessons,
  todaySeconds)`——純函式，讀 `day.seconds` 換算剩餘用時預算，依「到期優先
  （軟上限 45 分）→ 掃描（保底 15 分）→ 弱項加強（剩餘才補）」組隊列，內建
  `interleaveByLesson()` 依 `_lessonId` round-robin 打散連續同課次。回傳
  `{ cards, resweepKeys }`。
- `src/state.js`：新增虛擬課程 id `__TODAY__`（比照 `currentLesson()` 裡
  `__ALL__`/`__FAV__`/`__SEARCH__` 現有寫法），讀 `state.dailyQueueKeys`
  （ephemeral、不存 localStorage）組今日隊列；`filteredCards()` 對
  `__TODAY__` 直接回傳，不再套一次 `getDueCards()`（那會把非到期的掃描／弱
  項卡濾掉）。新增 `setDailyQueue()`/`removeFromDailyQueue()` 兩個 helper。
  **沒有開額外按鈕**，`__TODAY__` 只給「開始複習」內部使用，符合下方「不做
  模式切換 UI」。
- `src/app.js`：`data-start-review-all` 點擊時呼叫 `buildDailyQueue()` +
  `setDailyQueue()`，`currentLessonId` 改設 `__TODAY__`（原本是
  `__ALL__`）；`gradeAndAdvance()` 評分後對 `__TODAY__` 呼叫
  `removeFromDailyQueue()`，是掃描來源的卡才呼叫 `advanceResweepCursor(1,
  total)` 推進游標。
- 覆蓋率／掃描進度列 + 每日目標提醒：`src/today.js` 的 `renderTodayMode()`
  加兩行進度列（涵蓋率、重新複習掃描進度）+ 一行「距離今天 1 小時目標還差
  X 分鐘」，都是讀現成欄位換算的純顯示邏輯，`styles/components.css` 加對
  應樣式。
- `src/stats.js`：`weakestCards()` 回傳多加 `lessonId` 欄位（原本只有
  `lessonTitle`），非破壞性新增，`buildDailyQueue()` 要靠它把弱項卡映射回
  實際卡片物件。
- 測試：`tests/resweep.test.mjs`（新檔）、`tests/srs.test.mjs`／
  `tests/today.test.mjs` 各加幾個 case，`node --test tests/*.test.mjs`
  126/126 綠（原本 1 個跟這次改動無關的既有 flaky 測試也一併修掉了，見下方
  「已知問題」）。
- 新檔 `src/progress-sync.js`：節流送出 `POST /progress`＋`visibilitychange`
  時 `sendBeacon` 補送，見上方「即時進度推播」一節。`src/srs.js` 的
  `getDeviceId()` 改成 export 給它重用（原本是內部 helper）。
- `src/app.js`：15 秒 ticker 加一行呼叫 `syncProgressThrottled()`，新增
  `visibilitychange` 監聽呼叫 `syncProgressOnHide()`。
- `lth-tts-proxy` repo（**不是 thai-review**，見「即時進度推播」一節的架構
  改動說明）：`src/index.ts` 加 `POST /progress`／`GET /progress` 兩個端點，
  借用既有 `TTS_CACHE` KV，新增 `PROGRESS_READ_KEY` secret，已部署 production
  並 commit/push；新測試 `tests/progress.test.mjs`。
- `scripts/daily-reminder.py`：新增 `fetch_progress_seconds()`／
  `format_progress_line()`，22:00 推播前多一步 `GET /progress`（帶
  `PROGRESS_READ_KEY` Bearer token，注意上面提到的 UA 踩雷修法），把當天各
  裝置秒數加總組進訊息文字，失敗靜默略過不擋主推播；新測試
  `tests/daily_reminder_test.py`。`.github/workflows/daily-reminder.yml` 加
  一個新 Secret `PROGRESS_READ_KEY`（已用 `gh secret set` 設定）。
- 對音訊管線衝突風險：零（純排序／篩選邏輯 + 獨立的進度同步，不碰
  `listen.js`/`tts.js`）。
- 複雜度：Phase 1 + Phase 2 合計落地後是**中**——比原估的中-高低，主因是
  Phase 2 繞開了最貴的 CF Access／Service Token 設定（改用已存在的
  `lth-tts-proxy` Worker），實際卡點反而是意料之外的 Cloudflare bot UA 擋
  Python urllib，一輪除錯就抓到根因解掉。

## 已知問題（跟這次改動無關，發現時一併修掉）

`tests/today.test.mjs`「a games-only day does not affect
maxDailyReviewed/totalReviewed」這個既有測試會間歇性失敗——它把
`logGame` 的時間戳寫死在 `2026-08-20`，但斷言用的 `buildAchievementCtx()`
原本沒帶 `now` 參數、預設吃真實 `Date.now()`，系統日期走到 2026-08-20 以
後（就是現在）就會跟寫死日期的測資對不上。用 `git stash` 驗證過 Phase 1
改動之前這個測試在乾淨的 main 上就已經失敗，不是這次動到的東西——已在
Nalin 確認後一併修掉：`buildAchievementCtx(log, now = Date.now())` 加一個
可選的 `now` 參數（往下傳給 `streakDays()`/`accuracyTrend()`），測試改傳
固定的 `now` 對齊寫死的日期；正式程式碼所有呼叫端都用預設值，行為不變。

## 不動的部分

- 不改 SM-2 核心公式（`nextReview()`）本身，只改「哪些卡、依什麼順序、抽多
  少張」這一層。
- 不做「模式切換 UI」——三段式隊列直接取代現有「開始複習」背後的邏輯，backlog
  小的時候（例如之後恢復上新課、backlog 被壓下去之後）自然退化成接近現在的
  行為，不需要額外開關。
- 不重置任何既有 SRS 進度資料。
- **不做完整雲端同步**——只同步「今天累積複習秒數」這一個數字給 22:00 推播
  用（見上方獨立一節），不同步卡片內容、SRS 進度、評分紀錄，範圍刻意壓到
  最小，跟「完整雲端同步」是不同量級的決定（2026-08-22 第三次確認，取代第
  一版「不做推播」的決定）。
- 不做 Web Push（iOS PWA 支援不穩，且 22:00 推播已經有 Telegram 這條路
  可用，不需要疊兩套）。

## 來源

- [New-cards backlog: how to tackle to maximise retention — Anki Forums](https://forums.ankiweb.net/t/new-cards-backlog-how-to-tackle-to-maximise-retention/53412)
- [Catching Up On Your Anki Reviews — Control-Alt-Backspace](https://controlaltbackspace.org/catch-up/)
- [Adressing Backlog — Anki Forums](https://forums.ankiweb.net/t/adressing-backlog/43842)
- [Spaced Repetition: The Complete Guide (2026) — Active Recalling](https://activerecalling.com/blog/spaced-repetition-ultimate-guide)
- [(PDF) Interleaved Spaced Repetition (ISR) in Vocabulary Learning — ResearchGate](https://www.researchgate.net/publication/365320689_Interleaved_Spaced_Repetition_ISR_in_Vocabulary_Learning)
- [Understanding the Role of Interleaved Practice in Language Learning — Science Based Learning](https://www.sciencebasedlearning.com/blog/interleaved-practice-language-learning)
- [Speak App Review: Is It Worth It in 2026? — LanguaTalk](https://languatalk.com/blog/speak-app-review/)（Smart Review 概念描述，無公開詳細演算法）
