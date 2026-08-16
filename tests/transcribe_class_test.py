import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "transcribe_class", ROOT / "scripts" / "transcribe-class.py"
)
transcribe_class = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transcribe_class)


class DurableStateTest(unittest.TestCase):
    def test_orders_numeric_suffixes_and_derives_job_id(self):
        paths = [Path(f"260814-{suffix}.mp4") for suffix in [10, 2, 1, 9, 8, 7, 6, 5, 4, 3]]

        ordered, job_id = transcribe_class.order_sources(paths)

        self.assertEqual([path.name for path in ordered], [f"260814-{suffix}.mp4" for suffix in range(1, 11)])
        self.assertEqual(job_id, "260814")

    def test_rejects_missing_or_duplicate_numeric_suffixes(self):
        with self.assertRaisesRegex(ValueError, "連續"):
            transcribe_class.order_sources([Path("260814-1.mp4"), Path("260814-3.mp4")])
        with self.assertRaisesRegex(ValueError, "重複"):
            transcribe_class.order_sources([Path("260814-1.mp4"), Path("260814-01.mp4")])
        with self.assertRaisesRegex(ValueError, "數字尾碼"):
            transcribe_class.order_sources([Path("260814.mp4"), Path("260814-b.mp4")])

    def test_single_source_uses_stem_as_job_id(self):
        ordered, job_id = transcribe_class.order_sources([Path("260814.mp4")])
        self.assertEqual(ordered, [Path("260814.mp4")])
        self.assertEqual(job_id, "260814")

    def test_safe_job_root_rejects_unsafe_ids_and_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "out"
            output_root.mkdir()
            unsafe = ["", ".", "..", "/tmp/x", "a/b", "a\\b", "bad\nname", "x" * 81]
            for job_id in unsafe:
                with self.subTest(job_id=job_id):
                    with self.assertRaises(ValueError):
                        transcribe_class.safe_job_root(output_root, job_id)

            outside = Path(tmp) / "outside"
            outside.mkdir()
            (output_root / "linked").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                transcribe_class.safe_job_root(output_root, "linked")

            self.assertEqual(transcribe_class.safe_job_root(output_root, "260814"), output_root / "260814")

    def test_paid_fingerprint_is_deterministic_and_sensitive(self):
        summary = {
            "segments": [{"source_sha256": "a", "mp3_sha256": "b"}],
            "request": {"model_id": "scribe_v2", "diarize": True},
            "estimate": {"billed_minutes": 2, "buffered_usd": "0.009"},
        }
        reordered = {
            "estimate": {"buffered_usd": "0.009", "billed_minutes": 2},
            "request": {"diarize": True, "model_id": "scribe_v2"},
            "segments": [{"mp3_sha256": "b", "source_sha256": "a"}],
        }
        changed = json.loads(json.dumps(summary))
        changed["segments"][0]["mp3_sha256"] = "c"

        self.assertEqual(
            transcribe_class.paid_input_fingerprint(summary),
            transcribe_class.paid_input_fingerprint(reordered),
        )
        self.assertNotEqual(
            transcribe_class.paid_input_fingerprint(summary),
            transcribe_class.paid_input_fingerprint(changed),
        )

    def test_estimate_rounds_each_segment_and_enforces_caps(self):
        estimate = transcribe_class.estimate_paid_usage([60.1, 60.1])
        self.assertEqual(estimate["billed_minutes"], 4)
        self.assertEqual(estimate["raw_usd"], "0.0147")
        self.assertEqual(estimate["buffered_usd"], "0.0161")

        boundary = transcribe_class.estimate_paid_usage([60 * 60, 60 * 60])
        self.assertEqual(boundary["billed_minutes"], 120)
        self.assertEqual(boundary["buffered_usd"], "0.4840")
        self.assertTrue(transcribe_class.within_paid_caps(boundary))

        over_duration = dict(boundary, total_seconds=7200.1)
        self.assertFalse(transcribe_class.within_paid_caps(over_duration))
        over_cost = dict(boundary, buffered_usd="0.5001")
        self.assertFalse(transcribe_class.within_paid_caps(over_cost))

    def test_atomic_json_has_private_mode_and_rejects_malformed_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "job"
            transcribe_class.ensure_private_dir(root)
            target = root / "job.json"
            transcribe_class.atomic_write_json(target, {"version": 1, "state": "prepared"})

            self.assertEqual(os.stat(root).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)
            self.assertEqual(transcribe_class.load_json_object(target)["state"], "prepared")
            self.assertEqual(list(root.glob(".*.tmp-*")), [])

            target.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "JSON"):
                transcribe_class.load_json_object(target)

    def test_data_snapshot_records_hash_generated_at_cards_and_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "data.json"
            payload = {
                "generated_at": "2026-08-16 12:00:00 CST",
                "lessons": [
                    {"cards": [{"thai": "ก"}, {"thai": "ข"}]},
                    {"cards": [{"thai": "ค"}]},
                ],
            }
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            path.write_bytes(raw)

            snapshot = transcribe_class.capture_data_snapshot(path)

            self.assertEqual(snapshot["generated_at"], payload["generated_at"])
            self.assertEqual(snapshot["lesson_count"], 2)
            self.assertEqual(snapshot["card_count"], 3)
            self.assertEqual(snapshot["size_bytes"], len(raw))
            self.assertEqual(len(snapshot["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
