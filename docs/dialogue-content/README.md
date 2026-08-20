# Phase 3 對話素材審核

`phase3-dialogue-draft.tsv` 是第一批人工審核稿，共 10 組、每組 6 句。

- 泰文、目的達拼音、中文逐句取自目前 production 使用的 `data.json`，沒有自行造句。
- 對話編排、語氣與情境自然度仍須由 Nalin／泰文老師確認；若不自然，先標記要換的整句，不直接局部改泰文。
- TSV 最後一欄「來源課次」只供審核追溯。核准後寫入 Google Sheet 新分頁時，只保留前 7 欄：情境 ID、情境名稱、順序、說話者、泰文、目的達拼音、中文。
- 這一階段尚未寫入 Google Sheet，也未呼叫 ElevenLabs 或 GCP 付費 API。
