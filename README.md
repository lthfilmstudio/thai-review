# 泰文複習 PWA

純 HTML/CSS/JS（零建置工具、零 `npm install` — 唯一例外是 `src/vendor/soundtouch.js`，一支手動 vendor 進來的第三方 DSP 函式庫原始檔，用於保留音高的泰文變速播放，檔頭附授權與來源標示）的泰文學習 PWA。兩大模式：字卡、被動聽力。支援離線、鎖屏長音檔背景播放、響應式（手機 / iPad / 桌面）。

資料源是 Google Sheets，用 publish-to-web 取 CSV；每個 worksheet 當一堂課。正式站部署在 Cloudflare Pages，Production 需要直接跑 `wrangler pages deploy`，`git push` 本身不會更新正式站。

## 快速開始

### 本機預覽

因為用了 ES modules + Service Worker，不能直接 `file://` 開，需要 HTTP 伺服器：

```bash
# 方式 1：Python 內建
cd thai-review
python3 -m http.server 8080
# 開 http://localhost:8080

# 方式 2：Node（如果裝了）
npx serve .
```

### 放你的 Google Sheet

有兩種方式。

**方式 A（推薦，多課程）：發佈整份 Sheet**
1. Google Sheets → 檔案 → 分享 → 發佈到網路
2. **選「整個文件」**（不是單一工作表），格式任意
3. 按「發佈」，複製產生的網址（形如 `https://docs.google.com/spreadsheets/d/e/2PACX-xxx/pubhtml`）
4. App 裡點右上角 ⚙ → 貼進「Google Sheet 網址或 ID」→ 儲存
5. App 會自動列出每個 tab 當一堂課

**方式 B：逐一貼 CSV 網址（每行一個）**
1. 逐一把每個 tab 發佈成 CSV（output=csv）
2. 多行貼進設定（一行一個 URL），每個 URL = 一堂課

**方式 C：單一 CSV，靠 `lesson` 欄分課**
1. 一張工作表，加一欄 `lesson`，每筆資料填課程名
2. 發佈那張為 CSV，把 URL 貼進設定

### CSV 欄位格式

欄位名中英文皆可（大小寫無差），第一個命中的 header 就用：

| 語意 | 必要 | 可用欄名（擇一） |
|---|---|---|
| 泰文原文 | ✅ | `泰文` / `thai` / `th` |
| 拼音（含聲調） | ✅ | `泰式Karaoke拼音` / `拼音` / `karaoke` / `pronunciation` |
| 中文翻譯 | ✅ | `中文` / `中文翻譯` / `翻譯` / `zh` / `chinese` |
| 類型（word/sentence） | - | `類型` / `type` |
| 備註 | - | `備註` / `note` |
| 音檔 URL | - | `音檔` / `audio_url` |
| 課程名（方式 C 必填） | - | `課程` / `課` / `堂` / `lesson` |

## 音訊與部署

泰文主聲音優先使用已烘好的 ElevenLabs MP3：`out/site-preview/audio-manifest.json` 加上 `out/site-preview/audio/jessica-v1/*.mp3`。中文提示優先使用每堂課預烤的 zh sprite：`out/site-preview/zh-manifest.json` 加上 `out/site-preview/audio/zh-tw/*`。缺中文 sprite 時前端會 fallback 到 Worker TTS；缺泰文 baked MP3 則不能部署。

部署前先跑安全 dry-run，不會呼叫付費 API：

```bash
scripts/update-audio-deploy.sh
```

若 dry-run 顯示泰文 MP3 缺檔，再明確加上付費 API 確認產生缺檔：

```bash
scripts/update-audio-deploy.sh --generate --confirm-paid-api
```

正式部署：

```bash
scripts/update-audio-deploy.sh --deploy
```

`--deploy` 會檢查泰文 MP3 缺檔為 0、跑 Node 測試、重建 `out/pages-deploy`、寫入 `deploy-info.json`、部署 Cloudflare Pages，最後 read-back 線上的 `sw.js`、`data.json`、`zh-manifest.json`、`audio-manifest.json`、`deploy-info.json` hash，確認 deployment package 跟線上內容一致。部署成功時也會印出一行 `DEPLOY_SUMMARY_JSON=...`，給 log / automation 直接解析 deployment URL、source commit、SW cache、資料時間與 asset hashes。

## 功能

### 字卡模式（字卡）
- 正面泰文、背面拼音 + 中文 + 備註
- 點卡片翻面（3D 翻牌，0.85s 曲線）
- 背面「聽真人」按鈕 → 新分頁開 YouGlish Thai 找真人影片發音
- 三顆評估按鈕：不熟 / 普通 / 會了（存 localStorage）
- 手機：左右滑切卡
- 桌面鍵盤：`←` `→` 切卡、`Space` 翻面、`1` `2` `3` 評估、`P` 播放、`S` 隨機
- 右上 🔀 按鈕（或 `S`）隨機打亂當前課程；評分以泰文字串當 key 存，打亂後進度不會亂

### 反向模式（反向）
- 正面中文（+ 備註）、背面泰文 + 拼音
- 其他操作同字卡模式

### 被動聽力模式
- 自動循環：中文提示一次 → 老師泰文 → 跟讀空白 → 重複泰文 + 跟讀 N 次 → 下一張
- 自動跟讀時間：至少 1.5 秒，長句依老師實際播放時間 × 1.8 動態延長
- 可設定：重複次數（1–5）、跟讀間隔（自動 / 1–4 秒）
- 一般模式會把單張卡的「中文 + 泰文 + 跟讀空白」先拼成一段音檔，降低背景播放被中斷的機率
- **鎖屏背景播放**：先把一批卡拼成一條長 WAV，一次播放；播放中支援暫停續播、上 / 下一張 seek、下一批預拼接續
- 鎖屏會顯示當前卡片資訊，支援播放 / 暫停 / 上下卡控制
- 設定頁會顯示 App cache、source commit、部署時間、`data.json` 時間與 `zh-manifest.json` 時間；點版本資訊可展開聽力 log

### 主題
- 自動跟隨系統（`prefers-color-scheme`）
- 可在設定手動鎖定深色 / 淺色
- 深色：泰絲風（`#0F1814` 底 + 泰金 `#C4A574`）
- 淺色：米白底 + 深墨綠文字

## 已知限制

1. **Cloudflare Access**：正式網域在 Access 後面，命令列 `curl https://thai-review.lthfilmstudio.com/` 看到 302 登入導向是正常的；部署真相用 `wrangler pages deployment list --project-name thai-review` 或 deployment URL read-back。
2. **部署資產在 ignored `out/`**：MP3、manifest、zh sprite 不進 Git；正式部署前必須用 `scripts/update-audio-deploy.sh` 檢查並重建 `out/pages-deploy`。
3. **中文 sprite 可缺料但會 fallback**：`zh-manifest.json` 若有 stale lesson，前端會 fallback 到 Worker TTS；泰文 baked MP3 缺檔則 deploy 腳本會拒絕上線。
4. **iOS 鎖屏播放**：Media Session 顯示 OK，但音訊 session 仍可能被 OS 回收；Android 目前以長音檔鎖屏模式為主路徑。
5. **發佈整份 Sheet 的 pubhtml 解析**：Google 改版時可能動 HTML 結構，若壞了 fallback 成方式 B/C。

## 專案結構

```
thai-review/
├── index.html                  # 入口
├── manifest.webmanifest        # PWA manifest
├── sw.js                       # Service Worker
├── src/
│   ├── app.js                  # 入口、事件綁定
│   ├── state.js                # 狀態 + localStorage
│   ├── data.js                 # Sheet / CSV 抓取
│   ├── card.js                 # 字卡 / 例句 render
│   ├── listen.js               # 被動聽力 + Media Session
│   ├── listen-lock.js          # 鎖屏長音檔拼裝
│   ├── listen-static.js        # 靜態音檔與鎖屏 timeline 純函式
│   ├── zh-sprite.js            # 中文 sprite manifest / timing 查找
│   ├── tts.js                  # baked MP3 / Worker TTS / browser fallback
│   └── ui.js                   # 共用 render（sidebar / modal / 主題）
├── scripts/
│   ├── gen-audio.py            # ElevenLabs 泰文 MP3 生成 / dry-run
│   ├── gen-zh-audio.py         # GCP 中文 sprite 生成 / dry-run
│   └── update-audio-deploy.sh  # audio dry-run / deploy / read-back 驗證
├── tests/                      # Node 與 Python 回歸測試
├── styles/
│   ├── base.css                # reset + 變數 + 字體
│   ├── layout.css              # 響應式、sidebar、drawer
│   └── components.css          # 卡片、pill、listen、modal
├── icons/                      # PWA icons（_build.py 生）
└── README.md
```

## 重新產 icons

改了 icon 設計想重產：

```bash
cd icons
python3 _build.py
```

需要 macOS 系統字體 `Ayuthaya.ttf` 或 `ThonburiUI.ttc`。
