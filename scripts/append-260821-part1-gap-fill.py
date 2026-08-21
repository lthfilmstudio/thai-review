#!/usr/bin/env python3
"""把回頭抓漏補上的 15 句（Part1 量詞複習，第一次整理時漏掉的）附加到「中 2-5」尾端。

karaoke 用 docs/pinyin-conversion/run_resolve.py 的 resolve_word()（跟主 pipeline
同一套：pythainlp subword_tokenize + syllable_engine + SYL_FIX），全部 15 句都
engine-auto/derived 解出來，沒有卡住的字。

預設 dry-run，--write 才真的寫，寫完 read-back 驗證。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SA_PATH = Path("/Users/lth/.config/thai-review/sheets-service-account.json")
SHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
TAB = "中 2-5"

# (thai, zh) —— karaoke 現場用 resolve_word() 算，不寫死，避免跟主 pipeline 兜不起來。
ROWS = [
    ("สามไม้สี่สิบบาท", "三串四十元"),
    ("เอ่อ สามไม้ครับ", "三串（男性禮貌）"),
    ("ห้าไม้นี้มีคนจองแล้วครับ", "這五串已經有人訂了（男性禮貌）"),
    ("คันมาก", "很癢（คัน 雙關：癢／量詞-輛）"),
    ("คันตรงไหน", "哪裡癢"),
    ("หนึ่งห่อมีสองแผ่น", "一包有兩張"),
    ("เอากระป๋องเล็กค่ะ", "要小罐（女性禮貌）"),
    ("ส้มโอแพ็คละห้าสิบบาท", "柚子一包五十元"),
    ("มี Smartphone หนึ่งเครื่องเดียวค่ะ", "只有一台智慧型手機（女性禮貌）"),
    ("คนรุ่นใหม่", "新世代（รุ่น 雙關：代／款）"),
    ("ไปสาย", "要遲到了"),
    ("เรือลำไหนไปเกาะล้านครับ", "哪艘船去格藍島（男性禮貌）"),
    ("เอ่อ ฉันชอบขี่จักรยานค่ะ", "我喜歡騎腳踏車（第一人稱）"),
    ("เคยไปครับ", "去過（男性禮貌）"),
    ("ฉันโสด", "我單身"),
]


def build_rows() -> list[list[str]]:
    sys.path.insert(0, "docs/pinyin-conversion")
    from run_resolve import resolve_word

    rows: list[list[str]] = []
    for thai, zh in ROWS:
        rom, source, err = resolve_word(thai)
        if not rom:
            raise RuntimeError(f"karaoke 解不出來：{thai} ({err})")
        rows.append([zh, thai, rom, "", ""])
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    rows = build_rows()
    print(f"要附加到「{TAB}」尾端：{len(rows)} 列")
    for r in rows:
        print(" ", r)
    print("mode:", "write" if args.write else "dry-run")
    if not args.write:
        return 0

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        SA_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    service = build("sheets", "v4", credentials=credentials)

    before = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB}'!A:B",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    before_count = len(before.get("values", []))
    print(f"附加前「{TAB}」共 {before_count} 列")

    resp = service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"'{TAB}'!A1:E1",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body={"values": rows},
    ).execute()
    print("寫入範圍：", resp["updates"]["updatedRange"])

    after = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB}'!A:E",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])
    tail = after[before_count:]
    tail = [row + [""] * (5 - len(row)) for row in tail]
    if tail != rows:
        raise RuntimeError(f"read-back 不一致：寫入 {len(rows)} 列，讀回 {len(tail)} 列，接在第 {before_count+1} 列")
    print(f"read-back 核對一致：{len(tail)} 列，接在第 {before_count+1} 列（沒有插到中間）")
    print(f"「{TAB}」現在共 {len(after)} 列")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
