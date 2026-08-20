import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "write-dialogues-sheet.py"
SPEC = importlib.util.spec_from_file_location("write_dialogues_sheet", MODULE_PATH)
write_dialogues_sheet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(write_dialogues_sheet)


class WriteDialoguesSheetTest(unittest.TestCase):
    def test_load_rows_keeps_only_the_seven_sheet_columns(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "dialogues.tsv"
            path.write_text(
                "情境 ID\t情境名稱\t順序\t說話者\t泰文\t目的達拼音\t中文\t來源課次\n"
                "D01\t初次見面\t1\tA\tสวัสดีค่ะ\tsa wat di\t你好\t初 1\n",
                encoding="utf-8",
            )
            rows = write_dialogues_sheet.load_rows(path)

        self.assertEqual(rows, [
            ["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"],
            ["D01", "初次見面", 1, "A", "สวัสดีค่ะ", "sa wat di", "你好"],
        ])

    def test_validate_requires_six_alternating_turns_per_scenario(self):
        rows = [["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"]]
        for i in range(1, 7):
            rows.append(["D01", "初次見面", i, "A" if i % 2 else "B", f"th-{i}", f"k-{i}", f"zh-{i}"])

        self.assertEqual(write_dialogues_sheet.validate_rows(rows), 1)

        rows[-1][3] = "A"
        with self.assertRaisesRegex(ValueError, "A/B 各 3 句"):
            write_dialogues_sheet.validate_rows(rows)

    def test_validate_rejects_duplicate_scenario_order(self):
        rows = [
            ["情境 ID", "情境名稱", "順序", "說話者", "泰文", "目的達拼音", "中文"],
            ["D01", "初次見面", 1, "A", "th-1", "k-1", "zh-1"],
            ["D01", "初次見面", 1, "B", "th-2", "k-2", "zh-2"],
        ]
        with self.assertRaisesRegex(ValueError, "順序必須是 1 到 6"):
            write_dialogues_sheet.validate_rows(rows)

    def test_existing_sheet_clears_rows_below_the_approved_content(self):
        rows = [write_dialogues_sheet.HEADERS, ["D01", "初次見面", 1, "A", "th", "k", "zh"]]
        requests = write_dialogues_sheet.build_requests(
            rows,
            123,
            create=False,
            existing_row_count=100,
        )

        clear = requests[0]["updateCells"]
        self.assertEqual(clear["range"]["startRowIndex"], len(rows))
        self.assertEqual(clear["range"]["endRowIndex"], 100)
        self.assertEqual(clear["fields"], "userEnteredValue")
        self.assertNotIn("rows", clear)


if __name__ == "__main__":
    unittest.main()
