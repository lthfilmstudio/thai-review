# thai-review 對標 Speak/ELSA/SRS 改進設計文件

**日期**：2026-08-17（Asia/Taipei）
**狀態**：實作中，按建議順序一步一步做。方向 4 獨立成就（#1/#2/#3/#5/#6）與
方向 2（SRS 四檔評分）已完成上線；方向 3（複習數據呈現）進行中；方向 4 剩下
依賴方向 2/3 的 #4/#7 留到方向 3 做完再補。方向 1（錄音跟讀比對）仍暫緩，等
系統穩定後再繼續開發。
**影響 repo**：`thai-review`（僅本次規劃，未來實作若涉及中文語音會再影響 `lth-tts-proxy`，本次無）

## 背景

Nalin 想參考 Speak、ELSA 等語言學習 App 跟業界 SRS(間隔重複)做法，檢討「清心
安神」(thai-review)這個泰文複習 PWA 有沒有可以改進的地方。盤點現有程式碼並查
證業界做法後，確認了 5 個落差：

- **SRS 演算法太陽春**：只有三檔評分（差/可以/熟），無卡片狀態分類，無 FSRS。
- **完全沒有發音回饋**：跟讀模式是純靜音等待，系統不知道使用者說了什麼。
- **複習數據呈現薄弱**：只有 streak 連續天數，無正確率趨勢、無弱項分析。
- **無遊戲化**：無成就/XP，跟 Duolingo 的多層次習慣迴圈比起來很單薄。
- **無雲端同步**：純 localStorage，這項這次沒選，不在本次範圍。

Nalin 全選了「錄音跟讀比對(簡化版)」「SRS 演算法優化」「複習數據呈現」
「遊戲化(成就/XP)」四個方向，並確認想知道額外成本。**結論：四項都不需要新
的付費 API/服務**——明確排除自動語音辨識/發音評分，因為泰文是聲調語言，瀏覽
器原生 Web Speech API 對聲調語言準確度不足，自動評分要嘛不準要嘛要串貴的外部
API（如 Speechace），這次刻意做零成本的「只錄、只回放比對，靠自己耳朵判斷」
簡化版。

已針對四個方向讀過 `src/srs.js`/`src/card.js`/`src/today.js`/`src/state.js`/
`src/listen.js` 的實際程式碼，產出以下具體設計方案。

**本次範圍限定在「把設計寫成文件」**——先定案存檔，不改動任何 `src/*`、
`sw.js`、`data.json` 等現有程式檔，等 Nalin 確認要開始時再回來實作。

## 建議實作階段順序（供未來執行時參考）

1. **方向 4 的獨立成就**（#1/#2/#3/#5/#6，不依賴其他方向）——半天到一天，低
   風險快速勝利。
2. **方向 2：SRS 四檔評分優化**——骨架性質，方向 3、4 剩餘部分依賴它。
3. **方向 3：複習數據呈現**（趨勢圖 + 課次弱項 + 最弱字清單，聲調分類列可選）。
4. **補完方向 4 剩下依賴方向 2/3 的成就**（#4/#7）。
5. **方向 1：錄音跟讀比對**——**暫緩**。技術不確定性最高，跟現有背景播放管
   線有衝突風險，先讓方向 2/3/4 落地、系統穩定下來，之後有餘裕再回頭做（含
   下方的 iOS PWA 麥克風 spike 驗證）。

---

## 方向 2：SRS 演算法優化

**結論**：不換 FSRS（Nalin 一人的複習資料量不足以支撐 FSRS 全域參數擬合，且
沒有零依賴的輕量 JS 實作可以直接 vendor 進來）。改用「四檔評分 + 從既有欄位
推導卡片狀態」的漸進式改良，不新增獨立 status 欄位。

- `srs.js` 的 `GRADE_Q` 從三檔(bad/ok/good)擴成四檔：Again(重來)/Hard(有點
  難)/Good(可以)/Easy(很熟)，`nextReview()` 加 hard(interval 打折 ×0.7)/
  easy(interval 加成 ×1.3、easeFactor 加成更多)兩個新分支。
- 新增 `cardStatus(entry)` 純函式，從既有 `reps`/`interval` 推導
  new/learning/review/mature（mature 閾值：interval ≥ 21 天，沿用 Anki 慣例），
  不新增獨立 status 欄位，避免跟 reps/interval 打架。
- **舊資料不需要 migration**：`interval`/`easeFactor`/`reps` 數值欄位延續使
  用，只有評分按鈕介面從 3 顆變 4 顆。`state.js` 的 `listFilter` 型別要擴充
  相容四檔值；舊 `'ok'` 篩選值怎麼對應新四檔留一個待確認項（建議先當
  `hard`，之後依 Nalin 實際使用手感再調整，非阻塞決策）。
- 要改的檔案：
  - `src/srs.js`（`GRADE_Q`、`nextReview()`、新增 `cardStatus()`）
  - `src/card.js`（`renderCardMode` 評分按鈕列 `card.js:124-134`、preview 呼
    叫 `card.js:74-77`，從 3 顆按鈕改 4 顆）
  - `src/state.js`（`listFilter` 型別註解）
  - `styles/components.css`（三色 pill 系統擴四色，加一個介於 red 和
    neutral 之間的橘色給 hard）
- 對音訊管線衝突風險：**零**（純評分計算，不碰 `listen.js`/`tts.js`）。
- 複雜度：低-中。主要工作量在 UI 排版跟 hard 檔 interval 打折係數的手感調校
  （沒有標準答案，建議先用保守值上線再依實際使用調整）。

## 方向 3：複習數據呈現

- 放在 `today.js` 現有的 `today-wrap` 底下加可切換分頁（`statsTab`，
  module-local 狀態、不持久化），**不新增頂層 mode tab**（現有 6 個 tab 手機
  版已經偏擠）。
- 資料**即時**從 `DAILY_KEY`(`thai-review-daily-v1`) 跟 `state.progress` 算，
  不另存彙總表——資料量小（一年頂多 365 筆 day entry），即時算的效能成本遠
  低於維護一份彙總表的同步成本。
- 三個功能：
  - **`accuracyTrend(days, n)`**：近 7/30 天正確率趨勢，手刻極簡 CSS bar（不
    引入外部圖表庫，維持專案零依賴慣例）。依賴方向 2 的四檔 counter 擴充
    （`day` 物件從 `{reviewed,bad,ok,good}` 擴成含 `again/hard/easy`），用
    「缺欄位當 0」的寬鬆讀法天然相容新舊資料，不需要 migration。
  - **`weakLessons(progress, lessons, minSamples)`**：依 badRate 排序，列前 5
    名最弱課次。
  - **`weakestCards(...)`**：最常被評差的單字清單。取代準確度存疑的「聲調弱
    項分類」——`karaoke` 欄位是非結構化拼音字串，聲調符號（à/á/â/ǎ）混雜在
    字母裡，用正則抓變音符號當聲調代理指標準確度有限（一個詞可能多音節、多
    聲調符號混在一起，無法精確對應「這張卡是幾聲」）。`weakestCards` 是
    100% 準確的替代方案，聲調分類列為可選、之後有餘裕再做。
- 建議把這些純函式抽到新檔 `src/stats.js`（`today.js` 目前已 203 行、混雜
  daily log/streak/月曆/render 職責），方向 4 的成就判定也能共用。
- 要改/新增的檔案：`src/stats.js`（新增，純計算函式）、`src/today.js`
  （`renderTodayMode` 加統計區塊 render + 分頁切換 UI）、`sw.js`（`SHELL`
  加一行）。
- 對音訊管線衝突風險：**零**（純資料展示）。
- 複雜度：低-中。

## 方向 4：遊戲化（成就/XP）

**結論**：不做 XP 數值系統（自家人用的複習工具，沒有排行榜、沒有其他玩家比
較，XP 平衡數值需要一套成長曲線，屬於過度工程，且每次改 SRS 評分規則都要連
帶調 XP 公式，維護負擔大於帶來的動機價值）。只做**一次性布林達成記錄**的成
就徽章，起手 7 條，克制不過度設計：

| # | 成就 | 判定條件 | 依賴 |
|---|---|---|---|
| 1 | 🔥 連續 7 天 | `streakDays() >= 7` | 無（獨立） |
| 2 | 🔥 連續 30 天 | `streakDays() >= 30` | 無（獨立） |
| 3 | 📅 單日複習 50 張 | 當日 `reviewed >= 50` | 無（獨立） |
| 4 | 🎓 課程全通關 | 某課全部卡片 `cardStatus() === 'mature'` | 方向 2 |
| 5 | 📚 456 張全上手 | 全部卡片至少評過一次分 | 無（獨立） |
| 6 | 🌟 千張複習 | 累計 `reviewed` 達 1000 | 無（獨立） |
| 7 | 🎯 一週正確率 90%+ | `accuracyTrend(7)` 平均 pct ≥ 90 | 方向 3 |

刻意不做「聲調正確率達標」成就（理由同方向 3 的聲調偵測技術限制，不準的判定
會變成誤導性的假成就），也不做瑣碎行為徽章（深夜複習之類），避免過度設計。

- 新檔 `src/achievements.js`：`ACHIEVEMENT_DEFS` 純判定清單、獨立
  localStorage key(`thai-review-achievements-v1`)、`checkAndUnlock(ctx)`。
  `ctx` 物件由呼叫端（評分後、進今日 tab 時）組裝好餵入，`achievements.js`
  本身保持 stateless 純判定，跟 `srs.js` 的設計哲學一致。不做 push
  notification（沒有 SW push 基礎設施，成本過高），改成被動檢查 + toast 提示。
- 顯示位置：`today-wrap` 加一小條「已解鎖 N/7」徽章列（灰階未解鎖/彩色已
  解鎖），放月曆下方。
- 對音訊管線衝突風險：**零**（跟 SRS 評分 callback 掛鉤，不碰 audio）。
- 複雜度：低。全部純函式判定 + 一個小 UI toast，沒有演算法或非同步時序問題。
  是四個方向裡最快能做完、風險最低的一塊。#1/#2/#3/#5/#6 完全獨立、不依賴其
  他方向，可以最快先做完當熱身；#4/#7 要等方向 2/3 落地。

## 方向 1：錄音跟讀比對（簡化版）—— 暫緩，技術不確定性最高

> **暫緩開發**：等方向 2/3/4 落地、系統穩定後再繼續。以下設計先保留當參考，
> 開工前記得回來重新確認 iOS 相容性現況是否有變化。

**核心限制**：不做語音辨識、不做發音評分，只錄音、只回放，靠 Nalin 自己耳朵
判斷跟老師的差異。

**iOS Safari PWA 風險**（需要實機驗證，不能只憑文件判斷）：

1. `MediaRecorder` 在 standalone（加到主畫面）模式下的 `getUserMedia` 麥克風
   權限行為過去曾經不穩定，部分版本可能每次 session 都重新跳授權框，會干擾
   跟讀節奏。
2. iOS Safari 的 `MediaRecorder` 輸出格式是 `audio/mp4`（不是 Chrome 慣用的
   `audio/webm`），程式要用 `MediaRecorder.isTypeSupported()` 做 feature
   detect 選正確 mimeType，不能寫死。
3. 背景/鎖屏時 `getUserMedia` 的麥克風串流會被系統暫停或中斷——這跟
   `listen.js`/`listen-lock.js` 現有「鎖屏也要持續播放」的設計目標根本衝突。

**關鍵設計決策：鎖屏模式(`playbackMode==='lock'`)完全不提供錄音 UI**。錄音
要求前景，鎖屏要求背景，這兩者在 iOS 上本質衝突，不硬解，直接切開，把最大
的衝突面直接切掉。

**跟現有音訊管線的整合方式**：

- `listen.js`/`tts.js` 用單一共用 `<audio>` element（`tts.js:28`
  `sharedAudio`）串所有播放，是為了讓 iOS 認定這是連續一條媒體工作階段才能
  背景播放不中斷。**錄音回放走獨立的第二條 `<audio>` element**，完全不碰
  `sharedAudio`，避免跟 `runListenStep` 的播放狀態機（`state.listen.playing`/
  `runVersion`）搶同一個 element。
- 新檔 `src/mic-record.js`：`isRecordingSupported()`/
  `requestMicPermission()`/`startRecording()`/`stopRecording()`/
  `pickMimeType()`。整合點在 `listen.js` 的 Phase 3 跟讀空白
  (`listen.js:543-555`)，只在 `playbackMode==='normal'` 且頁面前景時才啟用。
- UI：跟讀空白階段旁邊加「▶ 播我的錄音」「▶ 老師原音」兩個按鈕做 A/B。
- **不存錄音**：Blob 只存在 in-memory（掛在 `state.listen` 底下不持久化的
  runtime 欄位——`saveState()` 白名單本來就沒有 `listen`，天然不會寫進
  localStorage）。切下一張卡、離開聽力模式、或 App 背景化時
  `URL.revokeObjectURL()` 釋放，連裝置儲存空間都不占用。
  `visibilitychange` 自救邏輯(`listen.js:703-725`)要補一行：錄音中切走 App
  時主動 `stopRecording()`，避免麥克風常駐佔用。

**建議**：先花半天做一個獨立測試頁（不進主 app），在 Nalin 的 iPhone 上
（PWA standalone 模式，加到主畫面後開啟）測試 (a) `getUserMedia` 是否跳權
限框、(b) 是否每次都要重新授權、(c) 錄完的 Blob 能不能正常回放。通過再投入
1-2 天正式整合 `mic-record.js` + `listen.js`，避免在「iOS PWA 環境根本不給
錄」這種最壞情況上白花時間。

- 要新增/修改的檔案：`src/mic-record.js`（新增）、`src/listen.js`（Phase 3
  掛錄音、UI 按鈕、鎖屏模式排除）、`sw.js`（`SHELL` 加一行）。
- 對音訊管線衝突風險：**中-高**，但用「鎖屏模式隔離」+「獨立 audio
  element」兩個設計決策可控。Android 藍牙耳機情境下麥克風佔用是否會觸發系
  統音訊路由切換，建議實機測試驗證（尤其 Nalin 平常戴耳機聽力複習的使用情
  境），不是靠讀文件能保證的。
- 複雜度：中-高。演算法本身簡單，風險完全集中在環境相容性。

## 共通收尾提醒

任何新增 `src/*.js` 都要記得把 `sw.js` 的 `SHELL` 陣列跟 `CACHE` 版本號一起
更新——這個專案已經因為忘記升版號讓已安裝 PWA 吃不到更新，犯過兩次
（見 `000_Agent/memory/feedback_sw_cache_version.md`）。

## 額外成本

四項全部**不需要任何新的付費 API 或第三方服務**：

- 方向 1 錄音比對明確排除自動語音辨識/發音評分，只用瀏覽器原生
  `MediaRecorder`（免費、無 API key）。
- 方向 2 SRS 優化是純本地演算法調整，不涉及外部服務。
- 方向 3 數據呈現、方向 4 成就系統都是純本地 localStorage 資料計算，沒有網
  路請求。
- 唯一潛在成本是方向 1 若選擇保留錄音會佔用裝置儲存空間——但設計上明確採
  用「session 內即丟棄、不寫入 localStorage/IndexedDB」，所以連這個都是零
  成本。

## 不動的部分（刻意排除，避免範圍蔓延）

- 本次規劃**不寫任何 `src/*.js`、`sw.js`、`data.json`、`styles/*` 的程式碼
  改動**，只有這份文件本身。
- 雲端同步（Nalin 沒有選這個落差方向，不在本次分析範圍內）。
- FSRS 完整導入（方向 2 已決策不做，原因見上）。
- 聲調自動評分/語音辨識（方向 1 已明確排除，原因見上）。
- XP 數值系統（方向 4 已決策不做，原因見上）。

## 涉及檔案（未來實作時）

- `src/srs.js`、`src/card.js`、`src/state.js`、`styles/components.css`（方向 2）
- `src/stats.js`（新增）、`src/today.js`（方向 3）
- `src/achievements.js`（新增）、`src/today.js`（方向 4）
- `src/mic-record.js`（新增）、`src/listen.js`（方向 1）
- `sw.js`（四個方向新增檔案都要跟著更新 `SHELL` + `CACHE` 版本號）
