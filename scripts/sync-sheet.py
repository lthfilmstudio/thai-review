#!/usr/bin/env python3
"""
sync-sheet.py — 把 Nalin 泰文課 Sheet 預先抓成 data.json，直接放在 repo 同源服務。

目的：取代瀏覽器跑 pubhtml + 28 個 CSV 的串流抓取（1.5-3 秒/切課程），
改成 GitHub Action 每 30 分鐘背景跑，client 直接讀 ./data.json（< 50ms）。

行為對齊 src/data.js：
- 抓 pubhtml → regex 解析 items.push 的 tab 列表
- 每個 tab 抓 publish-to-web CSV
- 用 COL_ALIASES 對欄位（中文 header 優先）
- 輸出 [{ id, title, gid, cards: [...] }, ...]
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ── Sheet 設定（跟 src/state.js DEFAULT_SHEET_URL 對齊） ─────────────
DEFAULT_PUB_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vQzG3dKsEvQSsMxu4d1cwTMyvzUaq7kPK2Nwlg2qVZvzEmVhO4IS6D9lPirt4-cRbfokXbQNgvBWo9C/pubhtml"
)

# ── 欄位別名（跟 src/data.js COL_ALIASES 對齊） ────────────────────
COL_ALIASES = {
    "thai":      ["泰文", "thai", "th"],
    "karaoke":   ["泰式karaoke拼音", "karaoke拼音", "目的達拼音", "拼音", "karaoke", "pronunciation"],
    "zh":        ["中文", "中文翻譯", "翻譯", "zh", "chinese", "cn"],
    "type":      ["類型", "type", "分類"],
    "note":      ["備註", "note", "說明"],
    "audio_url": ["音檔", "audio_url", "audio", "音檔網址"],
    "lesson":    ["課程", "課", "堂", "lesson"],
    "start_ms":  ["start_ms", "start", "開始毫秒", "起始毫秒"],
    "end_ms":    ["end_ms", "end", "結束毫秒"],
}

USER_AGENT = "thai-review-sync/1.0 (+https://github.com/lthfilmstudio/thai-review)"

# ── HTTP fetch 帶簡單退避重試 ──────────────────────────────────
def http_get(url: str, retries: int = 3, timeout: int = 30) -> str:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"http_get failed after {retries} attempts: {url} ({last_err})")


# ── 解析 pubhtml 抓 tab 清單（跟 data.js parsePubTabs 對齊） ───────
def parse_pub_tabs(html: str) -> list[dict]:
    """Google publish-to-web 把 tab 清單塞在 JS 裡：
    items.push({name: "3-1", pageUrl: "...gid=XXX", gid: "1979220085", initialSheet: ...})
    """
    pattern = re.compile(
        r'items\.push\(\{\s*name:\s*"((?:\\.|[^"\\])*)"[^}]*?\bgid:\s*"(\d+)"',
        re.DOTALL,
    )
    seen_gids: set[str] = set()
    tabs: list[dict] = []
    for match in pattern.finditer(html):
        # 名字本身是 UTF-8（regex 已用 str 比對），只需要還原 \\ 跟 \" 兩種 JS 字串轉義
        name = match.group(1).replace('\\"', '"').replace("\\\\", "\\")
        gid = match.group(2)
        if gid in seen_gids:
            continue
        seen_gids.add(gid)
        tabs.append({"gid": gid, "name": name})
    return tabs


# ── CSV header 找對應欄位 index ────────────────────────────────
def find_col(header: list[str], key: str) -> int:
    aliases = COL_ALIASES.get(key, [key])
    lowered = [h.strip().lower() for h in header]
    for alias in aliases:
        if alias in lowered:
            return lowered.index(alias)
    return -1


def to_ms(value: str | None) -> int | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        n = float(s)
        if n >= 0 and n == int(n):
            return int(n)
        if n >= 0:
            return n  # 保留浮點（雖然 ms 通常是整數，但保留容錯）
    except ValueError:
        return None
    return None


def rows_to_cards(rows: list[list[str]]) -> list[dict]:
    if not rows:
        return []
    header = rows[0]
    iT = find_col(header, "thai")
    iK = find_col(header, "karaoke")
    iZ = find_col(header, "zh")
    iType = find_col(header, "type")
    iNote = find_col(header, "note")
    iAudio = find_col(header, "audio_url")
    iLesson = find_col(header, "lesson")
    iStart = find_col(header, "start_ms")
    iEnd = find_col(header, "end_ms")

    if iT < 0 or iK < 0 or iZ < 0:
        # 必要欄位不齊，回空（不 raise，讓單一 tab 失敗不要拖累全部）
        return []

    cards: list[dict] = []
    for row in rows[1:]:
        if not row or len(row) <= iT or not row[iT].strip():
            continue
        card = {
            "thai": row[iT].strip(),
            "karaoke": row[iK].strip() if len(row) > iK else "",
            "zh": row[iZ].strip() if len(row) > iZ else "",
            "type": (row[iType].strip().lower() if iType >= 0 and len(row) > iType else "word") or "word",
            "note": row[iNote].strip() if iNote >= 0 and len(row) > iNote else "",
            "audio_url": row[iAudio].strip() if iAudio >= 0 and len(row) > iAudio else "",
            "lesson": row[iLesson].strip() if iLesson >= 0 and len(row) > iLesson else "",
        }
        s = to_ms(row[iStart]) if iStart >= 0 and len(row) > iStart else None
        e = to_ms(row[iEnd]) if iEnd >= 0 and len(row) > iEnd else None
        if s is not None:
            card["start_ms"] = s
        if e is not None:
            card["end_ms"] = e
        cards.append(card)
    return cards


def fetch_lesson(base: str, tab: dict) -> dict:
    csv_url = f"{base}/pub?gid={tab['gid']}&single=true&output=csv"
    text = http_get(csv_url)
    rows = list(csv.reader(io.StringIO(text)))
    cards = rows_to_cards(rows)
    return {
        "id": f"gid-{tab['gid']}",
        "gid": tab["gid"],
        "title": tab["name"],
        "cards": cards,
    }


def main() -> int:
    pub_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PUB_URL
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data.json")

    base = re.sub(r"[?#].*$", "", pub_url)
    base = re.sub(r"/pub(html)?$", "", base)

    print(f"[sync-sheet] fetching {base}/pubhtml ...", flush=True)
    html = http_get(f"{base}/pubhtml")

    tabs = parse_pub_tabs(html)
    if not tabs:
        print("[sync-sheet] ERROR: no tabs parsed; aborting.", flush=True)
        return 1
    print(f"[sync-sheet] found {len(tabs)} tabs", flush=True)

    lessons: list[dict] = []
    failures: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(fetch_lesson, base, tab): tab for tab in tabs}
        for fut in as_completed(futures):
            tab = futures[fut]
            try:
                lesson = fut.result()
                if not lesson["cards"]:
                    print(f"  - skip empty: {tab['name']} ({tab['gid']})", flush=True)
                    continue
                lessons.append(lesson)
            except Exception as e:
                failures.append((tab["name"], str(e)))
                print(f"  ! failed: {tab['name']} - {e}", flush=True)

    # 依 tab 在 pubhtml 裡的原始順序排列
    order = {t["gid"]: i for i, t in enumerate(tabs)}
    lessons.sort(key=lambda l: order.get(l["gid"], 9999))

    if not lessons:
        print("[sync-sheet] ERROR: no lessons captured; aborting.", flush=True)
        return 2

    out = {
        "generated_at": int(time.time()),
        "source_url": base + "/pubhtml",
        "lessons": lessons,
    }
    out_path.write_text(
        json.dumps(out, ensure_ascii=False, indent=None, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    total_cards = sum(len(l["cards"]) for l in lessons)
    print(
        f"[sync-sheet] wrote {out_path}: {len(lessons)} lessons, {total_cards} cards"
        + (f", {len(failures)} failures" if failures else ""),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
