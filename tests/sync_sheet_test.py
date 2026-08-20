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

    def test_fetch_lesson_rejects_an_empty_tab(self):
        with mock.patch.object(sync_sheet, "http_get", return_value="泰文,目的達拼音,中文\n"):
            with self.assertRaisesRegex(ValueError, "沒有可用字卡"):
                sync_sheet.fetch_lesson("https://example.com/sheet", {"gid": "1", "name": "空白課"})

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
        lesson_csv = "泰文,目的達拼音,中文\nสวัสดี,sa wat di,你好\n"
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


if __name__ == "__main__":
    unittest.main()
