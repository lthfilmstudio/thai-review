# 泰文複習 — Stage 1 PWA

純 HTML/CSS/JS（零 npm 依賴）的泰文學習 PWA。三大模式：字卡、例句、被動聽力。支援離線、鎖屏背景播放、響應式（手機 / iPad / 桌面）。

資料源是 Google Sheets，用 publish-to-web 取 CSV；每個 worksheet 當一堂課。

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

| 欄名 | 必要 | 說明 |
|---|---|---|
| `thai` | ✅ | 泰文原文 |
| `karaoke` | ✅ | 拼音（含聲調，如 `sà-wàt-dee kráp`） |
| `zh` | ✅ | 繁體中文翻譯 |
| `type` | - | `word` 或 `sentence`（預設 `word`） |
| `note` | - | 備註（口語、男/女用...） |
| `lesson` | - | 課程名（方式 C 必填） |
| `audio_url` | - | 音檔 URL（Stage 1 選用） |
| `start_ms` / `end_ms` / `audio_file` | - | Stage 3 接老師原音用 |

## 部署到 GitHub Pages

```bash
# 1. 初始化 git（如果還沒）
cd thai-review
git init -b main
git add .
git commit -m "init: Thai review PWA Stage 1"

# 2. 建 GitHub repo（建議名：thai-review），然後：
git remote add origin git@github.com:<你的帳號>/thai-review.git
git push -u origin main

# 3. GitHub 網站 → Settings → Pages
#    Source: Deploy from a branch
#    Branch: main / root
# 幾秒後會得到網址：https://<帳號>.github.io/thai-review/
```

## 功能

### 字卡模式
- 點卡片翻面（3D 翻牌，0.85s 曲線）
- 三顆評估按鈕：不熟 / 普通 / 會了（存 localStorage）
- 手機：左右滑切卡
- 桌面鍵盤：`←` `→` 切卡、`Space` 翻面、`1` `2` `3` 評估、`P` 播放

### 例句模式
- 同字卡但只出 `type=sentence`

### 被動聽力模式
- 自動循環：老師語音 → 金色進度條 → 跟讀空白（灰色進度條）→ 重複 N 次 → 下一張
- 可設定：重複次數（1–5）、跟讀間隔（自動 / 1–4 秒）
- **鎖屏背景播放**：用 Media Session API + 靜音 audio loop 維持 session
- 鎖屏會顯示當前卡片資訊，支援播放 / 暫停 / 上下卡控制

### 主題
- 自動跟隨系統（`prefers-color-scheme`）
- 可在設定手動鎖定深色 / 淺色
- 深色：泰絲風（`#0F1814` 底 + 泰金 `#C4A574`）
- 淺色：米白底 + 深墨綠文字

## 已知限制

1. **TTS 是瀏覽器內建**：`speechSynthesis` 泰文發音品質看平台（macOS 最好、Android 其次、iOS 一般）。Stage 3 會改成跳播老師原音。
2. **Safari 語音載入**：第一次 `getVoices()` 可能為空，已加 `voiceschanged` 監聽。
3. **iOS 鎖屏播放**：Media Session 顯示 OK，但音訊 session 偶爾會被 OS 回收。App 用一條極短靜音 loop 盡量維持。
4. **發佈整份 Sheet 的 pubhtml 解析**：Google 改版時可能動 HTML 結構，若壞了 fallback 成方式 B/C。

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
│   ├── tts.js                  # speechSynthesis 封裝
│   └── ui.js                   # 共用 render（sidebar / modal / 主題）
├── styles/
│   ├── base.css                # reset + 變數 + 字體
│   ├── layout.css              # 響應式、sidebar、drawer
│   └── components.css          # 卡片、pill、listen、modal
├── icons/                      # PWA icons（_build.py 生）
└── README.md
```

## 後續計畫

Stage 1（這版）→ Stage 2（Cloudflare Workers 代理 AssemblyAI + Gemini 處理錄音）→ Stage 3（時間戳跳播老師原音）。詳見上層資料夾的 `handoff-doc.md` 與 `thai-flashcards-decision-memo.md`。

## 重新產 icons

改了 icon 設計想重產：

```bash
cd icons
python3 _build.py
```

需要 macOS 系統字體 `Ayuthaya.ttf` 或 `ThonburiUI.ttc`。
