import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "docs" / "pinyin-conversion" / "write_sheet.py"
SPEC = importlib.util.spec_from_file_location("write_sheet", MODULE_PATH)
write_sheet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(write_sheet)


class WriteSheetTest(unittest.TestCase):
    def test_lookup_uses_lesson_and_thai_not_old_spelling(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            tsv = self.create_temp_tsv(Path(td))
            lookup = write_sheet.load_lookup(tsv)
        self.assertEqual(lookup, {("初 1", "สวัสดี"): "saˇ watˇ"})

    def test_write_plan_is_sparse_and_can_run_against_new_sheet_values(self):
        lookup = {("初 1", "สวัสดี"): "saˇ watˇ"}
        snapshot = [{"values": [["中文", "泰文", "目的達拼音"], ["你好", "สวัสดี", "sawatdee"]]}]
        plan, matched, unmatched = write_sheet.build_write_plan(["初 1"], snapshot, lookup)
        self.assertEqual(matched, 1)
        self.assertEqual(unmatched, 0)
        expected = [{"range": "'初 1'!C2:C2", "values": [["saˇ watˇ"]]}]
        self.assertEqual(plan, expected)

        rerun_snapshot = [{"values": [["中文", "泰文", "目的達拼音"], ["你好", "สวัสดี", "saˇ watˇ"]]}]
        rerun_plan, rerun_matched, _ = write_sheet.build_write_plan(["初 1"], rerun_snapshot, lookup)
        self.assertEqual(rerun_matched, 1)
        self.assertEqual(rerun_plan, plan)

    def test_write_plan_does_not_emit_unmatched_rows(self):
        snapshot = [{"values": [["中文", "泰文", "拼音"], ["你好", "未在對照表", "old"]]}]
        plan, matched, unmatched = write_sheet.build_write_plan(
            ["初 1"], snapshot, {("初 1", "另一個字"): "new"}
        )
        self.assertEqual(plan, [])
        self.assertEqual(matched, 0)
        self.assertEqual(unmatched, 1)

    @staticmethod
    def create_temp_tsv(directory):
        path = directory / "merged.tsv"
        path.write_text(
            "課次\t泰文\t舊拼音(Sheet)\t新拼音(目的達)\n"
            "初 1\tสวัสดี\tsawatdee\tsaˇ watˇ\n",
            encoding="utf-8",
        )
        return path
