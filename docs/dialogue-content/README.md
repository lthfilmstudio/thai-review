# Phase 3 對話素材

`phase3-dialogue-draft.tsv` 是 Nalin 核准的第一批素材，共 10 組、每組 6 句。

- 泰文、目的達拼音、中文逐句取自本 repo 根目錄的 [`data.json`](../../data.json)（見 `data.json:1`），沒有自行造句。
- TSV 最後一欄「來源課次」只供追溯，不寫進 App 資料。
- 正式資料已寫入課程 Google Sheet 的「生活對話」分頁，只保留前 7 欄：情境 ID、情境名稱、順序、說話者、泰文、目的達拼音、中文。
- App 端會驗證每組必須完整 6 句、順序 1–6，並由 A／B 交替各說 3 句；同步失敗時不覆蓋既有完整 `data.json`。
