#!/usr/bin/env python3
"""Validate the approved Phase 3 dialogue TSV and sync it to Google Sheets.

Default mode is a read-only dry run. Pass ``--write`` to create or update the
``生活對話`` tab, then read the written cells back for exact verification.
"""

from __future__ import annotations

import argparse
import csv
from collections import Counter, defaultdict
from pathlib import Path


SA_PATH = Path("/Users/lth/.config/thai-review/sheets-service-account.json")
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
SHEET_TITLE = "生活對話"
SHEET_TAB_ID = 20260820
TSV_PATH = Path("docs/dialogue-content/phase3-dialogue-draft.tsv")
HEADERS = ["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"]


def load_rows(path: Path = TSV_PATH) -> list[list[object]]:
    with path.open(newline="", encoding="utf-8") as handle:
        source = list(csv.DictReader(handle, delimiter="\t"))
    rows: list[list[object]] = [HEADERS]
    for item in source:
        try:
            order = int((item.get("順序") or "").strip())
        except ValueError as exc:
            raise ValueError(f"無效順序：{item.get('順序')!r}") from exc
        rows.append([
            (item.get("情境 ID") or "").strip(),
            (item.get("情境名稱") or "").strip(),
            order,
            (item.get("說話者") or "").strip(),
            (item.get("泰文") or "").strip(),
            (item.get("目的達拼音") or "").strip(),
            (item.get("中文") or "").strip(),
        ])
    return rows


def validate_rows(rows: list[list[object]]) -> int:
    if not rows or rows[0] != HEADERS:
        raise ValueError("正式 Sheet 表頭必須是核准的 7 欄契約")

    grouped: dict[str, list[list[object]]] = defaultdict(list)
    for row in rows[1:]:
        if len(row) != len(HEADERS) or any(value == "" for value in row):
            raise ValueError(f"對話列缺欄位：{row}")
        grouped[str(row[0])].append(row)

    if not grouped:
        raise ValueError("沒有對話資料")

    for scenario_id, turns in grouped.items():
        orders = [int(turn[2]) for turn in turns]
        if sorted(orders) != list(range(1, 7)):
            raise ValueError(f"{scenario_id} 順序必須是 1 到 6")
        names = {str(turn[1]) for turn in turns}
        if len(names) != 1:
            raise ValueError(f"{scenario_id} 情境名稱不一致")
        speakers = Counter(str(turn[3]) for turn in turns)
        if speakers != Counter({"A": 3, "B": 3}):
            raise ValueError(f"{scenario_id} 必須 A/B 各 3 句")
        ordered_speakers = [str(turn[3]) for turn in sorted(turns, key=lambda turn: int(turn[2]))]
        if ordered_speakers != ["A", "B", "A", "B", "A", "B"]:
            raise ValueError(f"{scenario_id} 說話者必須 A/B 交替")

    return len(grouped)


def cell_data(value: object) -> dict:
    if isinstance(value, int):
        return {"userEnteredValue": {"numberValue": value}}
    return {"userEnteredValue": {"stringValue": str(value)}}


def build_requests(
    rows: list[list[object]],
    sheet_id: int,
    *,
    create: bool,
    existing_row_count: int | None = None,
) -> list[dict]:
    requests: list[dict] = []
    if create:
        requests.append({
            "addSheet": {
                "properties": {
                    "sheetId": sheet_id,
                    "title": SHEET_TITLE,
                    "gridProperties": {
                        "rowCount": max(100, len(rows)),
                        "columnCount": len(HEADERS),
                        "frozenRowCount": 1,
                    },
                }
            }
        })

    if not create and existing_row_count and existing_row_count > len(rows):
        requests.append({
            "updateCells": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": len(rows),
                    "endRowIndex": existing_row_count,
                    "startColumnIndex": 0,
                    "endColumnIndex": len(HEADERS),
                },
                "fields": "userEnteredValue",
            }
        })

    requests.extend([
        {
            "updateCells": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 0,
                    "endRowIndex": len(rows),
                    "startColumnIndex": 0,
                    "endColumnIndex": len(HEADERS),
                },
                "rows": [{"values": [cell_data(value) for value in row]} for row in rows],
                "fields": "userEnteredValue",
            }
        },
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": len(HEADERS),
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColorStyle": {
                            "rgbColor": {"red": 0.92, "green": 0.92, "blue": 0.92}
                        },
                        "textFormat": {"bold": True},
                    }
                },
                "fields": "userEnteredFormat(backgroundColorStyle,textFormat.bold)",
            }
        },
        {
            "setDataValidation": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 1,
                    "endRowIndex": len(rows),
                    "startColumnIndex": 3,
                    "endColumnIndex": 4,
                },
                "rule": {
                    "condition": {
                        "type": "ONE_OF_LIST",
                        "values": [
                            {"userEnteredValue": "A"},
                            {"userEnteredValue": "B"},
                        ],
                    },
                    "strict": True,
                    "showCustomUi": True,
                },
            }
        },
        {
            "autoResizeDimensions": {
                "dimensions": {
                    "sheetId": sheet_id,
                    "dimension": "COLUMNS",
                    "startIndex": 0,
                    "endIndex": len(HEADERS),
                }
            }
        },
    ])
    return requests


def displayed_rows(response: dict) -> list[list[object]]:
    values = response.get("values", [])
    normalized: list[list[object]] = []
    for row in values:
        next_row: list[object] = []
        for value in row:
            if isinstance(value, float) and value.is_integer():
                next_row.append(int(value))
            else:
                next_row.append(value)
        normalized.append(next_row)
    return normalized


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="真的寫入 Google Sheet")
    args = parser.parse_args()

    rows = load_rows()
    scenario_count = validate_rows(rows)
    print(f"validated: {scenario_count} scenarios, {len(rows) - 1} turns")
    print(f"target: https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#{SHEET_TITLE}")
    print("mode:", "write" if args.write else "dry-run")
    if not args.write:
        return 0

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    service = build("sheets", "v4", credentials=credentials)
    metadata = service.spreadsheets().get(
        spreadsheetId=SHEET_ID,
        fields="sheets.properties",
    ).execute()
    sheets = {sheet["properties"]["title"]: sheet["properties"] for sheet in metadata["sheets"]}
    existing = sheets.get(SHEET_TITLE)
    sheet_id = int(existing["sheetId"]) if existing else SHEET_TAB_ID
    used_ids = {int(sheet["properties"]["sheetId"]) for sheet in metadata["sheets"]}
    if not existing and sheet_id in used_ids:
        raise RuntimeError(f"預定 sheetId {sheet_id} 已被使用")

    print(f"resolved sheetId: {sheet_id}")

    existing_row_count = int(existing["gridProperties"]["rowCount"]) if existing else None
    requests = build_requests(
        rows,
        sheet_id,
        create=existing is None,
        existing_row_count=existing_row_count,
    )
    service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"requests": requests},
    ).execute()

    written = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f"'{SHEET_TITLE}'!A:G",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    if displayed_rows(written) != rows:
        raise RuntimeError("Sheet read-back 與核准稿不一致")
    print(f"read-back: {len(rows)} rows exact match")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
