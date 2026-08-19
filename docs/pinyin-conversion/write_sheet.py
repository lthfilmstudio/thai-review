"""
把 全課-karaoke對照表-合併版.tsv 的新拼音寫回 Google Sheet 的 karaoke 欄位。

前提：
- Google Cloud 專案已啟用 Sheets API，建過一個 service account，JSON 金鑰放在
  ~/.config/thai-review/sheets-service-account.json（不進 repo，見 .gitignore）
- 該 service account 的 email（金鑰裡的 client_email）已被加進 Sheet 共用名單，
  權限「編輯者」
- Sheet 分頁標題要跟 data.json 的 lesson['title'] 完全一致（gid 也要對得上）
- 依 data.json 的課次標題 + 泰文列身分匹配，只覆蓋拼音欄（欄位 C），A/B 欄（中文/泰文）不動；
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

SA_PATH = "/Users/lth/.config/thai-review/sheets-service-account.json"
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
MERGED_TSV = "docs/pinyin-conversion/全課-karaoke對照表-合併版.tsv"
DATA_JSON = "data.json"


def load_lookup(path=MERGED_TSV):
    lookup = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            new_val = row["新拼音(目的達)"].strip()
            if new_val:
                lookup[(row["課次"].strip(), row["泰文"].strip())] = new_val
    return lookup


def build_write_plan(titles, value_ranges, lookup):
    """Build sparse C-cell updates from one A:C Sheet snapshot."""
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
        for row_index, row in enumerate(data_rows, start=2):
            thai = row[1].strip() if len(row) > 1 else ""
            if (title, thai) in lookup:
                write_data.append({
                    "range": f"'{title}'!C{row_index}:C{row_index}",
                    "values": [[lookup[(title, thai)]]],
                })
                matched += 1
            else:
                unmatched += 1
        total_matched += matched
        total_unmatched += unmatched
        if unmatched:
            print(f"{title}: {len(data_rows)} rows, {matched} matched, {unmatched} unmatched")
    return write_data, total_matched, total_unmatched


def main():
    from googleapiclient.discovery import build
    from google.oauth2 import service_account

    dry_run = "--dry-run" in sys.argv

    d = json.load(open(DATA_JSON))
    titles = [l["title"] for l in d["lessons"]]
    lookup = load_lookup()
    print("lookup size (non-empty only):", len(lookup))

    creds = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    svc = build("sheets", "v4", credentials=creds)

    ranges = [f"'{t}'!A:C" for t in titles]
    res = svc.spreadsheets().values().batchGet(spreadsheetId=SHEET_ID, ranges=ranges).execute()
    value_ranges = res["valueRanges"]

    write_data, total_matched, total_unmatched = build_write_plan(titles, value_ranges, lookup)

    print("TOTAL:", total_matched, "matched,", total_unmatched, "unmatched (kept old value)")

    if dry_run:
        print("--dry-run，沒有真的寫入")
        return

    # Avoid overwriting an edit made after the first snapshot.  This is a
    # best-effort compare-and-write guard; any difference aborts the batch.
    latest = svc.spreadsheets().values().batchGet(
        spreadsheetId=SHEET_ID, ranges=ranges
    ).execute()["valueRanges"]
    if [vr.get("values", []) for vr in latest] != [vr.get("values", []) for vr in value_ranges]:
        raise RuntimeError("Sheet 在讀取期間有變更，已中止回寫；請重新執行並先確認差異")

    body = {"valueInputOption": "RAW", "data": write_data}
    res = svc.spreadsheets().values().batchUpdate(spreadsheetId=SHEET_ID, body=body).execute()
    print("totalUpdatedCells:", res.get("totalUpdatedCells"))


if __name__ == "__main__":
    main()
