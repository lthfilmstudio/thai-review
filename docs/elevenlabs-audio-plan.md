# ElevenLabs 靜態泰文 MP3 計劃

## 已定決策

- 範圍：只烘焙泰文原文，中文提示繼續走現有 GCP `cmn-TW-Wavenet-A`。
- Voice：`Jessica - Playful, Bright, Warm`
- Voice ID：`r1KmysJdVYZjJCm4mL3b`
- Model：`eleven_v3`
- Output：`mp3_44100_128`
- 語言：`th`
- 預設音檔路徑：`audio/jessica-v1/<key>.mp3`

Nalin 已用 ElevenLabs 網頁試聽確認：泰文要選 Eleven v3 才能正確發音。

## 成本基準

目前 `data.json` 盤點：

- 課程：39 堂
- 泰文卡片：11,694 張
- 去重後泰文字串：8,567 筆
- 去重後泰文字元：110,067

用 ElevenLabs API pricing `US$0.10 / 1,000 characters` 估算：

- 全站泰文去重一次：約 `US$11.01`
- 加 10% 緩衝：約 `US$12.11`
- 每新增 1 課粗估：約 `US$0.28`

注意：Free plan 不能透過 API 使用 Voice Library voices。正式生成需要付費方案或可用的付費 API 權限。

## Dry-run

Dry-run 完全不呼叫 ElevenLabs：

```bash
python3 scripts/gen-audio.py --dry-run
```

需要給 workflow 或其他工具讀取時：

```bash
python3 scripts/gen-audio.py --dry-run --json
```

dry-run 會做：

- 讀 `data.json`
- 收集 unique 泰文字串
- 依 `model_id + voice_id + output_format + language_code + text` 產生 key
- 檢查 `audio-manifest.json` 內已存在的 key
- 回報缺檔數、缺檔字元數、預估費用

## Generate 模式

腳本已有生成框架，但只有在明確加上付費確認與字元上限時才會呼叫 ElevenLabs：

```bash
ELEVENLABS_API_KEY=... python3 scripts/gen-audio.py \
  --generate \
  --confirm-paid-api \
  --limit 5 \
  --max-chars 500
```

安全規則：

- 沒有 `--confirm-paid-api` 就拒絕。
- 沒有 `--max-chars` 就拒絕。
- 沒有 `ELEVENLABS_API_KEY` 就拒絕。
- `--limit 0 --max-chars 0` 可以驗證生成模式的 no-op 路徑，不會打 API。
- 音檔預設寫入 `out/audio/jessica-v1/`，`out/` 已被 `.gitignore` 忽略。
- Manifest 預設寫入 `audio-manifest.json`。

正式付費生成前，先跑小量：

```bash
python3 scripts/gen-audio.py --dry-run
ELEVENLABS_API_KEY=... python3 scripts/gen-audio.py --generate --confirm-paid-api --limit 5 --max-chars 500
```

確認 5 個 MP3 正常後，再分批提高 `--max-chars`。

## Manifest 草案

正式生成後的 `audio-manifest.json` 建議格式：

```json
{
  "version": 1,
  "generated_at": "2026-06-26T18:00:00+08:00",
  "spec": {
    "provider": "elevenlabs",
    "voice_name": "Jessica - Playful, Bright, Warm",
    "voice_id": "r1KmysJdVYZjJCm4mL3b",
    "model_id": "eleven_v3",
    "language_code": "th",
    "output_format": "mp3_44100_128",
    "audio_prefix": "audio/jessica-v1"
  },
  "items": {
    "<key>": {
      "path": "audio/jessica-v1/<key>.mp3",
      "chars": 17,
      "first_lesson": "初 1",
      "generated_at": "2026-06-26T18:00:00+08:00"
    }
  }
}
```

key 的內容要包含 model 和 voice。未來如果換 voice 或模型，可以開新的 audio prefix，不會混到舊音檔。

## 下一階段安全條件

接 API 生成前，腳本已要求：

- 明確參數：`--generate`
- 明確確認：`--confirm-paid-api`
- 單次上限：`--max-chars`
- 小量測試：先用 `--limit 5`
- 失敗即停：遇到 402 / 401 / 429 / 5xx 不重試燒 credits

正式生成流程應該先跑：

```bash
python3 scripts/gen-audio.py --dry-run
```

Nalin 確認成本後，再跑生成。
