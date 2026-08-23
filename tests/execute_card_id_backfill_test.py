import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


planner = load_module(
    "plan_card_id_backfill_for_executor_test",
    ROOT / "scripts" / "plan-card-id-backfill.py",
)
executor = load_module(
    "execute_card_id_backfill",
    ROOT / "scripts" / "execute-card-id-backfill.py",
)


def fixture(*, canonical_id="sheet-1"):
    cards = [
        {"thai": "第一", "karaoke": "dii", "zh": "一", "type": "word"},
        {"thai": "第二", "karaoke": "song", "zh": "二", "type": "word"},
    ]
    data = {
        "source_url": "https://example.test/pubhtml",
        "lessons": [{"id": "L1", "gid": "1", "title": "初 1", "cards": cards}],
    }
    snapshot = {
        "spreadsheet_id": "sheet-1",
        "sheets": [{
            "gid": "1",
            "sheetId": "1",
            "title": "初 1",
            "order": 0,
            "values": [
                ["中文", "泰文", "目的達拼音", "", "", ""],
                ["一", "第一", "dii", "", "", ""],
                ["", "", "", "", "", ""],
                ["二", "第二", "song", "", "", ""],
            ],
        }],
    }
    manifest = planner.BACKFILL.build_verified_manifest(
        data, snapshot, canonical_id=canonical_id
    )
    manifest_digest = planner.manifest_sha256_bytes(
        planner.BACKFILL.serialize_report(manifest)
    )
    plan = planner.build_update_plan(manifest, manifest_digest, data, snapshot)
    plan_digest = planner.plan_sha256(plan)
    post = apply_requests(snapshot, plan["requests"])
    return snapshot, post, manifest, manifest_digest, plan, plan_digest


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


class FakeTransport:
    def __init__(self, snapshots, *, response=None, write_error=None):
        self.snapshots = [copy.deepcopy(value) for value in snapshots]
        self.response = response
        self.write_error = write_error
        self.fetch_calls = []
        self.write_calls = []
        self.events = []

    def fetch_snapshot(self, spreadsheet_id):
        self.events.append("fetch")
        self.fetch_calls.append(spreadsheet_id)
        if not self.snapshots:
            raise AssertionError("unexpected snapshot fetch")
        value = self.snapshots.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    def batch_update(self, spreadsheet_id, requests):
        self.events.append("batch_update")
        self.write_calls.append((spreadsheet_id, copy.deepcopy(requests)))
        if self.write_error:
            raise self.write_error
        return copy.deepcopy(self.response)


class ExecuteCardIdBackfillTest(unittest.TestCase):
    def arguments(self):
        before, post, manifest, manifest_digest, plan, plan_digest = fixture()
        token = executor.approval_fingerprint(
            spreadsheet_id="sheet-1",
            expected_manifest_sha256=manifest_digest,
            expected_plan_sha256=plan_digest,
        )
        return before, post, {
            "manifest": manifest,
            "plan": plan,
            "spreadsheet_id": "sheet-1",
            "expected_manifest_sha256": manifest_digest,
            "expected_plan_sha256": plan_digest,
            "confirm_write": True,
            "provided_approval_fingerprint": token,
        }

    def test_happy_path_makes_one_write_and_verifies_fresh_post_snapshot(self):
        before, post, base = self.arguments()
        transport = FakeTransport(
            [before, post],
            response={"spreadsheetId": "sheet-1", "replies": [{}]},
        )
        base["transport"] = transport

        result = executor.execute_approved_plan(**base)

        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["request_count"], 1)
        self.assertNotIn("response_validation_warning", result)
        self.assertEqual(transport.fetch_calls, ["sheet-1", "sheet-1"])
        self.assertEqual(transport.write_calls, [("sheet-1", base["plan"]["requests"])])
        self.assertEqual(transport.events, ["fetch", "batch_update", "fetch"])

    def test_canonical_uuid_namespace_matches_across_evidence_not_physical_target(self):
        before, post, manifest, manifest_digest, plan, plan_digest = fixture(
            canonical_id="card-uuid-namespace"
        )
        transport = FakeTransport(
            [before, post],
            response={"spreadsheetId": "sheet-1", "replies": [{}]},
        )
        token = executor.approval_fingerprint(
            spreadsheet_id="sheet-1",
            expected_manifest_sha256=manifest_digest,
            expected_plan_sha256=plan_digest,
        )

        result = executor.execute_approved_plan(
            manifest=manifest,
            plan=plan,
            spreadsheet_id="sheet-1",
            expected_manifest_sha256=manifest_digest,
            expected_plan_sha256=plan_digest,
            confirm_write=True,
            provided_approval_fingerprint=token,
            transport=transport,
        )

        self.assertEqual(result["status"], "verified")
        self.assertEqual(plan["canonical_spreadsheet_id"], "card-uuid-namespace")

    def test_missing_or_wrong_approval_identity_or_hash_stops_before_transport(self):
        before, post, base = self.arguments()
        cases = (
            {"confirm_write": False},
            {"provided_approval_fingerprint": None},
            {"provided_approval_fingerprint": "0" * 64},
            {"spreadsheet_id": "wrong-sheet"},
            {"expected_manifest_sha256": "0" * 64},
            {"expected_plan_sha256": "0" * 64},
        )
        for changes in cases:
            transport = FakeTransport([before, post])
            arguments = {**base, **changes, "transport": transport}
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                executor.execute_approved_plan(**arguments)
            self.assertEqual(transport.fetch_calls, [])
            self.assertEqual(transport.write_calls, [])

    def test_prewrite_drift_makes_zero_writes(self):
        before, _, base = self.arguments()
        drifted = copy.deepcopy(before)
        drifted["sheets"][0]["values"][1][0] = "內容已改"
        transport = FakeTransport([drifted])
        base["transport"] = transport

        with self.assertRaisesRegex(ValueError, "A:E drift"):
            executor.execute_approved_plan(**base)

        self.assertEqual(transport.fetch_calls, ["sheet-1"])
        self.assertEqual(transport.write_calls, [])

    def test_write_exception_surfaces_f_only_rollback_without_retrying(self):
        before, post, base = self.arguments()
        transport = FakeTransport(
            [before, post], write_error=RuntimeError("transport exploded")
        )
        base["transport"] = transport

        with self.assertRaises(executor.BackfillExecutionError) as raised:
            executor.execute_approved_plan(**base)

        error = raised.exception
        self.assertEqual(error.stage, "write")
        self.assertIsNotNone(error.rollback_plan)
        self.assert_f_only(error.rollback_plan["requests"])
        self.assertEqual(len(transport.write_calls), 1)
        self.assertEqual(transport.fetch_calls, ["sheet-1", "sheet-1"])

    def test_postwrite_drift_surfaces_rollback_and_never_auto_runs_it(self):
        before, post, base = self.arguments()
        partial = copy.deepcopy(post)
        partial["sheets"][0]["values"][3][5] = ""
        transport = FakeTransport(
            [before, partial],
            response={"spreadsheetId": "sheet-1", "replies": [{}]},
        )
        base["transport"] = transport

        with self.assertRaises(executor.BackfillExecutionError) as raised:
            executor.execute_approved_plan(**base)

        error = raised.exception
        self.assertEqual(error.stage, "post_write")
        self.assert_f_only(error.rollback_plan["requests"])
        self.assertEqual(len(transport.write_calls), 1)

    def test_response_mismatch_is_warning_when_fresh_readback_is_exact(self):
        before, post, base = self.arguments()
        transport = FakeTransport(
            [before, post],
            response={"spreadsheetId": "sheet-1", "replies": []},
        )
        base["transport"] = transport

        result = executor.execute_approved_plan(**base)

        self.assertEqual(result["status"], "verified")
        self.assertEqual(
            result["response_validation_warning"],
            "batchUpdate response replies count/shape mismatch",
        )
        self.assertEqual(len(transport.write_calls), 1)
        self.assertEqual(transport.fetch_calls, ["sheet-1", "sheet-1"])
        self.assertEqual(transport.events, ["fetch", "batch_update", "fetch"])

    def test_response_mismatch_with_bad_post_state_fails_closed(self):
        before, post, base = self.arguments()
        partial = copy.deepcopy(post)
        partial["sheets"][0]["values"][3][5] = ""
        transport = FakeTransport(
            [before, partial],
            response={"spreadsheetId": "sheet-1", "replies": []},
        )
        base["transport"] = transport

        with self.assertRaises(executor.BackfillExecutionError) as raised:
            executor.execute_approved_plan(**base)

        error = raised.exception
        self.assertEqual(error.stage, "post_write")
        self.assert_f_only(error.rollback_plan["requests"])
        self.assertEqual(len(transport.write_calls), 1)
        self.assertEqual(transport.events, ["fetch", "batch_update", "fetch"])

    def test_response_mismatch_with_postread_failure_still_surfaces_rollback_evidence(self):
        before, post, base = self.arguments()
        transport = FakeTransport(
            [before, RuntimeError("read-back unavailable"), post],
            response={"spreadsheetId": "sheet-1", "replies": []},
        )
        base["transport"] = transport

        with self.assertRaises(executor.BackfillExecutionError) as raised:
            executor.execute_approved_plan(**base)

        error = raised.exception
        self.assertEqual(error.stage, "post_read")
        self.assert_f_only(error.rollback_plan["requests"])
        self.assertEqual(len(transport.write_calls), 1)
        self.assertEqual(transport.fetch_calls, ["sheet-1", "sheet-1", "sheet-1"])

    def assert_f_only(self, requests):
        for request in requests:
            update = request["updateCells"]
            self.assertEqual(update["range"]["startColumnIndex"], 5)
            self.assertEqual(update["range"]["endColumnIndex"], 6)
            self.assertEqual(update["fields"], "userEnteredValue")


if __name__ == "__main__":
    unittest.main()
