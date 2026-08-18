"""
把 全課-karaoke對照表-合併版.tsv 的新拼音寫回 Google Sheet 的 karaoke 欄位。

前提：
- Google Cloud 專案已啟用 Sheets API，建過一個 service account，JSON 金鑰放在
  ~/.config/thai-review/sheets-service-account.json（不進 repo，見 .gitignore）
- 該 service account 的 email（金鑰裡的 client_email）已被加進 Sheet 共用名單，
  權限「編輯者」
- Sheet 分頁標題要跟 data.json 的 lesson['title'] 完全一致（gid 也要對得上）
- 只匹配、只覆蓋「泰式Karaoke拼音」那一欄（欄位 C），A/B 欄（中文/泰文）不動；
  合併表裡新拼音是空字串的（真正判斷不了的殘餘），保留 Sheet 原值不覆蓋

執行：
  uv run --with google-api-python-client --with google-auth python3 \
    docs/pinyin-conversion/write_sheet.py [--dry-run]

2026-08-18 用這支腳本（inline 版本）把 45 課、13,060 筆（含初1試寫+正式覆蓋）
全部寫回，12,546 筆比對成功覆蓋、58 筆保留原值。之後如果修正引擎或補完
仍不確定清單，重跑這支腳本就能再次同步（重複執行是安全的，同一批資料寫兩次
結果一樣）。
"""
import csv
import json
import sys

from googleapiclient.discovery import build
from google.oauth2 import service_account

SA_PATH = "/Users/lth/.config/thai-review/sheets-service-account.json"
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
MERGED_TSV = "docs/pinyin-conversion/全課-karaoke對照表-合併版.tsv"
DATA_JSON = "data.json"


def load_lookup():
    lookup = {}
    with open(MERGED_TSV, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            new_val = row["新拼音(目的達)"].strip()
            if new_val:
                lookup[(row["泰文"], row["舊拼音(Sheet)"])] = new_val
    return lookup


def main():
    dry_run = "--dry-run" in sys.argv

    d = json.load(open(DATA_JSON))
    titles = [l["title"] for l in d["lessons"]]
    lookup = load_lookup()
    print("lookup size (non-empty only):", len(lookup))

    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    svc = build("sheets", "v4", credentials=creds)

    ranges = [f"'{t}'!A1:C1000" for t in titles]
    res = svc.spreadsheets().values().batchGet(spreadsheetId=SHEET_ID, ranges=ranges).execute()
    value_ranges = res["valueRanges"]

    write_data = []
    total_matched = 0
    total_unmatched = 0
    for title, vr in zip(titles, value_ranges):
        rows = vr.get("values", [])
        if not rows:
            continue
        data_rows = rows[1:]
        matched = 0
        unmatched = 0
        full_vals = []
        for r in data_rows:
            thai = r[1] if len(r) > 1 else ""
            old_kara = r[2] if len(r) > 2 else ""
            key = (thai, old_kara)
            if key in lookup:
                full_vals.append([lookup[key]])
                matched += 1
            else:
                full_vals.append([old_kara])
                unmatched += 1
        total_matched += matched
        total_unmatched += unmatched
        if unmatched:
            print(f"{title}: {len(data_rows)} rows, {matched} matched, {unmatched} unmatched")
        write_data.append({"range": f"'{title}'!C2:C{1 + len(data_rows)}", "values": full_vals})

    print("TOTAL:", total_matched, "matched,", total_unmatched, "unmatched (kept old value)")

    if dry_run:
        print("--dry-run，沒有真的寫入")
        return

    body = {"valueInputOption": "RAW", "data": write_data}
    res = svc.spreadsheets().values().batchUpdate(spreadsheetId=SHEET_ID, body=body).execute()
    print("totalUpdatedCells:", res.get("totalUpdatedCells"))


if __name__ == "__main__":
    main()
