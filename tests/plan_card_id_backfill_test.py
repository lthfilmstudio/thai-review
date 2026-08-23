import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "plan-card-id-backfill.py"
SPEC = importlib.util.spec_from_file_location("plan_card_id_backfill", MODULE_PATH)
planner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(planner)


EXISTING_ID = "550e8400-e29b-41d4-a716-446655440000"


def fixture(*, header="", first_id=""):
    cards = [
        {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
        {"thai": "第二", "karaoke": "song", "zh": "二", "type": "word"},
    ]
    lesson = {"id": "L1", "gid": "1", "title": "初 1", "cards": cards}
    data = {"source_url": "https://example.test/pubhtml", "lessons": [lesson]}
    snapshot = {
        "spreadsheet_id": "sheet-1",
        "sheets": [{
            "gid": "1", "sheetId": "1", "title": "初 1", "order": 0,
            "values": [
                ["中文", "泰文", "目的達拼音", "", "", header],
                ["一", "第一", "dii", "", "", first_id],
                ["", "", "", "", "", ""],
                ["二", "第二", "song", "", "", ""],
            ],
        }],
    }
    manifest = planner.BACKFILL.build_verified_manifest(
        data, snapshot, canonical_id="sheet-1"
    )
    raw = planner.BACKFILL.serialize_report(manifest)
    digest = planner.manifest_sha256_bytes(raw)
    return data, snapshot, manifest, raw, digest


def multi_tab_fixture(count=48):
    lessons = []
    sheets = []
    for index in range(count):
        gid = str(index + 1)
        title = f"課 {index + 1}"
        card = {
            "thai": f"泰 {index + 1}",
            "karaoke": f"karaoke {index + 1}",
            "zh": f"中 {index + 1}",
            "type": "word",
        }
        lessons.append({"id": f"L{index + 1}", "gid": gid, "title": title, "cards": [card]})
        sheets.append({
            "gid": gid,
            "sheetId": gid,
            "title": title,
            "order": index,
            "values": [
                ["中文", "泰文", "目的達拼音", "", "", ""],
                [card["zh"], card["thai"], card["karaoke"], "", "", ""],
            ],
        })
    data = {"source_url": "https://example.test/pubhtml", "lessons": lessons}
    snapshot = {"spreadsheet_id": "sheet-48", "sheets": sheets}
    manifest = planner.BACKFILL.build_verified_manifest(
        data, snapshot, canonical_id="sheet-48"
    )
    raw = planner.BACKFILL.serialize_report(manifest)
    return data, snapshot, manifest, planner.manifest_sha256_bytes(raw)


def apply_requests(snapshot, requests):
    result = copy.deepcopy(snapshot)
    by_gid = {str(sheet["gid"]): sheet for sheet in result["sheets"]}
    for request in requests:
        update = request["updateCells"]
        target = by_gid[str(update["range"]["sheetId"])]
        start = update["range"]["startRowIndex"]
        for offset, row_data in enumerate(update["rows"]):
            cell = row_data["values"][0]
            value = cell.get("userEnteredValue", {}).get("stringValue", "")
            target["values"][start + offset][5] = value
    return result


def assert_f_only(test_case, requests):
    for request in requests:
        update = request["updateCells"]
        test_case.assertEqual(update["range"]["startColumnIndex"], 5)
        test_case.assertEqual(update["range"]["endColumnIndex"], 6)
        test_case.assertEqual(update["fields"], "userEnteredValue")
        for row in update["rows"]:
            test_case.assertEqual(len(row["values"]), 1)


class CardIdPlanTest(unittest.TestCase):
    def test_manifest_hash_and_plan_are_deterministic_and_one_f_only_request_per_tab(self):
        data, snapshot, manifest, raw, digest = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_bytes(raw)
            loaded, loaded_digest = planner.load_verified_manifest(path, digest)
        self.assertEqual(loaded_digest, digest)
        plan = planner.build_update_plan(loaded, digest, data, snapshot)
        self.assertEqual(len(plan["requests"]), 1)
        self.assertEqual(plan, planner.build_update_plan(loaded, digest, data, snapshot))
        assert_f_only(self, plan["requests"])
        update = plan["requests"][0]["updateCells"]
        self.assertEqual(update["range"]["startRowIndex"], 0)
        self.assertEqual(update["range"]["endRowIndex"], 4)
        self.assertEqual(len(update["rows"]), 4)
        self.assertEqual(
            [row["values"][0] for row in update["rows"]],
            [
                {"userEnteredValue": {"stringValue": "card_id"}},
                {"userEnteredValue": {"stringValue": manifest["proposals"][0]["proposed_card_id"]}},
                {},
                {"userEnteredValue": {"stringValue": manifest["proposals"][1]["proposed_card_id"]}},
            ],
        )
        self.assertEqual(plan["manifest_sha256"], digest)
        self.assertEqual(len(plan["preflight"]["snapshot_sha256"]), 64)
        self.assertEqual(len(planner.plan_sha256(plan)), 64)
        self.assertEqual(plan["preflight"]["tabs"][0]["before_f_values"], ["", "", "", ""])

    def test_48_tabs_emit_exactly_48_requests(self):
        data, snapshot, manifest, digest = multi_tab_fixture()
        plan = planner.build_update_plan(manifest, digest, data, snapshot)
        self.assertEqual(len(plan["requests"]), 48)
        self.assertEqual(
            [request["updateCells"]["range"]["sheetId"] for request in plan["requests"]],
            list(range(1, 49)),
        )
        assert_f_only(self, plan["requests"])

    def test_hash_mismatch_invalid_and_duplicate_uuid_fail_closed(self):
        data, snapshot, manifest, raw, digest = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                planner.load_verified_manifest(path, "0" * 64)
        invalid = copy.deepcopy(manifest)
        invalid["proposals"][0]["proposed_card_id"] = "not-a-uuid"
        with self.assertRaisesRegex(ValueError, "不是 UUID"):
            planner.validate_manifest_shape(invalid)
        duplicate = copy.deepcopy(manifest)
        duplicate["proposals"][1]["proposed_card_id"] = duplicate["proposals"][0]["proposed_card_id"]
        with self.assertRaisesRegex(ValueError, "duplicate proposed"):
            planner.validate_manifest_shape(duplicate)
        for invalid_digest in ("", "0" * 63, "g" * 64):
            with self.subTest(invalid_digest=invalid_digest), self.assertRaisesRegex(
                ValueError, "SHA-256"
            ):
                planner.build_update_plan(manifest, invalid_digest, data, snapshot)
        with self.assertRaisesRegex(ValueError, "manifest SHA-256 drift"):
            planner.build_update_plan(manifest, "0" * 64, data, snapshot)
        invalid_gid = copy.deepcopy(manifest)
        invalid_gid["proposals"][0]["gid"] = "01"
        with self.assertRaisesRegex(ValueError, "gid 不合法"):
            planner.validate_manifest_shape(invalid_gid)

    def test_preflight_rebuilds_binding_and_rejects_content_old_f_or_tab_drift(self):
        data, snapshot, manifest, _, digest = fixture()
        planner.preflight(manifest, digest, data, snapshot)
        for mutate in (
            lambda value: value["sheets"][0]["values"][1].__setitem__(0, "改掉"),
            lambda value: value["sheets"][0]["values"][1].__setitem__(5, "not-a-uuid"),
            lambda value: value["sheets"][0].__setitem__("title", "錯誤分頁"),
        ):
            changed = copy.deepcopy(snapshot)
            mutate(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                planner.preflight(manifest, digest, data, changed)

    def test_post_write_validates_header_rows_a_to_e_f_and_blank_rows(self):
        data, snapshot, manifest, _, digest = fixture()
        plan = planner.build_update_plan(manifest, digest, data, snapshot)
        plan_digest = planner.plan_sha256(plan)
        post = apply_requests(snapshot, plan["requests"])
        planner.validate_pre_write(manifest, plan, plan_digest, snapshot)
        planner.validate_post_write(manifest, plan, plan_digest, post)

        changed_header = copy.deepcopy(post)
        changed_header["sheets"][0]["values"][0][5] = "wrong-header"
        with self.assertRaisesRegex(ValueError, "F1"):
            planner.validate_post_write(manifest, plan, plan_digest, changed_header)

        changed = copy.deepcopy(post)
        changed["sheets"][0]["values"][2][5] = "orphan"
        with self.assertRaisesRegex(ValueError, "orphan"):
            planner.validate_post_write(manifest, plan, plan_digest, changed)

        partial = copy.deepcopy(post)
        partial["sheets"][0]["values"][3][5] = ""
        with self.assertRaisesRegex(ValueError, "proposed UUID drift"):
            planner.validate_post_write(manifest, plan, plan_digest, partial)
        with self.assertRaisesRegex(ValueError, "pre-write F drift"):
            planner.validate_pre_write(manifest, plan, plan_digest, partial)

        tampered = copy.deepcopy(plan)
        tampered["preflight"]["tabs"][0]["before_f_values"][0] = "tampered"
        with self.assertRaisesRegex(ValueError, "plan SHA-256 mismatch"):
            planner.validate_post_write(manifest, tampered, plan_digest, post)

        for row_index, value, error in (
            (0, "wrong-header", "F1 header drift"),
            (1, "wrong-card", "old_card_id drift"),
            (2, "wrong-blank", "non-proposal F drift"),
        ):
            tampered_before_image = copy.deepcopy(plan)
            tampered_before_image["preflight"]["tabs"][0]["before_f_values"][row_index] = value
            tampered_before_image_digest = planner.plan_sha256(tampered_before_image)
            with self.subTest(row_index=row_index), self.assertRaisesRegex(ValueError, error):
                planner.build_rollback_plan(
                    manifest, tampered_before_image, tampered_before_image_digest, post
                )

        tampered_request = copy.deepcopy(plan)
        tampered_request["requests"][0]["updateCells"]["range"]["startColumnIndex"] = 4
        with self.assertRaisesRegex(ValueError, "plan SHA-256 mismatch"):
            planner.validate_post_write(manifest, tampered_request, plan_digest, post)

    def test_rollback_round_trip_restores_exact_header_and_existing_uuid(self):
        data, snapshot, manifest, _, digest = fixture(
            header="卡片 id", first_id=EXISTING_ID.upper()
        )
        plan = planner.build_update_plan(manifest, digest, data, snapshot)
        plan_digest = planner.plan_sha256(plan)
        current = apply_requests(snapshot, plan["requests"])
        rollback = planner.build_rollback_plan(manifest, plan, plan_digest, current)
        self.assertEqual(len(rollback["requests"]), 1)
        assert_f_only(self, rollback["requests"])
        restored = apply_requests(current, rollback["requests"])
        self.assertEqual(restored, snapshot)
        self.assertEqual(
            [row["values"][0] for row in rollback["requests"][0]["updateCells"]["rows"]],
            [
                {"userEnteredValue": {"stringValue": "卡片 id"}},
                {"userEnteredValue": {"stringValue": EXISTING_ID.upper()}},
                {},
                {},
            ],
        )

    def test_rollback_accepts_partial_write_but_rejects_a_to_e_or_unknown_f_drift(self):
        data, snapshot, manifest, _, digest = fixture()
        plan = planner.build_update_plan(manifest, digest, data, snapshot)
        plan_digest = planner.plan_sha256(plan)
        current = apply_requests(snapshot, plan["requests"])
        current["sheets"][0]["values"][3][5] = ""
        rollback = planner.build_rollback_plan(manifest, plan, plan_digest, current)
        self.assertEqual(apply_requests(current, rollback["requests"]), snapshot)
        for mutate in (
            lambda value: value["sheets"][0]["values"][1].__setitem__(0, "改掉"),
            lambda value: value["sheets"][0]["values"][1].__setitem__(5, "unexpected"),
        ):
            changed = copy.deepcopy(current)
            mutate(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                planner.build_rollback_plan(manifest, plan, plan_digest, changed)

    def test_cli_emits_the_verified_plan_and_rejects_a_wrong_hash(self):
        data, snapshot, _, raw, digest = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = root / "manifest.json"
            data_path = root / "data.json"
            snapshot_path = root / "snapshot.json"
            out_path = root / "plan.json"
            manifest_path.write_bytes(raw)
            data_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            args = [
                "--manifest", str(manifest_path),
                "--expected-sha256", digest,
                "--data", str(data_path),
                "--snapshot", str(snapshot_path),
                "--out", str(out_path),
            ]
            self.assertEqual(planner.main(args), 0)
            emitted = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(emitted["manifest_sha256"], digest)
            self.assertEqual(len(emitted["requests"]), 1)
            out_path.unlink()
            wrong_hash_args = list(args)
            wrong_hash_args[wrong_hash_args.index(digest)] = "0" * 64
            self.assertEqual(planner.main(wrong_hash_args), 2)
            self.assertFalse(out_path.exists())


if __name__ == "__main__":
    unittest.main()
