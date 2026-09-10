# 中文分頁：先聽再看中文（設計）

2026-09-10 23:00 Asia/Taipei，Nalin 拍板。

## 目的

「中文」分頁現在正面直接顯示中文、背面是泰文。改成先用耳朵聽泰文，想看才打開中文，最後翻面看泰文字。

## 範圍

- 只改 `state.mode === 'reverse'`（「中文」分頁）的**正面**。
- 背面維持現有設計（泰文 + 拼音 + 播放 / 課堂原音 / 聽真人 / 造 3 句 / 編輯），一行不動。
- 「泰文」分頁（`card`）、「開始複習」（`srs`）、自動播放（`listen`）不受影響。
- 實作在正式站分支 `codex/hybrid-mastery-release`（worktree `thai-review-worktrees/ledger-runtime`）。

## 流程

| 階段 | 正面畫面 | 下一步 |
|---|---|---|
| ① 中文蓋著 | 大的播放鈕（唸泰文）＋下方「顯示中文」按鈕＋ TAP CARD TO FLIP | 按「顯示中文」→ ②；點卡片 → ③ |
| ② 中文打開 | 播放鈕留著；「顯示中文」按鈕位置換成中文（含 note），**原地 fade in，不翻面** | 點卡片 → ③ |
| ③ 背面 | 現有設計 | 點卡片翻回正面，中文維持打開 |

規則：

- 換到別張卡（上一張 / 下一張 / 評分 / 滑動 / 跳卡）→ 中文重新蓋住。
- 不自動播放，按播放鈕才唸。
- 不按「顯示中文」也能直接翻面；評分鈕隨時可按。
- 鍵盤沿用：`P` 播放、Space 翻面。「顯示中文」不加快捷鍵。

## 做法

- **狀態**：`state.zhRevealedKey` 存「中文被打開的那張卡的 `_cardKey`」。正面是否顯示中文 = `state.zhRevealedKey === card._cardKey`。換卡時 key 對不上，自然蓋回去，不用去改 `app.js` 裡十幾處 `state.flipped = false`。不寫進 localStorage。
- **為什麼不只存在 DOM**：`renderCardMode` 會因課堂原音索引預載、雲端同步等原因重畫，只存 DOM 的話中文會被莫名蓋回去。
- **fade in**：只有按下「顯示中文」那一下才加動畫 class（opacity 0→1，約 0.25 秒），不整張重畫；重畫時若已打開，直接顯示、不再播動畫。
- **播放鈕**：呼叫既有 `speakCard(card)`，跟背面播放鈕同一條路徑。
- **翻面排除**：正面播放鈕與「顯示中文」按鈕加進 `cardStage` click handler 的排除清單，按了不翻面。
- **檔案**：`src/card.js`（`frontBody` reverse 分支 + 事件）、`src/state.js`（新增欄位）、`styles/components.css`（正面播放鈕尺寸、fade in）、`sw.js`（CACHE 升 v102）。

## 驗收

1. 單元測試（沿用 `tests/card_audio.test.mjs` 的假 DOM 寫法）：reverse 正面初始 HTML 不含 `card.zh`；設 `zhRevealedKey` 後含 `card.zh`；換 `cardIndex` 後不含。`card` mode 正面不受影響。
2. 全套 Node / Python 測試通過。
3. 本機瀏覽器實際點一輪（① → ② fade in → ③ → 翻回 → 換卡蓋回），截圖給 Nalin。
4. 部署正式站前先問 Nalin。
