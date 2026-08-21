#!/usr/bin/env python3
"""修正 260821：把誤加進「中 2-4」的 53 張複習例句刪掉，跟「中 2-5」既有的
47 張新課內容合併，複習在前、新課在後，變成「中 2-5」100 張，「中 2-4」
回到原本 292 張。

理由（Nalin 糾正）：每一堂課都包含上一堂課複習，但造句是當天新講的，今天
日期的 mp4（不管上半場複習還下半場新課）整堂都該歸在今天日期的分頁，不要
自作主張拆開放進舊課次。

預設 dry-run。--write 才真的動 Sheet，寫完 read-back 驗證。
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

SA_PATH = Path("/Users/lth/.config/thai-review/sheets-service-account.json")
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
HEADERS = ["中文", "泰文", "目的達拼音", "start_ms", "end_ms"]

PART1_TSV = Path("out/class-transcriptions/260821/260821-part1-review-中2-4.tsv")
TAB_2_4 = "中 2-4"
TAB_2_4_SHEET_ID = 1786078251
TAB_2_5 = "中 2-5"

# 之前誤插入「中 2-4」的確切位置（已用 read-back 核對過）：第 202~254 列（1-indexed）。
DELETE_START_ROW = 202  # inclusive, 1-indexed
DELETE_END_ROW = 254    # inclusive, 1-indexed


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
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    part1_rows = load_tsv_as_sheet_rows(PART1_TSV)
    print(f"要從「{TAB_2_4}」刪除第 {DELETE_START_ROW}~{DELETE_END_ROW} 列（{len(part1_rows)} 列）")
    print(f"要插入「{TAB_2_5}」表頭之後（第 2 列開始，Part2 既有內容往後推）")
    print("mode:", "write" if args.write else "dry-run")
    if not args.write:
        return 0

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    service = build("sheets", "v4", credentials=credentials)

    # ---- Step 0：刪除前先核對「中 2-4」那 53 列確實是我們要刪的內容 ----
    check = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f"'{TAB_2_4}'!A{DELETE_START_ROW}:B{DELETE_END_ROW}",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    expected = [[r[0], r[1]] for r in part1_rows]
    if check != expected:
        raise RuntimeError("「中 2-4」第 202~254 列內容跟預期的 Part1 不一致，中止，不要亂刪")
    print(f"核對通過：「{TAB_2_4}」第 {DELETE_START_ROW}~{DELETE_END_ROW} 列確實是誤插入的 Part1 內容")

    # ---- Step 1：刪除「中 2-4」那 53 列 ----
    service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"requests": [{
            "deleteDimension": {
                "range": {
                    "sheetId": TAB_2_4_SHEET_ID,
                    "dimension": "ROWS",
                    "startIndex": DELETE_START_ROW - 1,
                    "endIndex": DELETE_END_ROW,
                }
            }
        }]},
    ).execute()
    print(f"已從「{TAB_2_4}」刪除 {len(part1_rows)} 列")

    # ---- Step 2：確認「中 2-5」sheetId ----
    meta = service.spreadsheets().get(spreadsheetId=SHEET_ID, fields="sheets.properties").execute()
    sheets = {s["properties"]["title"]: s["properties"] for s in meta["sheets"]}
    tab25 = sheets.get(TAB_2_5)
    if not tab25:
        raise RuntimeError(f"找不到分頁「{TAB_2_5}」")
    sheet_id_25 = int(tab25["sheetId"])

    # ---- Step 3：在「中 2-5」表頭後插入 53 個空白列，把既有 Part2 往下推 ----
    service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"requests": [{
            "insertDimension": {
                "range": {
                    "sheetId": sheet_id_25,
                    "dimension": "ROWS",
                    "startIndex": 1,
                    "endIndex": 1 + len(part1_rows),
                },
                "inheritFromBefore": False,
            }
        }]},
    ).execute()
    print(f"已在「{TAB_2_5}」表頭後插入 {len(part1_rows)} 個空白列")

    # ---- Step 4：寫入 Part1 內容到剛打開的空白列 ----
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=f"'{TAB_2_5}'!A2:E{1 + len(part1_rows)}",
        valueInputOption="RAW",
        body={"values": part1_rows},
    ).execute()
    print(f"已寫入 Part1 {len(part1_rows)} 列到「{TAB_2_5}」第 2~{1 + len(part1_rows)} 列")

    # ---- Step 5：read-back 驗證兩邊 ----
    after24 = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB_2_4}'!A{DELETE_START_ROW-3}:B{DELETE_START_ROW+2}",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    print(f"「{TAB_2_4}」刪除點前後內容（應該直接接回原本的列，不再看到 Part1）：")
    for row in after24:
        print(" ", row)

    after25 = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB_2_5}'!A1:E101",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    if after25[0] != HEADERS:
        raise RuntimeError(f"「{TAB_2_5}」表頭跑掉了：{after25[0]}")
    body_part1 = after25[1:1 + len(part1_rows)]
    body_part1 = [row + [""] * (5 - len(row)) for row in body_part1]
    if body_part1 != part1_rows:
        raise RuntimeError("「中 2-5」Part1 區塊 read-back 不一致")
    print(f"「{TAB_2_5}」Part1 區塊（第 2~{1+len(part1_rows)} 列）read-back 一致：{len(body_part1)} 列")
    print(f"「{TAB_2_5}」總列數（含表頭）：{len(after25)}")

    print("全部完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
