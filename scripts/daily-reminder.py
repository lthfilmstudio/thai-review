#!/usr/bin/env python3
"""
daily-reminder.py — Phase 0.5 每日提醒：推「今日一句」到 Telegram。

跟 App 完全解耦：讀本 repo 的 data.json（sync-sheet.py 每 30 分鐘更新），不碰線上 App
（CF Access 後面外部抓不到），也不重新讀 Sheet——data.json 本來就在 checkout 裡。

挑句規則（docs/superpowers/specs/2026-08-19-solo-daily-game-design.md §5.3）：
從最新一堂課開始，找泰文字元數 >= MIN_THAI_CHARS 的卡當「整句」；該堂沒有就往上一堂找。
同一天多次觸發（含手動 workflow_dispatch）選到同一句：用「日期 + 課程 id」當 seed，
不用真隨機，方便重跑除錯。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_JSON = Path(__file__).resolve().parent.parent / "data.json"
APP_URL = "https://thai-review.lthfilmstudio.com/"
MIN_THAI_CHARS = 15
TAIPEI = timezone(timedelta(hours=8))
THAI_CHAR_RE = re.compile(r"[฀-๿]")  # 泰文 Unicode 區塊


def thai_char_count(text: str) -> int:
    """只算泰文本體字元，不算空白／斜線／標點——避免「สวัสดี ค่ะ / ครับ」這種
    含分隔符的短詞，因為原始字串長度剛好跨過門檻而被誤判成「整句」。"""
    return len(THAI_CHAR_RE.findall(text))


def deep_link_url(lesson_id: str, thai: str) -> str:
    """跟 src/state.js 的 cardKey()（`${lessonId}:${thai}`）同一種 key 格式，
    App 端 src/app.js 的 parseDeepLinkParam() 讀 ?card= 這個參數直接跳到該卡。"""
    qs = urllib.parse.urlencode({"card": f"{lesson_id}:{thai}"})
    return f"{APP_URL}?{qs}"


def load_lessons() -> list[dict]:
    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    return data.get("lessons", [])


def pick_sentence(lessons: list[dict], today: str) -> tuple[dict, dict] | None:
    """由最新一堂課開始往回找，回傳 (lesson, card)；找不到回 None。
    「最新一堂」＝ data.json 的 lessons 最後一筆，順序來自 sync-sheet.py 依 Sheet
    tab 原始順序排列（見 sync-sheet.py 的 `lessons.sort(key=...)`）；Sheet tab 順序
    若被手動調動，這裡會跟著變。"""
    for lesson in reversed(lessons):
        candidates = [c for c in lesson.get("cards", []) if thai_char_count(c.get("thai", "")) >= MIN_THAI_CHARS]
        if not candidates:
            continue
        seed = f"{today}:{lesson.get('id', lesson.get('title', ''))}"
        idx = int(hashlib.sha256(seed.encode()).hexdigest(), 16) % len(candidates)
        return lesson, candidates[idx]
    return None


def send_telegram(token: str, chat_id: str, text: str, retries: int = 3) -> None:
    """跟 sync-sheet.py 的 http_get 同一套退避重試慣例：14 天實驗每一天都是一個資料點，
    一次暫時性的 Telegram 5xx 或 runner 網路小抖動，不該讓那天的訊息整個消失不補。"""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": "true",  # 不然 Telegram 會在訊息下面貼一張 CF Access 登入頁的預覽卡
    }).encode()

    last_err: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=payload, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            result = json.loads(body)
            if not result.get("ok"):
                raise RuntimeError(f"Telegram sendMessage failed: {body}")
            return
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError) as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Telegram sendMessage failed after {retries} attempts: {last_err}")


def main() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        print("[daily-reminder] ERROR: 缺 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID", flush=True)
        return 1

    try:
        lessons = load_lessons()
    except (OSError, json.JSONDecodeError) as e:
        print(f"[daily-reminder] ERROR: 讀 data.json 失敗: {e}", flush=True)
        return 1
    if not lessons:
        print("[daily-reminder] ERROR: data.json 沒有任何課程", flush=True)
        return 1

    today = datetime.now(TAIPEI).strftime("%Y-%m-%d")
    picked = pick_sentence(lessons, today)
    if not picked:
        print(f"[daily-reminder] ERROR: 找不到任何 >={MIN_THAI_CHARS} 字元的整句", flush=True)
        return 1

    lesson, card = picked
    thai = card.get("thai", "")
    zh = card.get("zh", "")

    text = (
        f"清心安神・今日一句\n\n"
        f"{thai}\n{zh}\n\n"
        f"開這句的字卡：{deep_link_url(lesson.get('id', ''), thai)}"
    )

    try:
        send_telegram(token, chat_id, text)
    except RuntimeError as e:
        print(f"[daily-reminder] ERROR: {e}", flush=True)
        return 1
    print(f"[daily-reminder] 已推播：{lesson.get('title')} 「{thai}」（{thai_char_count(thai)} 泰文字元）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
