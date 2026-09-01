import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "backfill-card-ids.py"
SPEC = importlib.util.spec_from_file_location("backfill_card_ids", MODULE_PATH)
backfill_card_ids = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backfill_card_ids)


def catalog(cards, *, source_url="https://docs.google.com/spreadsheets/d/e/test-source-id/pubhtml"):
    return {
        "generated_at": 123,
        "source_url": source_url,
        "lessons": [{"id": "gid-1", "gid": "1", "title": "初 1", "cards": cards}],
    }


def live_snapshot(lesson, *, rows=None, spreadsheet_id="editable-sheet-id"):
    if rows is None:
        rows = [["中文", "泰文", "目的達拼音"], *[
            [card.get("zh", ""), card.get("thai", ""), card.get("karaoke", "")]
            for card in lesson["cards"]
        ]]
    return {
        "spreadsheet_id": spreadsheet_id,
        "sheets": [{
            "gid": lesson["gid"], "sheetId": lesson["gid"],
            "title": lesson["title"], "order": 0, "values": rows,
        }],
    }


class BackfillCardIdsTest(unittest.TestCase):
    def test_verified_manifest_binds_physical_rows_and_preserves_existing_id(self):
        existing = "550E8400-E29B-41D4-A716-446655440000"
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
            {"thai": "第二", "karaoke": "song", "zh": "二", "type": "word", "card_id": existing},
        ]}
        data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
        snapshot = live_snapshot(lesson, rows=[
            ["中文", "泰文", "目的達拼音"],
            ["一", "第一", "dii"],
            ["", "", ""],
            ["二", "第二", "song", "", "", existing],
        ])
        report = backfill_card_ids.build_verified_manifest(data, snapshot)
        self.assertEqual([row["sheet_row"] for row in report["proposals"]], [2, 4])
        self.assertEqual([row["catalog_ordinal"] for row in report["proposals"]], [1, 2])
        self.assertEqual(report["proposals"][1]["old_card_id"], existing.lower())
        self.assertEqual(report["binding_status"], "verified_editable_sheet_snapshot")
        self.assertEqual(report["summary"]["unique_card_id_count"], 2)
        self.assertEqual(len({row["proposed_card_id"] for row in report["proposals"]}), 2)

    def test_orphan_nonblank_rows_abort_but_truly_blank_physical_row_is_allowed(self):
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
        ]}
        data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
        for orphan in (["只有中文", "", ""], ["", "", "只有拼音"], ["", "", "", 10, ""]):
            rows = [["中文", "泰文", "目的達拼音"], orphan, ["一", "第一", "dii"]]
            with self.subTest(orphan=orphan), self.assertRaisesRegex(ValueError, "孤兒"):
                backfill_card_ids.build_verified_manifest(data, live_snapshot(lesson, rows=rows))
        rows = [["中文", "泰文", "目的達拼音"], ["", "", "", "", ""], ["一", "第一", "dii"]]
        report = backfill_card_ids.build_verified_manifest(data, live_snapshot(lesson, rows=rows))
        self.assertEqual(report["proposals"][0]["sheet_row"], 3)

    def test_local_and_verified_modes_share_explicit_canonical_namespace(self):
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
        ]}
        data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
        canonical = "canonical-sheet-for-fixture"
        local = backfill_card_ids.build_dry_run(data, spreadsheet_id_value=canonical)
        live = backfill_card_ids.build_verified_manifest(
            data,
            live_snapshot(lesson, spreadsheet_id="editable-returned-id"),
            canonical_id=canonical,
        )
        self.assertEqual(local["proposals"][0]["proposed_card_id"], live["proposals"][0]["proposed_card_id"])
        self.assertEqual(live["source"]["spreadsheet_id"], "editable-returned-id")
        self.assertEqual(live["source"]["canonical_spreadsheet_id"], canonical)

    def test_fetch_live_snapshot_aborts_when_api_returns_a_different_spreadsheet_id(self):
        class Request:
            def __init__(self, value):
                self.value = value

            def execute(self):
                return self.value

        class Values:
            def batchGet(self, **kwargs):
                return Request({"valueRanges": []})

        class Spreadsheets:
            def get(self, **kwargs):
                return Request({"spreadsheetId": "returned-id", "sheets": []})

            def values(self):
                return Values()

        class Service:
            def spreadsheets(self):
                return Spreadsheets()

        with self.assertRaisesRegex(ValueError, "spreadsheet ID mismatch"):
            backfill_card_ids.fetch_live_snapshot(Service(), "requested-id")

    def test_verified_manifest_accepts_a_to_e_and_optional_card_id_header(self):
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word", "start_ms": 10, "end_ms": 20},
        ]}
        data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
        snapshot = live_snapshot(lesson, rows=[
            ["中文", "泰文", "目的達拼音", "start_ms", "end_ms", "card_id"],
            ["一", "第一", "dii", 10, 20, ""],
        ])
        report = backfill_card_ids.build_verified_manifest(data, snapshot)
        self.assertEqual(report["proposals"][0]["before_values_A_to_E"], ["一", "第一", "dii", 10, 20])

    def test_verified_manifest_aborts_on_header_content_and_row_drift(self):
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
        ]}
        data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
        cases = [
            [["bad", "泰文", "目的達拼音"], ["一", "第一", "dii"]],
            [["中文", "泰文", "目的達拼音"], ["改", "第一", "dii"]],
            [["中文", "泰文", "目的達拼音"], ["一", "第一", "dii", "", "", "not-uuid"]],
        ]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                backfill_card_ids.build_verified_manifest(data, live_snapshot(lesson, rows=rows))

    def test_verified_manifest_aborts_on_duplicate_live_ids(self):
        duplicate = "550e8400-e29b-41d4-a716-446655440000"
        lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": [
            {"thai": "一", "karaoke": "yi", "zh": "一", "type": "word"},
            {"thai": "二", "karaoke": "er", "zh": "二", "type": "word"},
        ]}
        rows = [["中文", "泰文", "目的達拼音"], ["一", "一", "yi", "", "", duplicate], ["二", "二", "er", "", "", duplicate]]
        with self.assertRaisesRegex(ValueError, "duplicate live card_id"):
            backfill_card_ids.build_verified_manifest(
                {"source_url": "https://example.test/pubhtml", "lessons": [lesson]},
                live_snapshot(lesson, rows=rows),
            )
    def test_dry_run_contains_identity_manifest_and_collision_details(self):
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "ซ้ำ", "karaoke": "sam", "zh": "一"},
            {"thai": "ซ้ำ", "karaoke": "sam", "zh": "二"},
            {"thai": "ใหม่", "karaoke": "mai", "zh": "新"},
        ]))

        self.assertEqual(report["summary"]["card_count"], 3)
        self.assertEqual(report["summary"]["collision_group_count"], 1)
        self.assertEqual(report["summary"]["collision_card_count"], 2)
        self.assertEqual(report["binding_status"], "unverified_local_snapshot")
        self.assertEqual(report["write_guard"], "cannot_write_sheet_without_live_binding")
        rows = report["proposals"]
        self.assertEqual([row["catalog_ordinal"] for row in rows], [1, 2, 3])
        self.assertNotIn("source_row", rows[0])
        self.assertEqual(rows[0]["gid"], "1")
        self.assertEqual(rows[0]["lesson_id"], "gid-1")
        self.assertEqual(rows[0]["legacy_alias"], "gid-1:ซ้ำ")
        self.assertIsNone(rows[0]["old_card_id"])
        self.assertTrue(rows[0]["proposed_card_id"])
        self.assertEqual(rows[0]["collision_size"], 2)
        self.assertEqual(rows[0]["collision_group"], rows[1]["collision_group"])
        self.assertIsNone(rows[2]["collision_group"])
        self.assertEqual(len(rows[0]["content_fingerprint"]), 64)
        self.assertTrue(backfill_card_ids.is_uuid(rows[0]["proposed_card_id"]))
        self.assertEqual(report["learning_snapshot_status"], "not_provided")

    def test_proposed_ids_use_content_and_survive_insert_or_reorder_of_different_cards(self):
        cards = [
            {"thai": "甲", "karaoke": "ka", "zh": "甲", "type": "word"},
            {"thai": "乙", "karaoke": "e", "zh": "乙", "type": "word"},
        ]
        first = backfill_card_ids.build_dry_run(catalog(cards))
        changed = catalog([
            {"thai": "插入", "karaoke": "insert", "zh": "插入", "type": "word"},
            cards[1],
            cards[0],
        ])
        second = backfill_card_ids.build_dry_run(json.loads(json.dumps(changed)))
        self.assertEqual(
            first["proposals"][0]["proposed_card_id"],
            second["proposals"][2]["proposed_card_id"],
        )
        self.assertEqual(
            first["proposals"][1]["proposed_card_id"],
            second["proposals"][1]["proposed_card_id"],
        )
        self.assertEqual(
            first["proposals"][0]["proposal_binding_status"],
            "content_deterministic",
        )

    def test_existing_valid_id_is_preserved_and_invalid_id_is_flagged(self):
        existing = "550e8400-e29b-41d4-a716-446655440000"
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "保留", "card_id": existing},
            {"thai": "錯誤", "card_id": "not-a-uuid"},
        ]))
        rows = report["proposals"]
        self.assertEqual(rows[0]["old_card_id"], existing)
        self.assertEqual(rows[0]["proposed_card_id"], existing)
        self.assertEqual(rows[0]["proposal_action"], "preserve_existing")
        self.assertEqual(rows[1]["old_card_id"], "not-a-uuid")
        self.assertEqual(rows[1]["proposal_action"], "add_proposed")
        self.assertEqual(rows[1]["invalid_existing_card_id"], "not-a-uuid")
        self.assertEqual(report["summary"]["invalid_existing_card_id_count"], 1)

    def test_uuid_text_contract_rejects_wrapped_forms_and_normalizes_uppercase(self):
        canonical = "550e8400-e29b-41d4-a716-446655440000"
        uppercase = canonical.upper()
        self.assertTrue(backfill_card_ids.is_uuid(canonical))
        self.assertTrue(backfill_card_ids.is_uuid(uppercase))
        self.assertFalse(backfill_card_ids.is_uuid("{" + canonical + "}"))
        self.assertFalse(backfill_card_ids.is_uuid("urn:uuid:" + canonical))

        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "大寫", "card_id": uppercase},
            {"thai": "大括號", "card_id": "{" + canonical + "}"},
            {"thai": "URN", "card_id": "urn:uuid:" + canonical},
        ]))
        rows = report["proposals"]
        self.assertEqual(rows[0]["proposed_card_id"], canonical)
        self.assertEqual(rows[0]["proposal_action"], "preserve_existing")
        self.assertNotEqual(rows[1]["proposed_card_id"], rows[1]["old_card_id"])
        self.assertNotEqual(rows[2]["proposed_card_id"], rows[2]["old_card_id"])
        self.assertEqual(rows[1]["invalid_existing_card_id"], "{" + canonical + "}")
        self.assertEqual(rows[2]["invalid_existing_card_id"], "urn:uuid:" + canonical)

    def test_duplicate_stable_card_ids_are_quarantined(self):
        duplicate = "550e8400-e29b-41d4-a716-446655440000"
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "甲", "card_id": duplicate},
            {"thai": "乙", "card_id": duplicate.upper()},
        ]))
        rows = report["proposals"]
        self.assertEqual(report["summary"]["duplicate_existing_card_id_count"], 2)
        for row in rows:
            self.assertEqual(row["proposal_action"], "quarantine")
            self.assertEqual(row["proposal_binding_status"], "quarantine_duplicate_stable_card_id")
            self.assertEqual(row["quarantine_reason"], "duplicate_stable_card_id")
            self.assertEqual(row["proposed_card_id"], duplicate)

    def test_duplicate_content_is_marked_as_requiring_live_binding(self):
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "完全相同", "karaoke": "same", "zh": "same"},
            {"thai": "完全相同", "karaoke": "same", "zh": "same"},
        ]))
        rows = report["proposals"]
        self.assertNotEqual(rows[0]["proposed_card_id"], rows[1]["proposed_card_id"])
        self.assertEqual(rows[0]["proposal_binding_status"], "requires_live_binding")
        self.assertEqual(report["summary"]["live_binding_required_count"], 2)

    def test_manifest_write_is_byte_stable(self):
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "甲", "karaoke": "ka", "zh": "甲"},
            {"thai": "乙", "karaoke": "e", "zh": "乙"},
        ]))
        with tempfile.TemporaryDirectory() as tmp:
            first_path = Path(tmp) / "first.json"
            second_path = Path(tmp) / "second.json"
            backfill_card_ids.write_report(report, first_path)
            backfill_card_ids.write_report(backfill_card_ids.build_dry_run(catalog([
                {"thai": "甲", "karaoke": "ka", "zh": "甲"},
                {"thai": "乙", "karaoke": "e", "zh": "乙"},
            ])), second_path)
            self.assertEqual(first_path.read_bytes(), second_path.read_bytes())

    def test_current_catalog_collision_counts_match_read_only_snapshot(self):
        report = backfill_card_ids.build_dry_run(
            backfill_card_ids.load_data(ROOT / "data.json")
        )
        self.assertEqual(report["summary"]["card_count"], 13738)
        self.assertEqual(report["summary"]["collision_group_count"], 618)
        self.assertEqual(report["summary"]["collision_card_count"], 1282)
        self.assertEqual(report["summary"]["unique_card_id_count"], 13738)

    def test_learning_snapshot_reports_collision_intersections(self):
        snapshot = json.loads(
            (ROOT / "tests" / "fixtures" / "card_identity_learning_snapshot.json")
            .read_text(encoding="utf-8")
        )
        report = backfill_card_ids.build_dry_run(
            catalog([
                {"thai": "碰撞", "karaoke": "same", "zh": "一"},
                {"thai": "碰撞", "karaoke": "same", "zh": "二"},
                {"thai": "沒有碰撞", "karaoke": "one", "zh": "三"},
            ]),
            snapshot,
        )
        learning = report["learning_snapshot"]
        self.assertEqual(report["learning_snapshot_status"], "provided")
        self.assertEqual(learning["collision_alias_count"], 1)
        self.assertEqual(learning["collision_aliases_with_nonempty_srs_count"], 1)
        self.assertEqual(learning["collision_aliases_with_nonempty_srs_ratio"], 1)
        self.assertEqual(learning["collision_aliases_with_nonempty_grade_history_count"], 1)
        self.assertEqual(learning["collision_aliases_with_any_learning_count"], 1)
        self.assertEqual(learning["collision_aliases_with_any_learning_ratio"], 1)
        self.assertEqual(learning["details"][0]["legacy_alias"], "gid-1:碰撞")

    def test_learning_snapshot_can_be_omitted_without_inventing_intersections(self):
        report = backfill_card_ids.build_dry_run(catalog([
            {"thai": "碰撞", "karaoke": "same", "zh": "一"},
            {"thai": "碰撞", "karaoke": "same", "zh": "二"},
        ]))
        learning = report["learning_snapshot"]
        self.assertEqual(learning["learning_snapshot_status"], "not_provided")
        self.assertIsNone(learning["collision_aliases_with_nonempty_srs_count"])
        self.assertIsNone(learning["collision_aliases_with_any_learning_count"])
        self.assertEqual(learning["details"], [])


if __name__ == "__main__":
    unittest.main()
