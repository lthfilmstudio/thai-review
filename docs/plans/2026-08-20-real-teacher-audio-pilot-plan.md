# 課堂真人語音試點計劃（取代／補強「聽真人」YouGlish）

## 背景

`card.js` 背面的「聽真人」（`youglishUrl()`，`card.js:20-24`）目前是外連 YouGlish，
單詞查得到、整句常常查不到——這是外部字典型服務的先天限制，不是這個 App 能修的。

Nalin 手上每一堂課都有錄影 MP4，2026-08 起改用 ElevenLabs Scribe 做課堂逐字稿
（[[thai_class_transcription_elevenlabs]]），順手核實過 Scribe 回傳的
`words` 陣列**每個字都有 `start`/`end` 秒數，還有 `speaker_id`**（不是只有整句
時間戳，也有講者分離）。這代表可以直接從課堂錄音裡切出「老師講這句的那一段」，
播放真正的課堂原音，而且能排除同學跟讀練習的聲音。

**這跟 2026-05-02 放棄的 Stage 3（原音跳播放）是同一個想法，但條件變了**：
Stage 3 當時卡在 Gemini 辨識能力不夠、給不出可靠時間戳，才放棄
（見 [[thai_review_pwa]] 「Stage 3 原音跳播放放棄」）。現在換成 Scribe，
字元級時間戳＋講者分離都是現成的，值得重新評估。

## Spike 結果（已完成，2026-08-20）

用最新一堂課「中 2-4」（job `260814`，data.json `lessonId=gid-1786078251`，
296 張卡）做過一輪陽春驗證：把 Scribe `words` 依 `speaker_id` 分別拼接成字串，
挑「總發言時長最長」的講者當老師，對每張卡的 `thai` 欄位做精確子字串比對。

- **89.2%（264/296）在老師的發言裡精確命中**，每個都能推回精準到 0.01 秒的
  起訖時間戳。
- **3.4%（10/296）有出現在逐字稿裡，但講者不是老師**——是同學跟讀練習句
  （例如帶男女敬語變化的例句），證實了「一定要排除非老師講者」這個顧慮是
  對的，不篩會把學生發音誤當範例播出去。
- **7.4%（22/296）完全找不到**，多是投影片例句，老師顯然沒有逐字唸出來，
  這批本來就該 fallback 回現有 YouGlish。

比對演算法是最陽春的精確子字串比對，還沒處理老師換句話說、口誤重來、標點
差異——正式做的話命中率應該還能再往上一點，但這不是這次試點要解決的事。

## 這次的範圍：只做「中 2-4」試點

**先把管線做完整、跑一堂課、Nalin 實際聽過確認品質，OK 才考慮往回補其他
43 堂課。** 這條界線很重要，因為：

- 早期課次的字卡是 Nalin 自己用 Gemini 慢慢整理出來的（跟現在 Scribe 管線
  的資料源頭不同），要不要／怎麼補是下一輪的決定，這次不動。
- 一次只處理一堂課，出錯範圍小、Nalin 抽查的工作量也可控。

腳本會用 `--job`／`--lesson` 參數把處理範圍鎖死在單一課次，不支援「全部課次
一次跑」，避免之後不小心跑到全部 47 堂。

## 資料管線設計

沿用專案既有的 **zh sprite 架構**（`scripts/gen-zh-audio.py` + `src/zh-sprite.js`，
已經是跑很穩的成品）：整堂課切出來的真人語音片段合輯成一個 mp3 sprite +
時間表 JSON，前端整檔 decode 一次、按毫秒切片播放，不是每張卡一個獨立小檔案
（避免這個專案已經有過的「CF KV write 超標」「每卡都打 API」那類教訓，見
[[thai_review_pwa]] zh sprite 段落）。

### 新腳本：`scripts/build-real-audio.py`

**純本機處理，不呼叫任何付費 API**（跟 ElevenLabs TTS／GCP TTS 那兩條付費管線
完全無關，不需要走費用揭露流程）——這點值得先跟 Nalin 說清楚，因為這個專案
的付費揭露習慣很重，這次沒有東西要揭露反而該講一聲避免誤會。

用法：`python3 scripts/build-real-audio.py --job 260814 --lesson "中 2-4" --out-dir out/site-preview`

步驟：
1. 讀 `out/class-transcriptions/260814/scribe/260814-{1,2}.json`（已存在，
   不用重新呼叫 Scribe）。
2. 每個 part 各自算「哪個 `speaker_id` 總發言時長最長」當老師（**用發言時長
   加總，不是 token 數**——比 token 數更能抵抗切字粒度不一致的問題）。
3. 依 `speaker_id` 把 `type=="word"` 的 token 依序拼接成字串（跳過
   `type=="spacing"`），同時保留「拼接字串位置 → 原始 token」的對照表，
   跟 spike 腳本邏輯一致。
4. 讀 `data.json` 裡 `lessonId=gid-1786078251` 這堂課的卡片清單，對每張卡的
   `thai` 欄位做精確子字串比對（兩個 part 都試）：
   - 命中：記下 `(part, startMs, endMs)`；同一句在老師發言裡出現超過一次時，
     取**第一次出現**，並把這張卡記進「多重命中」清單供人工抽查特別注意。
   - 沒命中：記進「無真人音檔」清單，App 端自動 fallback 回 YouGlish，
     腳本端不用特別處理。
5. **切點加緩衝、夾在鄰近字的邊界內**：起點往前留
   `min(120ms, 前一個 token 結束到這個 token 開始的間隔)`，
   終點往後留 `min(150ms, 這個 token 結束到下一個 token 開始的間隔)`——
   避免補太多喇進去鄰近字（甚至鄰近講者）的聲音，也避免完全不留白讓字頭
   字尾被切斷。
6. **音訊處理沿用 `gen-zh-audio.py` 的 `decode_to_pcm`／`encode_part` 模式**：
   對每個 part 的來源 MP4（`/Volumes/SN850X-8T/Resolve/1-Thai/260814-{1,2}.mp4`）
   只完整 decode 一次成 PCM（-vn 去畫面），再用算好的樣本區間切片組合，
   不要對每個片段各自重新 `ffmpeg -i` 一次（那樣對 280 個片段、90 分鐘
   來源會很慢）。
7. 把命中的片段依卡片在 Sheet 裡的原始順序串接，24kHz mono 輸出，超過 240
   秒分片（跟 zh sprite 一樣的手機 decode 記憶體考量），寫進
   `out/site-preview/audio/real-tw/gid-1786078251-<hash8>-p<n>.mp3`。
8. 寫時間表 `out/site-preview/audio/real-tw/gid-1786078251-<hash8>-timing.json`：
   ```json
   { "items": { "<泰文原文>": [fileIdx, startMs, durMs] } }
   ```
   （key 用原始 `thai` 文字，範圍限定在單一課次的 timing 檔內，跟
   `lookupZhSegment()` 現有慣例一致，不用另外發明 cardKey 當 key。）
9. 寫／更新 `out/site-preview/real-manifest.json`：
   ```json
   { "generated_at": "...", "lessons": { "gid-1786078251": { "hash": "...", "timing": "audio/real-tw/....json" } } }
   ```
10. **另外輸出一份人工抽查用的 QA 頁**（見下一節），不進正式部署，跑完腳本
    印出本機檔案路徑，Nalin 直接雙擊開瀏覽器聽。

`real-manifest.json`／`audio/real-tw/*` 都只活在 `out/`（gitignore 排除，
build artifact，跟 `zh-manifest.json` 同待遇），不進 git、不需要跟著
`data.json` 一起被 GitHub Action 同步。

## 人工抽查關卡（上線前的品質閘門）

這條管線跟 Sheet 內容審核管線的風險點不一樣：**文字內容本來就是 Nalin 已核准
過的字卡，這裡沒有「文字對不對」的問題，風險在「切出來的聲音好不好聽」**——
會不會切到字頭字尾、有沒有夾到雜音或鄰近講者的尾音、多重命中選到的那次是不是
講得清楚的那次。這件事只有耳朵聽得出來，不能用測試自動驗證。

腳本額外產出一支**丟即用的獨立 QA 頁**（`out/site-preview/real-audio-qa.html`，
不進部署、聽完即刪，做法比照之前 Roughcut tracker 的 dev-harness 頁模式——
見 [[feedback_tracker_ui_verify_harness]]）：列出這堂課所有命中的卡片
（泰文／中文／inline `<audio>` 播放鍵），多重命中的卡片特別標記。

**驗收方式**：Nalin 本機開這支 QA 頁，抽聽一輪（不用全聽 264 個，抓多重命中
的、抓幾個隨機的），覺得切點乾淨、聽感對，才進下一步接進正式 App；覺得
padding 不對就回頭調整第 5 步的緩衝參數重跑，不用重新 decode 整堂課音軌
（PCM 中繼結果可以先存成暫存檔重複利用，調參數只需要重切）。

## 前端整合

- 新檔 `src/real-audio.js`，比照 `src/zh-sprite.js` 拆「純函式」（可測）跟
  IO（decode/fetch，放進 `tts.js` 或獨立小檔）：
  - `buildRealAudioIndex(manifest)` → `Map(lessonId → {hash, timing})`
  - `lookupRealSegment(timing, thaiText)` → `{fileIdx, startMs, durMs} | null`
  - 切片沿用 `zh-sprite.js` 現成的 `sliceRange()`，不用重寫。
- `card.js` 背面新增一顆按鈕（暫定「🔊 課堂原音」，SVG 線稿圖示、非 emoji，
  沿用專案 UI 慣例），**只在這張卡在目前課次有真人音檔命中時才顯示**；
  **YouGlish「聽真人」保留不動、不移除**——兩者並存，真人課堂音是新增的
  優先選項，YouGlish 繼續當查不到時的後備／單詞查字典用途。
  > 這個「並存不取代」是我的預設建議，不是唯一答案：如果你聽過 QA 頁後
  > 覺得課堂原音品質夠好，也可以之後改成「有真人音檔就直接取代 YouGlish
  > 按鈕位置」，UI 改動很小，先留兩顆是比較保守、不動既有功能的做法。
- `sw.js` `CACHE` 版本號 +1、`SHELL` 陣列加 `src/real-audio.js`（改
  `src/*.js` 一定要跟著升版號的既有教訓，[[feedback_sw_cache_version]]）。

## 測試計畫

- `tests/real_audio_test.py`（或加進既有 `gen_audio_test.py` 旁邊）：老師
  講者判定（用假造的 words 陣列跑「總時長最長」邏輯）、padding／clamp 算法、
  多重命中偵測、缺料 fallback。
- `tests/real_sprite.test.mjs`：`lookupRealSegment()` 純函式測試，比照
  `tests/service_worker.test.mjs` 現有 `lookupZhSegment`／`sliceRange` 測試
  案例的寫法。
- 手動驗證：本機 `python3 -m http.server` 開 `index.html`，切到「中 2-4」，
  翻卡確認新按鈕出現／播放／沒命中的卡片維持原本 YouGlish 行為不變。

## 明確排除（這次不做）

- 不處理其他 43 堂課的回補——等這堂課 Nalin 聽過覺得 OK 才回頭規劃。
- 不做「老師換句話說／近似句」的模糊比對，只吃精確子字串命中，其餘一律
  fallback YouGlish。
- 不碰 `listen.js` 自動播放／鎖屏播放管線——這是完全獨立的手動按鈕功能，
  不共用那條已經踩過很多雷、很脆弱的音訊鏈（[[thai_review_pwa]] 自動播放
  各版本踩雷紀錄）。
- 不動 `start_ms`／`end_ms`／`audio_url` 這幾個 Sheet 既有但沒在用的欄位
  （那是舊 Stage 3 規劃留下的，資料源頭跟意圖都跟這次不同，混用只會製造
  混淆，這次的時間戳完全走獨立的 `real-manifest.json`）。

## 待你拍板的點（不擋開工，先問避免做完才改）

1. 新按鈕跟 YouGlish 並存，還是有真人音檔就直接取代？（預設：並存）
2. Padding 數字（起點 120ms／終點 150ms）要不要先接受，等 QA 聽過再微調？
3. 「中 2-4」這堂課的來源 MP4 確認是
   `/Volumes/SN850X-8T/Resolve/1-Thai/260814-{1,2}.mp4`（跟 job `260814`
   同一批），沒有另外重新剪過的版本？

## 驗收條件

1. `scripts/build-real-audio.py --job 260814 --lesson "中 2-4"` 能重複執行，
   輸出 `real-manifest.json` + sprite mp3 + timing json + QA 頁。
2. QA 頁本機開啟，Nalin 抽聽後確認切點乾淨、沒有明顯雜音／截斷。
3. `node --test` 與 `python3 -m unittest` 新增測試全綠，既有測試不回歸。
4. 本機瀏覽器驗證「中 2-4」課次卡片背面新按鈕正確顯示／播放，沒命中的卡
   維持原本 YouGlish。
5. 這階段**不需要**跑 `update-audio-deploy.sh --deploy`——先在本機／QA 頁
   驗證完，Nalin 拍板要正式上線才進下一輪部署，這份文件不涵蓋部署步驟。
