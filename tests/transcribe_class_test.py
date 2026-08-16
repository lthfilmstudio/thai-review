import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "transcribe_class", ROOT / "scripts" / "transcribe-class.py"
)
transcribe_class = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transcribe_class)


def make_mp4(path, audio_inputs=1, duration=1.0):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for frequency in range(audio_inputs):
        command += ["-f", "lavfi", "-i", f"sine=frequency={440 + frequency * 110}:duration={duration}"]
    command += ["-f", "lavfi", "-i", f"color=c=black:s=160x90:d={duration}"]
    for index in range(audio_inputs):
        command += ["-map", f"{index}:a"]
    command += ["-map", f"{audio_inputs}:v", "-c:a", "aac", "-c:v", "mpeg4", "-shortest", str(path)]
    subprocess.run(command, check=True, capture_output=True)


def write_stt_secrets(path, key="fake-stt-key", scope="speech_to_text", quota="10"):
    path.write_text(
        f"ELEVENLABS_STT_API_KEY={key}\n"
        f"ELEVENLABS_STT_KEY_SCOPE={scope}\n"
        f"ELEVENLABS_STT_CREDIT_QUOTA={quota}\n",
        encoding="utf-8",
    )
    os.chmod(path, 0o600)


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


@unittest.skipUnless(transcribe_class.tool_available("ffmpeg") and transcribe_class.tool_available("ffprobe"), "FFmpeg required")
class MediaPreparationTest(unittest.TestCase):
    def test_valid_mp4_produces_verified_private_mp3_and_disclosure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "260814.mp4"
            make_mp4(source)

            job = transcribe_class.prepare_job([source], root / "out", data_path=None)

            segment = job["segments"][0]
            mp3 = Path(segment["mp3"]["path"])
            self.assertEqual(job["state"], "awaiting_paid_approval")
            self.assertEqual(job["next_action"], "review_paid_disclosure")
            self.assertEqual(segment["state"], "Prepared")
            self.assertTrue(mp3.is_file())
            self.assertEqual(os.stat(mp3).st_mode & 0o777, 0o600)
            self.assertEqual(segment["mp3"]["codec_name"], "mp3")
            self.assertEqual(segment["mp3"]["sample_rate"], 16000)
            self.assertEqual(segment["mp3"]["channels"], 1)
            self.assertGreaterEqual(segment["mp3"]["bit_rate"], 50000)
            self.assertLessEqual(segment["mp3"]["bit_rate"], 80000)
            self.assertEqual(job["approval"]["destination"], "ElevenLabs Speech-to-Text API")
            self.assertIn("standard logging", job["approval"]["retention_disclosure"].lower())
            self.assertEqual(
                job["approval_fingerprint"],
                transcribe_class.paid_input_fingerprint(job["approval"]),
            )

    def test_rejects_no_audio_and_multiple_audio_streams(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            no_audio = root / "no-audio.mp4"
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=black:s=160x90:d=1",
                    "-c:v", "mpeg4", no_audio,
                ],
                check=True,
                capture_output=True,
            )
            with self.assertRaisesRegex(ValueError, "一個可用音軌"):
                transcribe_class.prepare_job([no_audio], root / "out-no-audio", data_path=None)

            multi = root / "multi.mp4"
            make_mp4(multi, audio_inputs=2)
            with self.assertRaisesRegex(ValueError, "一個可用音軌"):
                transcribe_class.prepare_job([multi], root / "out-multi", data_path=None)

    def test_rejects_insufficient_disk_before_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "260814.mp4"
            make_mp4(source)

            with self.assertRaisesRegex(ValueError, "磁碟空間"):
                transcribe_class.prepare_job(
                    [source], root / "out", data_path=None, available_bytes=0
                )
            self.assertFalse((root / "out" / "260814" / "audio" / "260814.mp3").exists())

    def test_second_run_reuses_matching_mp3_but_source_mutation_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "260814.mp4"
            make_mp4(source)
            first = transcribe_class.prepare_job([source], root / "out", data_path=None)
            mp3 = Path(first["segments"][0]["mp3"]["path"])
            first_mtime = mp3.stat().st_mtime_ns

            second = transcribe_class.prepare_job([source], root / "out", data_path=None)
            self.assertEqual(mp3.stat().st_mtime_ns, first_mtime)
            self.assertEqual(second["segments"][0]["mp3"]["sha256"], first["segments"][0]["mp3"]["sha256"])

            source.write_bytes(source.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "來源內容已變更"):
                transcribe_class.prepare_job([source], root / "out", data_path=None)


@unittest.skipUnless(transcribe_class.tool_available("ffmpeg") and transcribe_class.tool_available("ffprobe"), "FFmpeg required")
class PaidGateTest(unittest.TestCase):
    def prepared_job(self, root):
        source = root / "260814.mp4"
        make_mp4(source)
        job = transcribe_class.prepare_job([source], root / "out", data_path=None)
        return source, Path(job["job_root"]) / "job.json"

    def success_runner(self, calls, key="fake-stt-key"):
        def runner(args, **kwargs):
            calls.append((args, kwargs))
            self.assertEqual(args[0:2], ["curl", "-q"])
            self.assertEqual(args[-1], "https://api.elevenlabs.io/v1/speech-to-text")
            self.assertIn("--retry", args)
            self.assertEqual(args[args.index("--retry") + 1], "0")
            self.assertNotIn("--location", args)
            self.assertFalse(any(key in arg for arg in args))
            self.assertFalse(any(key in str(value) for value in kwargs.get("env", {}).values()))
            self.assertIn(key.encode(), kwargs["input_bytes"])
            forms = [args[index + 1] for index, value in enumerate(args) if value == "--form"]
            self.assertIn("model_id=scribe_v2", forms)
            self.assertIn("diarize=true", forms)
            self.assertIn("timestamps_granularity=word", forms)
            self.assertIn("tag_audio_events=false", forms)
            self.assertIn("use_multi_channel=false", forms)
            header_path = Path(args[args.index("--dump-header") + 1])
            body_path = Path(args[args.index("--output") + 1])
            header_path.write_bytes(b"HTTP/1.1 200 OK\r\nrequest-id: req-test\r\nx-trace-id: trace-test\r\n\r\n")
            body_path.write_text(
                json.dumps({
                    "language_code": "th",
                    "text": "สวัสดี",
                    "words": [{
                        "text": "สวัสดี", "start": 0.0, "end": 0.8,
                        "speaker_id": "speaker_0", "type": "word",
                    }],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            return subprocess.CompletedProcess(args, 0, stdout=b"200", stderr=b"")

        return runner

    def test_no_confirmation_and_stale_approval_make_zero_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            calls = []
            key_path = root / "stt.env"
            write_stt_secrets(key_path)

            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )
            self.assertEqual(job["state"], "awaiting_paid_approval")
            self.assertEqual(calls, [])

            stale = transcribe_class.load_json_object(state_path)
            stale["approval"]["request"]["model_id"] = "stale-model"
            stale["approval_fingerprint"] = transcribe_class.paid_input_fingerprint(stale["approval"])
            transcribe_class.atomic_write_json(state_path, stale)
            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )
            self.assertEqual(job["next_action"], "review_updated_paid_disclosure")
            self.assertEqual(calls, [])

    def test_secret_file_scope_quota_and_mode_are_checked_before_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            calls = []

            cases = [
                ("missing.env", None),
                ("tts-only.env", "ELEVENLABS_API_KEY=tts-key\n"),
                ("wrong-scope.env", "ELEVENLABS_STT_API_KEY=x\nELEVENLABS_STT_KEY_SCOPE=text_to_speech\nELEVENLABS_STT_CREDIT_QUOTA=10\n"),
                ("missing-quota.env", "ELEVENLABS_STT_API_KEY=x\nELEVENLABS_STT_KEY_SCOPE=speech_to_text\n"),
            ]
            for name, contents in cases:
                path = root / name
                if contents is not None:
                    path.write_text(contents, encoding="utf-8")
                    os.chmod(path, 0o600)
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):
                        transcribe_class.execute_paid(
                            state_path, [source], confirm_paid_api=True,
                            secrets_path=path, http_runner=self.success_runner(calls, key="x"),
                        )

            wrong_mode = root / "wrong-mode.env"
            write_stt_secrets(wrong_mode, key="x")
            os.chmod(wrong_mode, 0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                transcribe_class.execute_paid(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=wrong_mode, http_runner=self.success_runner(calls, key="x"),
                )
            self.assertEqual(calls, [])

    def test_success_uses_fixed_contract_and_never_persists_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key = "fake-stt-key-never-persist"
            key_path = root / "stt.env"
            write_stt_secrets(key_path, key=key)
            calls = []

            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(calls, key=key),
            )

            self.assertEqual(len(calls), 1)
            self.assertEqual(job["segments"][0]["state"], "Complete")
            self.assertEqual(job["state"], "transcription_complete")
            scribe_path = Path(job["segments"][0]["scribe_path"])
            self.assertEqual(os.stat(scribe_path).st_mode & 0o777, 0o600)
            for path in Path(job["job_root"]).rglob("*"):
                if path.is_file():
                    self.assertNotIn(key.encode(), path.read_bytes())

    def test_timeout_becomes_unknown_and_never_retries_without_dual_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            timeout_calls = []

            def timeout_runner(args, **kwargs):
                timeout_calls.append(args)
                raise subprocess.TimeoutExpired(args, 7200)

            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=timeout_runner,
            )
            self.assertEqual(len(timeout_calls), 1)
            self.assertEqual(job["segments"][0]["state"], "Unknown")

            blocked_calls = []
            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True, force_paid_retry=False,
                secrets_path=key_path, http_runner=self.success_runner(blocked_calls),
            )
            self.assertEqual(job["segments"][0]["state"], "Unknown")
            self.assertEqual(blocked_calls, [])

            retry_calls = []
            job = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True, force_paid_retry=True,
                secrets_path=key_path, http_runner=self.success_runner(retry_calls),
            )
            self.assertEqual(len(retry_calls), 1)
            self.assertEqual(job["segments"][0]["state"], "Complete")

    def test_http_errors_and_truncated_success_are_unknown_without_retry(self):
        cases = [(401, b'{"detail":"bad key"}'), (402, b"{}"), (403, b"{}"),
                 (422, b"{}"), (429, b"{}"), (500, b"{}"), (200, b"{")]
        for status, body in cases:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source, state_path = self.prepared_job(root)
                key_path = root / "stt.env"
                write_stt_secrets(key_path)
                calls = []

                def failure_runner(args, **kwargs):
                    calls.append(args)
                    header_path = Path(args[args.index("--dump-header") + 1])
                    body_path = Path(args[args.index("--output") + 1])
                    header_path.write_bytes(f"HTTP/1.1 {status} Test\r\nrequest-id: req-{status}\r\n\r\n".encode())
                    body_path.write_bytes(body)
                    return subprocess.CompletedProcess(
                        args, 0, stdout=str(status).encode(), stderr=b""
                    )

                job = transcribe_class.execute_paid(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=key_path, http_runner=failure_runner,
                )
                self.assertEqual(len(calls), 1)
                self.assertEqual(job["segments"][0]["state"], "Unknown")

    def test_durable_response_repairs_uploading_without_another_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            first_calls = []
            transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(first_calls),
            )
            crashed = transcribe_class.load_json_object(state_path)
            crashed["segments"][0]["state"] = "Uploading"
            crashed["segments"][0]["next_action"] = "do_not_retry_while_request_in_flight"
            crashed["segments"][0].pop("scribe_sha256")
            crashed["segments"][0]["attempts"][-1]["status"] = "Uploading"
            crashed["state"] = "transcribing"
            transcribe_class.atomic_write_json(state_path, crashed)
            calls = []

            repaired = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )

            self.assertEqual(calls, [])
            self.assertEqual(repaired["segments"][0]["state"], "Complete")
            self.assertEqual(repaired["state"], "transcription_complete")
            self.assertEqual(
                transcribe_class.load_json_object(state_path)["segments"][0]["state"],
                "Complete",
            )

    def test_complete_with_corrupt_artifact_is_persisted_as_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            first_calls = []
            complete = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(first_calls),
            )
            Path(complete["segments"][0]["scribe_path"]).write_text("{}", encoding="utf-8")
            calls = []

            recovered = transcribe_class.execute_paid(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )

            self.assertEqual(calls, [])
            self.assertEqual(recovered["segments"][0]["state"], "Unknown")
            persisted = transcribe_class.load_json_object(state_path)
            self.assertEqual(persisted["segments"][0]["state"], "Unknown")


if __name__ == "__main__":
    unittest.main()
