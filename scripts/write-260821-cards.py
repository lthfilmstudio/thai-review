#!/usr/bin/env python3
"""One-off: 把 260821 的兩份 draft TSV 寫進 Google Sheet。

Part1（中 2-4 複習例句）→ 附加到既有「中 2-4」分頁尾端。
Part2（中 2-5 新課）→ 複製「中 2-4」分頁版型建立新分頁「中 2-5」，清掉複製過來的
舊資料列，只留表頭，再寫入。

預設 dry-run，只印出即將寫入的內容跟目標位置，不碰 Sheet。--write 才真的寫，
寫完會自動 read-back 比對，不一致就報錯。
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

SA_PATH = Path("/Users/lth/.config/thai-review/sheets-service-account.json")
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
HEADERS = ["中文", "泰文", "目的達拼音", "start_ms", "end_ms"]

PART1_TSV = Path("out/class-transcriptions/260821/260821-part1-review-中2-4.tsv")
PART2_TSV = Path("out/class-transcriptions/260821/260821-part2-new-中2-5.tsv")
TARGET_TAB_EXISTING = "中 2-4"
TARGET_TAB_NEW = "中 2-5"


def load_tsv_as_sheet_rows(path: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for line in csv.reader(handle, delimiter="\t"):
            if not line:
                continue
            thai, karaoke, zh = line[0], line[1], line[2]
            if not thai or not zh:
                raise ValueError(f"缺 thai/zh：{line}")
            rows.append([zh, thai, karaoke, "", ""])
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="真的寫入 Google Sheet")
    args = parser.parse_args()

    part1_rows = load_tsv_as_sheet_rows(PART1_TSV)
    part2_rows = load_tsv_as_sheet_rows(PART2_TSV)
    print(f"Part1（附加到「{TARGET_TAB_EXISTING}」）：{len(part1_rows)} 列")
    print(f"Part2（新分頁「{TARGET_TAB_NEW}」）：{len(part2_rows)} 列")
    print("mode:", "write" if args.write else "dry-run")
    if not args.write:
        print("dry-run 範例（各前 3 列）：")
        for r in part1_rows[:3]:
            print(" part1:", r)
        for r in part2_rows[:3]:
            print(" part2:", r)
        return 0

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    service = build("sheets", "v4", credentials=credentials)

    meta = service.spreadsheets().get(spreadsheetId=SHEET_ID, fields="sheets.properties").execute()
    sheets = {s["properties"]["title"]: s["properties"] for s in meta["sheets"]}
    existing = sheets.get(TARGET_TAB_EXISTING)
    if not existing:
        raise RuntimeError(f"找不到分頁「{TARGET_TAB_EXISTING}」")
    if TARGET_TAB_NEW in sheets:
        raise RuntimeError(f"分頁「{TARGET_TAB_NEW}」已經存在，不重複建立")
    existing_sheet_id = int(existing["sheetId"])
    existing_index = int(existing["index"])

    # ---- Step 1：驗證 中2-4 表頭沒變 ----
    header_check = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TARGET_TAB_EXISTING}'!A1:E1",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    if header_check.get("values") != [HEADERS]:
        raise RuntimeError(f"「{TARGET_TAB_EXISTING}」表頭跟預期不同：{header_check.get('values')}")

    # ---- Step 2：附加 Part1 到 中2-4 尾端 ----
    before = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TARGET_TAB_EXISTING}'!A:B",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    before_row_count = len(before.get("values", []))
    print(f"附加前「{TARGET_TAB_EXISTING}」目前 {before_row_count} 列（含表頭）")

    append_resp = service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"'{TARGET_TAB_EXISTING}'!A1:E1",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body={"values": part1_rows},
    ).execute()
    updated_range = append_resp["updates"]["updatedRange"]
    print(f"Part1 寫入範圍：{updated_range}")

    # ---- Step 3：複製 中2-4 分頁版型 → 中2-5，清掉舊資料列只留表頭 ----
    dup_resp = service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"requests": [{
            "duplicateSheet": {
                "sourceSheetId": existing_sheet_id,
                "insertSheetIndex": existing_index + 1,
                "newSheetName": TARGET_TAB_NEW,
            }
        }]},
    ).execute()
    new_sheet_id = dup_resp["replies"][0]["duplicateSheet"]["properties"]["sheetId"]
    print(f"新分頁「{TARGET_TAB_NEW}」建立完成，sheetId={new_sheet_id}")

    new_meta = service.spreadsheets().get(
        spreadsheetId=SHEET_ID,
        ranges=[f"'{TARGET_TAB_NEW}'"],
        fields="sheets.properties.gridProperties",
    ).execute()
    dup_row_count = int(new_meta["sheets"][0]["properties"]["gridProperties"]["rowCount"])

    service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"requests": [{
            "updateCells": {
                "range": {
                    "sheetId": new_sheet_id,
                    "startRowIndex": 1,
                    "endRowIndex": dup_row_count,
                    "startColumnIndex": 0,
                    "endColumnIndex": len(HEADERS),
                },
                "fields": "userEnteredValue",
            }
        }]},
    ).execute()
    print(f"已清空複製過來的 {dup_row_count - 1} 列舊資料，只留表頭")

    # ---- Step 4：寫入 Part2 到 中2-5 ----
    append_resp2 = service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"'{TARGET_TAB_NEW}'!A1:E1",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body={"values": part2_rows},
    ).execute()
    print(f"Part2 寫入範圍：{append_resp2['updates']['updatedRange']}")

    # ---- Step 5：read-back 驗證 ----
    after1 = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TARGET_TAB_EXISTING}'!A:E",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    tail1 = after1[before_row_count:]
    tail1 = [row + [""] * (5 - len(row)) for row in tail1]
    if tail1 != part1_rows:
        raise RuntimeError(f"Part1 read-back 不一致：寫入 {len(part1_rows)} 列，讀回 {len(tail1)} 列")
    print(f"Part1 read-back 核對一致：{len(tail1)} 列")

    after2 = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TARGET_TAB_NEW}'!A:E",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    body2 = after2[1:]
    body2 = [row + [""] * (5 - len(row)) for row in body2]
    if body2 != part2_rows:
        raise RuntimeError(f"Part2 read-back 不一致：寫入 {len(part2_rows)} 列，讀回 {len(body2)} 列")
    print(f"Part2 read-back 核對一致：{len(body2)} 列")

    print("全部完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
