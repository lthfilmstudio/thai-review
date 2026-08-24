import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "sync-sheet.py"
SPEC = importlib.util.spec_from_file_location("sync_sheet", MODULE_PATH)
sync_sheet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_sheet)


class SyncSheetDialogueTest(unittest.TestCase):
    @staticmethod
    def published_html(*tabs):
        return "\n".join(
            f'items.push({{name: "{name}", gid: "{gid}"}});'
            for name, gid in tabs
        )

    @staticmethod
    def dialogue_csv(scenario_count):
        rows = [["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"]]
        for scenario_index in range(1, scenario_count + 1):
            for order in range(1, 7):
                rows.append([
                    f"D{scenario_index:02d}", f"情境 {scenario_index}", str(order),
                    "A" if order % 2 else "B", f"thai-{scenario_index}-{order}",
                    f"karaoke-{scenario_index}-{order}", f"zh-{scenario_index}-{order}",
                ])
        return "\n".join(",".join(row) for row in rows) + "\n"

    def test_dialogue_rows_become_scenarios_without_becoming_cards(self):
        rows = [["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"]]
        for order in range(1, 7):
            rows.append([
                "D01", "初次見面", str(order), "A" if order % 2 else "B",
                f"thai-{order}", f"karaoke-{order}", f"zh-{order}",
            ])

        dialogues = sync_sheet.rows_to_dialogues(rows)
        self.assertEqual(len(dialogues), 1)
        self.assertEqual(dialogues[0]["id"], "D01")
        self.assertEqual(dialogues[0]["title"], "初次見面")
        self.assertEqual([turn["speaker"] for turn in dialogues[0]["turns"]], ["A", "B"] * 3)
        self.assertEqual(dialogues[0]["turns"][0]["thai"], "thai-1")

    def test_dialogue_parser_rejects_incomplete_scenarios(self):
        rows = [
            ["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"],
            ["D01", "初次見面", "1", "A", "thai", "karaoke", "zh"],
        ]
        with self.assertRaisesRegex(ValueError, "6 句"):
            sync_sheet.rows_to_dialogues(rows)

    def test_dialogue_parser_rejects_inconsistent_scenario_titles(self):
        rows = [["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"]]
        for order in range(1, 7):
            rows.append([
                "D01", "初次見面" if order < 6 else "另一個名稱", str(order),
                "A" if order % 2 else "B", f"thai-{order}", f"karaoke-{order}", f"zh-{order}",
            ])
        with self.assertRaisesRegex(ValueError, "情境名稱不一致"):
            sync_sheet.rows_to_dialogues(rows)

    def test_card_parser_rejects_missing_required_headers(self):
        with self.assertRaisesRegex(ValueError, "缺少必要欄位"):
            sync_sheet.rows_to_cards([["泰文", "中文"], ["สวัสดี", "你好"]])

    def test_card_parser_keeps_optional_card_id_backward_compatibly(self):
        rows = [
            ["中文", "泰文", "目的達拼音", "card_id"],
            ["你好", "สวัสดี", "sa wat di", "550e8400-e29b-41d4-a716-446655440000"],
        ]
        cards = sync_sheet.rows_to_cards(rows)
        self.assertEqual(cards[0]["card_id"], "550e8400-e29b-41d4-a716-446655440000")
        self.assertNotIn("card_id", sync_sheet.rows_to_cards(rows[:1] + [["你好", "สวัสดี", "sa wat di"]]))

    def test_production_card_parser_rejects_missing_invalid_and_duplicate_card_ids(self):
        header = ["中文", "泰文", "目的達拼音", "card_id"]
        valid = "550e8400-e29b-41d4-a716-446655440000"
        cases = [
            ([header, ["你好", "สวัสดี", "sa wat di", ""]], "缺少 card_id"),
            ([header, ["你好", "สวัสดี", "sa wat di", valid.upper()]], "canonical lowercase UUID"),
            ([
                header,
                ["你好", "สวัสดี", "sa wat di", valid],
                ["謝謝", "ขอบคุณ", "khop khun", valid],
            ], "card_id 重複"),
        ]
        for rows, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    sync_sheet.rows_to_cards(rows, require_card_id=True)

    def test_fetch_lesson_rejects_an_empty_tab(self):
        with mock.patch.object(sync_sheet, "http_get", return_value="泰文,目的達拼音,中文,card_id\n"):
            with self.assertRaisesRegex(ValueError, "沒有可用字卡"):
                sync_sheet.fetch_lesson("https://example.com/sheet", {"gid": "1", "name": "空白課"})

    def test_fetch_lesson_requires_card_id_header(self):
        csv_text = "泰文,目的達拼音,中文\nสวัสดี,sa wat di,你好\n"
        with mock.patch.object(sync_sheet, "http_get", return_value=csv_text):
            with self.assertRaisesRegex(ValueError, "缺少必要欄位 card_id"):
                sync_sheet.fetch_lesson("https://example.com/sheet", {"gid": "1", "name": "初 1"})

    def test_main_keeps_existing_output_when_dialogue_tab_is_missing(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "data.json"
            output.write_bytes(b"last-known-good\n")
            with (
                mock.patch.object(sys, "argv", ["sync-sheet.py", sync_sheet.DEFAULT_PUB_URL, str(output)]),
                mock.patch.object(
                    sync_sheet,
                    "http_get",
                    return_value=self.published_html(("初 1", "1")),
                ),
            ):
                result = sync_sheet.main()

            self.assertEqual(result, 4)
            self.assertEqual(output.read_bytes(), b"last-known-good\n")

    def test_main_keeps_existing_output_when_approved_dialogue_set_is_partial(self):
        lesson_csv = (
            "泰文,目的達拼音,中文,card_id\n"
            "สวัสดี,sa wat di,你好,550e8400-e29b-41d4-a716-446655440000\n"
        )
        html = self.published_html(("初 1", "1"), (sync_sheet.DIALOGUE_SHEET_TITLE, "2"))

        def fake_http_get(url, *args, **kwargs):
            if url.endswith("/pubhtml"):
                return html
            if "gid=1" in url:
                return lesson_csv
            if "gid=2" in url:
                return self.dialogue_csv(9)
            raise AssertionError(f"unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "data.json"
            output.write_bytes(b"last-known-good\n")
            with (
                mock.patch.object(sys, "argv", ["sync-sheet.py", sync_sheet.DEFAULT_PUB_URL, str(output)]),
                mock.patch.object(sync_sheet, "http_get", side_effect=fake_http_get),
            ):
                result = sync_sheet.main()

            self.assertEqual(result, 4)
            self.assertEqual(output.read_bytes(), b"last-known-good\n")

    def test_main_keeps_existing_output_when_card_id_is_duplicated_across_tabs(self):
        duplicate_id = "550e8400-e29b-41d4-a716-446655440000"
        lesson_csv = (
            "泰文,目的達拼音,中文,card_id\n"
            f"สวัสดี,sa wat di,你好,{duplicate_id}\n"
        )
        html = self.published_html(
            ("初 1", "101"),
            ("初 2", "102"),
            (sync_sheet.DIALOGUE_SHEET_TITLE, "103"),
        )

        def fake_http_get(url, *args, **kwargs):
            if url.endswith("/pubhtml"):
                return html
            if "gid=101&" in url or "gid=102&" in url:
                return lesson_csv
            raise AssertionError(f"unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "data.json"
            original = b"last-known-good\n"
            output.write_bytes(original)
            with (
                mock.patch.object(sys, "argv", ["sync-sheet.py", sync_sheet.DEFAULT_PUB_URL, str(output)]),
                mock.patch.object(sync_sheet, "http_get", side_effect=fake_http_get),
            ):
                result = sync_sheet.main()

            self.assertEqual(result, 5)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
