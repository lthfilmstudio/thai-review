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
DIALOGUE_SHEET_TITLE = "生活對話"
EXPECTED_DIALOGUE_IDS = {f"D{index:02d}" for index in range(1, 11)}
CANONICAL_CARD_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
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
    "card_id":   ["card_id", "card id", "卡片 id", "卡片id", "卡片ID"],
    "scenario_id":    ["情境 id", "scenario id", "scenario_id"],
    "scenario_title": ["情境名稱", "scenario title", "scenario_title"],
    "order":          ["順序", "order", "turn"],
    "speaker":        ["說話者", "speaker"],
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


def rows_to_cards(rows: list[list[str]], *, require_card_id: bool = False) -> list[dict]:
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
    iCardId = find_col(header, "card_id")

    if iT < 0 or iK < 0 or iZ < 0:
        raise ValueError(f"CSV 缺少必要欄位（泰文/拼音/中文）：{' | '.join(header)}")
    if require_card_id and iCardId < 0:
        raise ValueError("CSV 缺少必要欄位 card_id")

    cards: list[dict] = []
    seen_card_ids: set[str] = set()
    for row_number, row in enumerate(rows[1:], start=2):
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
        card_id = row[iCardId].strip() if iCardId >= 0 and len(row) > iCardId else ""
        if require_card_id:
            if not card_id:
                raise ValueError(f"第 {row_number} 列缺少 card_id")
            if not CANONICAL_CARD_ID_RE.fullmatch(card_id):
                raise ValueError(f"第 {row_number} 列 card_id 不是 canonical lowercase UUID")
            if card_id in seen_card_ids:
                raise ValueError(f"第 {row_number} 列 card_id 重複：{card_id}")
            seen_card_ids.add(card_id)
        if card_id:
            card["card_id"] = card_id
        cards.append(card)
    return cards


def validate_global_card_ids(lessons: list[dict]) -> None:
    seen: dict[str, str] = {}
    for lesson in lessons:
        title = str(lesson.get("title") or lesson.get("gid") or "unknown")
        for index, card in enumerate(lesson.get("cards") or [], start=1):
            card_id = card.get("card_id")
            if not isinstance(card_id, str) or not CANONICAL_CARD_ID_RE.fullmatch(card_id):
                raise ValueError(f"{title} 第 {index} 張缺少有效 canonical card_id")
            if card_id in seen:
                raise ValueError(f"跨分頁 card_id 重複：{card_id}（{seen[card_id]} / {title}）")
            seen[card_id] = title


def rows_to_dialogues(rows: list[list[str]]) -> list[dict]:
    if not rows:
        return []
    header = rows[0]
    indexes = {key: find_col(header, key) for key in (
        "scenario_id", "scenario_title", "order", "speaker", "thai", "karaoke", "zh"
    )}
    missing = [key for key, index in indexes.items() if index < 0]
    if missing:
        raise ValueError(f"生活對話分頁缺少欄位：{', '.join(missing)}")

    grouped: dict[str, dict] = {}
    for row in rows[1:]:
        if not row or len(row) <= indexes["scenario_id"]:
            continue
        scenario_id = row[indexes["scenario_id"]].strip()
        if not scenario_id:
            continue
        try:
            order = int(row[indexes["order"]].strip())
        except (ValueError, IndexError) as exc:
            raise ValueError(f"{scenario_id} 有無效順序") from exc
        scenario = grouped.setdefault(scenario_id, {
            "id": scenario_id,
            "title": row[indexes["scenario_title"]].strip(),
            "turns": [],
        })
        title = row[indexes["scenario_title"]].strip()
        if scenario["title"] != title:
            raise ValueError(f"{scenario_id} 情境名稱不一致")
        scenario["turns"].append({
            "order": order,
            "speaker": row[indexes["speaker"]].strip(),
            "thai": row[indexes["thai"]].strip(),
            "karaoke": row[indexes["karaoke"]].strip(),
            "zh": row[indexes["zh"]].strip(),
        })

    dialogues = list(grouped.values())
    for scenario in dialogues:
        scenario["turns"].sort(key=lambda turn: turn["order"])
        turns = scenario["turns"]
        if len(turns) != 6:
            raise ValueError(f"{scenario['id']} 必須是完整 6 句")
        if [turn["order"] for turn in turns] != list(range(1, 7)):
            raise ValueError(f"{scenario['id']} 順序必須是 1 到 6")
        if [turn["speaker"] for turn in turns] != ["A", "B", "A", "B", "A", "B"]:
            raise ValueError(f"{scenario['id']} 必須 A/B 各 3 句並交替")
        if not scenario["title"] or any(not turn["thai"] or not turn["karaoke"] or not turn["zh"] for turn in turns):
            raise ValueError(f"{scenario['id']} 有空白必填欄位")
    return dialogues


def fetch_lesson(base: str, tab: dict) -> dict:
    csv_url = f"{base}/pub?gid={tab['gid']}&single=true&output=csv"
    text = http_get(csv_url)
    rows = list(csv.reader(io.StringIO(text)))
    cards = rows_to_cards(rows, require_card_id=True)
    if not cards:
        raise ValueError("沒有可用字卡")
    return {
        "id": f"gid-{tab['gid']}",
        "gid": tab["gid"],
        "title": tab["name"],
        "cards": cards,
    }


def fetch_dialogues(base: str, tab: dict) -> list[dict]:
    csv_url = f"{base}/pub?gid={tab['gid']}&single=true&output=csv"
    text = http_get(csv_url)
    return rows_to_dialogues(list(csv.reader(io.StringIO(text))))


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

    dialogue_tabs = [tab for tab in tabs if tab["name"] == DIALOGUE_SHEET_TITLE]
    lesson_tabs = [tab for tab in tabs if tab["name"] != DIALOGUE_SHEET_TITLE]
    if len(dialogue_tabs) != 1:
        print(
            f"[sync-sheet] ERROR: expected exactly one {DIALOGUE_SHEET_TITLE} tab; "
            f"found {len(dialogue_tabs)}. Keep the previous complete data.json",
            flush=True,
        )
        return 4

    lessons: list[dict] = []
    failures: list[tuple[str, str]] = []
    # Google publish CSV 偶爾會在高併發下逾時；寧可多等一點，也不能產出缺課資料。
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch_lesson, base, tab): tab for tab in lesson_tabs}
        for fut in as_completed(futures):
            tab = futures[fut]
            try:
                lesson = fut.result()
                lessons.append(lesson)
            except Exception as e:
                failures.append((tab["name"], str(e)))
                print(f"  ! failed: {tab['name']} - {e}", flush=True)

    # 依 tab 在 pubhtml 裡的原始順序排列
    order = {t["gid"]: i for i, t in enumerate(tabs)}
    lessons.sort(key=lambda l: order.get(l["gid"], 9999))

    if failures:
        print(
            f"[sync-sheet] ERROR: {len(failures)} tab(s) failed; keep the previous complete data.json",
            flush=True,
        )
        return 3

    if not lessons:
        print("[sync-sheet] ERROR: no lessons captured; aborting.", flush=True)
        return 2

    try:
        validate_global_card_ids(lessons)
    except ValueError as exc:
        print(
            f"[sync-sheet] ERROR: card_id contract failed: {exc}; "
            "keep the previous complete data.json",
            flush=True,
        )
        return 5

    try:
        dialogues = fetch_dialogues(base, dialogue_tabs[0])
    except Exception as exc:
        print(
            f"[sync-sheet] ERROR: {DIALOGUE_SHEET_TITLE} failed: {exc}; "
            "keep the previous complete data.json",
            flush=True,
        )
        return 4
    dialogue_ids = {dialogue["id"] for dialogue in dialogues}
    if dialogue_ids != EXPECTED_DIALOGUE_IDS:
        missing = sorted(EXPECTED_DIALOGUE_IDS - dialogue_ids)
        extra = sorted(dialogue_ids - EXPECTED_DIALOGUE_IDS)
        print(
            f"[sync-sheet] ERROR: incomplete dialogue set; missing={missing}, extra={extra}. "
            "Keep the previous complete data.json",
            flush=True,
        )
        return 4

    out = {
        "generated_at": int(time.time()),
        "source_url": base + "/pubhtml",
        "lessons": lessons,
        "dialogues": dialogues,
    }
    out_path.write_text(
        json.dumps(out, ensure_ascii=False, indent=None, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    total_cards = sum(len(l["cards"]) for l in lessons)
    print(
        f"[sync-sheet] wrote {out_path}: {len(lessons)} lessons, {total_cards} cards"
        + f", {len(dialogues)} dialogues"
        + (f", {len(failures)} failures" if failures else ""),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
