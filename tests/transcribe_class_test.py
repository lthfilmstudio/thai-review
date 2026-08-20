import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "transcribe_class", ROOT / "scripts" / "transcribe-class.py"
)
transcribe_class = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transcribe_class)


def make_mp4(path, audio_inputs=1, duration=1.0, default_audio=0):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for frequency in range(audio_inputs):
        command += ["-f", "lavfi", "-i", f"sine=frequency={440 + frequency * 110}:duration={duration}"]
    command += ["-f", "lavfi", "-i", f"color=c=black:s=160x90:d={duration}"]
    for index in range(audio_inputs):
        command += ["-map", f"{index}:a"]
    command += ["-map", f"{audio_inputs}:v", "-c:a", "aac", "-c:v", "mpeg4", "-shortest"]
    if default_audio is None:
        for index in range(audio_inputs):
            command += [f"-disposition:a:{index}", "default"]
    else:
        command += [f"-disposition:a:{default_audio}", "default"]
    command += [str(path)]
    subprocess.run(command, check=True, capture_output=True)


def write_stt_secrets(
    path, key="fake-stt-key", scope="speech_to_text", quota=None,
    provider_guard="ip_allowlist",
):
    guard = (
        f"ELEVENLABS_STT_CREDIT_QUOTA={quota}\n" if quota is not None
        else f"ELEVENLABS_STT_PROVIDER_GUARD={provider_guard}\n"
    )
    path.write_text(
        f"ELEVENLABS_STT_API_KEY={key}\n"
        f"ELEVENLABS_STT_KEY_SCOPE={scope}\n"
        f"{guard}",
        encoding="utf-8",
    )
    os.chmod(path, 0o600)


def execute_with_saved_approval(state_path, sources, **kwargs):
    if kwargs.get("confirm_paid_api") and "approval_fingerprint" not in kwargs:
        kwargs["approval_fingerprint"] = transcribe_class.load_json_object(state_path)[
            "approval_fingerprint"
        ]
    return transcribe_class.execute_paid(state_path, sources, **kwargs)


class DurableStateTest(unittest.TestCase):
    def test_paid_confirmation_requires_exact_echoed_fingerprint(self):
        with self.assertRaisesRegex(SystemExit, "approval-fingerprint"):
            transcribe_class.main([
                "example.mp4", "--confirm-paid-api",
            ])
        with self.assertRaisesRegex(SystemExit, "64 位"):
            transcribe_class.main([
                "example.mp4", "--confirm-paid-api", "--approval-fingerprint", "short",
            ])
        with self.assertRaisesRegex(SystemExit, "只可"):
            transcribe_class.main([
                "example.mp4", "--approval-fingerprint", "0" * 64,
            ])

    def test_status_can_use_job_id_without_repeating_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "out"
            job_root = output_root / "260814"
            transcribe_class.ensure_private_dir(job_root)
            transcribe_class.atomic_write_json(
                job_root / "job.json",
                {
                    "job_id": "260814",
                    "state": "awaiting_paid_approval",
                    "next_action": "review_paid_disclosure",
                },
            )
            stdout = io.StringIO()

            with redirect_stdout(stdout):
                result = transcribe_class.main(
                    ["--status", "--job-id", "260814", "--out-root", str(output_root)]
                )

            self.assertEqual(result, 0)
            self.assertEqual(json.loads(stdout.getvalue())["state"], "awaiting_paid_approval")

    def test_preparation_and_paid_recovery_still_require_sources(self):
        with self.assertRaisesRegex(SystemExit, "preparation 必須"):
            transcribe_class.main([])
        with self.assertRaisesRegex(SystemExit, "重新提供原始 MP4"):
            transcribe_class.main(["--recover-unknown", "--job-id", "260814"])

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

    def test_rate_freshness_has_a_fixed_thirty_day_boundary(self):
        self.assertTrue(transcribe_class.rate_check_is_fresh(date(2026, 9, 15)))
        self.assertFalse(transcribe_class.rate_check_is_fresh(date(2026, 9, 16)))


@unittest.skipUnless(transcribe_class.tool_available("ffmpeg") and transcribe_class.tool_available("ffprobe"), "FFmpeg required")
class MediaPreparationTest(unittest.TestCase):
    def test_free_preparation_uses_global_paid_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "260814.mp4"
            make_mp4(source)
            first = transcribe_class.prepare_job([source], root / "out", data_path=None)
            state_path = Path(first["job_root"]) / "job.json"
            before = state_path.read_bytes()

            with transcribe_class.paid_execution_lock(state_path):
                with self.assertRaisesRegex(ValueError, "另一個本機付費"):
                    transcribe_class.prepare_job([source], root / "out", data_path=None)

            self.assertEqual(state_path.read_bytes(), before)

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

    def test_rejects_no_audio_and_ambiguous_multiple_audio_streams(self):
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
            with self.assertRaisesRegex(ValueError, "沒有可用音軌"):
                transcribe_class.prepare_job([no_audio], root / "out-no-audio", data_path=None)

            multi = root / "multi.mp4"
            make_mp4(multi, audio_inputs=2, default_audio=None)
            with self.assertRaisesRegex(ValueError, "無法安全自動選擇"):
                transcribe_class.prepare_job([multi], root / "out-multi", data_path=None)

    def test_multiple_audio_streams_use_the_unique_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "260814.mp4"
            make_mp4(source, audio_inputs=2, default_audio=1)

            job = transcribe_class.prepare_job([source], root / "out", data_path=None)

            source_details = job["segments"][0]["source"]
            self.assertEqual(source_details["audio_stream_count"], 2)
            self.assertEqual(source_details["audio_stream_selection"], "unique_default_audio_stream")
            self.assertEqual(source_details["audio_stream_index"], 1)

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
            self.assertFalse(any(name.upper().startswith("ELEVENLABS") for name in kwargs.get("env", {})))
            self.assertFalse(any(key in str(value) for value in kwargs.get("env", {}).values()))
            self.assertIn(key.encode(), kwargs["input_bytes"])
            forms = [args[index + 1] for index, value in enumerate(args) if value == "--form"]
            self.assertIn("model_id=scribe_v2", forms)
            self.assertIn("diarize=true", forms)
            self.assertIn("timestamps_granularity=word", forms)
            self.assertIn("tag_audio_events=false", forms)
            self.assertIn("use_multi_channel=false", forms)
            self.assertIn("detect_speaker_roles=false", forms)
            self.assertIn("use_speaker_library=true", forms)
            self.assertFalse(any(form.startswith("speaker_roles=") for form in forms))
            self.assertFalse(any(form.startswith("speaker_library=") for form in forms))
            self.assertFalse(any(form.startswith("keyterms=") for form in forms))
            self.assertFalse(any(form.startswith("entity_detection=") for form in forms))
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

            job = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )
            self.assertEqual(job["state"], "awaiting_paid_approval")
            self.assertEqual(calls, [])

            stale = transcribe_class.load_json_object(state_path)
            stale["approval"]["request"]["model_id"] = "stale-model"
            stale["approval_fingerprint"] = transcribe_class.paid_input_fingerprint(stale["approval"])
            transcribe_class.atomic_write_json(state_path, stale)
            job = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )
            self.assertEqual(job["next_action"], "review_updated_paid_disclosure")
            self.assertEqual(calls, [])

    def test_missing_or_wrong_approval_fingerprint_stops_before_key_or_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            calls = []

            with self.assertRaisesRegex(ValueError, "64 位 approval fingerprint"):
                transcribe_class.execute_paid(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=root / "missing.env", http_runner=self.success_runner(calls),
                )
            with self.assertRaisesRegex(ValueError, "目前付費揭露不符"):
                transcribe_class.execute_paid(
                    state_path, [source], confirm_paid_api=True,
                    approval_fingerprint="0" * 64,
                    secrets_path=root / "missing.env", http_runner=self.success_runner(calls),
                )

            self.assertEqual(calls, [])

    def test_secret_file_scope_provider_guard_and_mode_are_checked_before_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            calls = []

            cases = [
                ("missing.env", None),
                ("tts-only.env", "ELEVENLABS_API_KEY=tts-key\n"),
                ("wrong-scope.env", "ELEVENLABS_STT_API_KEY=x\nELEVENLABS_STT_KEY_SCOPE=text_to_speech\nELEVENLABS_STT_CREDIT_QUOTA=10\n"),
                ("missing-guard.env", "ELEVENLABS_STT_API_KEY=x\nELEVENLABS_STT_KEY_SCOPE=speech_to_text\n"),
                ("wrong-guard.env", "ELEVENLABS_STT_API_KEY=x\nELEVENLABS_STT_KEY_SCOPE=speech_to_text\nELEVENLABS_STT_PROVIDER_GUARD=none\n"),
            ]
            for name, contents in cases:
                path = root / name
                if contents is not None:
                    path.write_text(contents, encoding="utf-8")
                    os.chmod(path, 0o600)
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):
                        execute_with_saved_approval(
                            state_path, [source], confirm_paid_api=True,
                            secrets_path=path, http_runner=self.success_runner(calls, key="x"),
                        )

            wrong_mode = root / "wrong-mode.env"
            write_stt_secrets(wrong_mode, key="x")
            os.chmod(wrong_mode, 0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                execute_with_saved_approval(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=wrong_mode, http_runner=self.success_runner(calls, key="x"),
                )
            self.assertEqual(calls, [])

            quota_path = root / "quota.env"
            write_stt_secrets(quota_path, key="quota-key", quota="1000")
            loaded = transcribe_class.load_stt_secrets(quota_path)
            self.assertEqual(loaded["provider_guard"], "credit_quota")
            self.assertEqual(loaded["credit_quota"], "1000")

    def test_success_uses_fixed_contract_and_never_persists_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key = "fake-stt-key-never-persist"
            key_path = root / "stt.env"
            write_stt_secrets(key_path, key=key)
            calls = []

            job = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(calls, key=key),
            )

            self.assertEqual(len(calls), 1)
            self.assertEqual(job["segments"][0]["state"], "Complete")
            self.assertEqual(job["state"], "needs_tsv_review")
            request = job["approval"]["request"]
            self.assertIs(request["detect_speaker_roles"], False)
            self.assertIs(request["use_speaker_library"], True)
            self.assertEqual(request["keyterms"], [])
            self.assertIsNone(request["entity_detection"])
            self.assertNotIn("speaker_roles", request)
            self.assertNotIn("speaker_library", request)
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

            job = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=timeout_runner,
            )
            self.assertEqual(len(timeout_calls), 1)
            self.assertEqual(job["segments"][0]["state"], "Unknown")

            blocked_calls = []
            job = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True, force_paid_retry=False,
                secrets_path=key_path, http_runner=self.success_runner(blocked_calls),
            )
            self.assertEqual(job["segments"][0]["state"], "Unknown")
            self.assertEqual(blocked_calls, [])

            retry_calls = []
            job = execute_with_saved_approval(
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

                job = execute_with_saved_approval(
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
            execute_with_saved_approval(
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

            repaired = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )

            self.assertEqual(calls, [])
            self.assertEqual(repaired["segments"][0]["state"], "Complete")
            self.assertEqual(repaired["state"], "needs_tsv_review")
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
            complete = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(first_calls),
            )
            Path(complete["segments"][0]["scribe_path"]).write_text("{}", encoding="utf-8")
            calls = []

            recovered = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=False,
                secrets_path=key_path, http_runner=self.success_runner(calls),
            )

            self.assertEqual(calls, [])
            self.assertEqual(recovered["segments"][0]["state"], "Unknown")
            persisted = transcribe_class.load_json_object(state_path)
            self.assertEqual(persisted["segments"][0]["state"], "Unknown")

    def test_unknown_with_transcription_id_recovers_by_get_without_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)

            def timeout_runner(args, **kwargs):
                raise subprocess.TimeoutExpired(args, 7200)

            execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=timeout_runner,
            )
            unknown = transcribe_class.load_json_object(state_path)
            unknown["segments"][0]["attempts"][-1]["identifiers"] = {
                "transcription_id": "transcript-test-1"
            }
            transcribe_class.atomic_write_json(state_path, unknown)
            calls = []

            def get_runner(args, **kwargs):
                calls.append(args)
                self.assertIn("GET", args)
                self.assertNotIn("POST", args)
                self.assertFalse(any(value == "--form" for value in args))
                self.assertEqual(
                    args[-1],
                    "https://api.elevenlabs.io/v1/speech-to-text/transcripts/transcript-test-1",
                )
                header_path = Path(args[args.index("--dump-header") + 1])
                body_path = Path(args[args.index("--output") + 1])
                header_path.write_bytes(b"HTTP/1.1 200 OK\r\nrequest-id: recover-test\r\n\r\n")
                body_path.write_text(
                    json.dumps({
                        "language_code": "th", "text": "กู้คืนแล้ว",
                        "words": [{
                            "text": "กู้คืนแล้ว", "start": 0.0, "end": 0.8,
                            "speaker_id": "speaker_0", "type": "word",
                        }],
                    }, ensure_ascii=False),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(args, 0, stdout=b"200", stderr=b"")

            recovered = transcribe_class.recover_unknown(
                state_path, [source], secrets_path=key_path, http_runner=get_runner
            )

            self.assertEqual(len(calls), 1)
            self.assertEqual(recovered["segments"][0]["state"], "Complete")
            self.assertEqual(recovered["state"], "needs_tsv_review")
            self.assertTrue(Path(recovered["combined_transcript"]["path"]).is_file())

    def test_partial_success_requires_updated_approval_and_only_resends_incomplete_part(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sources = [root / "260814-1.mp4", root / "260814-2.mp4"]
            for source in sources:
                make_mp4(source)
            job = transcribe_class.prepare_job(sources, root / "out", data_path=None)
            state_path = Path(job["job_root"]) / "job.json"
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            first_calls = []
            success = self.success_runner(first_calls)

            def mixed_runner(args, **kwargs):
                if not first_calls:
                    return success(args, **kwargs)
                first_calls.append((args, kwargs))
                raise subprocess.TimeoutExpired(args, 7200)

            partial = execute_with_saved_approval(
                state_path, sources, confirm_paid_api=True,
                secrets_path=key_path, http_runner=mixed_runner,
            )
            self.assertEqual(len(first_calls), 2)
            self.assertEqual([segment["state"] for segment in partial["segments"]], ["Complete", "Unknown"])

            stale_calls = []
            refreshed = execute_with_saved_approval(
                state_path, sources, confirm_paid_api=True, force_paid_retry=True,
                secrets_path=key_path, http_runner=self.success_runner(stale_calls),
            )
            self.assertEqual(stale_calls, [])
            self.assertEqual(refreshed["next_action"], "review_updated_paid_disclosure")
            self.assertEqual(len(refreshed["approval"]["segments"]), 1)
            expected_estimate = transcribe_class.estimate_paid_usage([
                partial["segments"][1]["mp3"]["duration_seconds"]
            ])
            self.assertEqual(
                refreshed["approval"]["estimate"]["billed_minutes"],
                expected_estimate["billed_minutes"],
            )
            self.assertEqual(
                refreshed["approval"]["estimate"]["buffered_usd"],
                expected_estimate["buffered_usd"],
            )

            retry_calls = []
            complete = execute_with_saved_approval(
                state_path, sources, confirm_paid_api=True, force_paid_retry=True,
                secrets_path=key_path, http_runner=self.success_runner(retry_calls),
            )
            self.assertEqual(len(retry_calls), 1)
            self.assertEqual(complete["state"], "needs_tsv_review")

    def test_durable_uploading_sync_failure_prevents_runner_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            calls = []
            original_sync = transcribe_class._common._fsync_directory

            def fail_sync(path):
                raise OSError("simulated directory sync failure")

            transcribe_class._common._fsync_directory = fail_sync
            try:
                with self.assertRaises(OSError):
                    execute_with_saved_approval(
                        state_path, [source], confirm_paid_api=True,
                        secrets_path=key_path, http_runner=self.success_runner(calls),
                    )
            finally:
                transcribe_class._common._fsync_directory = original_sync
            self.assertEqual(calls, [])

    def test_scribe_persistence_failure_after_launch_becomes_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            calls = []
            original_write = transcribe_class._paid.atomic_write_json

            def fail_scribe_only(path, value):
                if Path(path).parent.name == "scribe":
                    raise OSError("simulated scribe disk failure")
                return original_write(path, value)

            transcribe_class._paid.atomic_write_json = fail_scribe_only
            try:
                unknown = execute_with_saved_approval(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=key_path, http_runner=self.success_runner(calls),
                )
            finally:
                transcribe_class._paid.atomic_write_json = original_write
            self.assertEqual(len(calls), 1)
            self.assertEqual(unknown["segments"][0]["state"], "Unknown")

    def test_valid_final_scribe_artifact_recovers_after_parent_fsync_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            calls = []
            original_sync = transcribe_class._common._fsync_directory
            failed_once = False

            def fail_after_scribe_sync(path):
                nonlocal failed_once
                original_sync(path)
                if Path(path).name == "scribe" and not failed_once:
                    failed_once = True
                    raise OSError("simulated post-replace directory sync error")

            transcribe_class._common._fsync_directory = fail_after_scribe_sync
            try:
                complete = execute_with_saved_approval(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=key_path, http_runner=self.success_runner(calls),
                )
            finally:
                transcribe_class._common._fsync_directory = original_sync

            self.assertEqual(len(calls), 1)
            self.assertTrue(failed_once)
            self.assertEqual(complete["segments"][0]["state"], "Complete")
            self.assertEqual(complete["state"], "needs_tsv_review")
            self.assertEqual(len(complete["segments"][0]["scribe_sha256"]), 64)

    def test_completed_job_never_posts_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            first_calls = []
            execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(first_calls),
            )
            repeat_calls = []
            repeated = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(repeat_calls),
            )
            self.assertEqual(repeat_calls, [])
            self.assertEqual(repeated["segments"][0]["state"], "Complete")

    def test_free_preparation_preserves_needs_tsv_review_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            reviewed = execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner([]),
            )
            combined_before = dict(reviewed["combined_transcript"])
            scribe_sha_before = reviewed["segments"][0]["scribe_sha256"]

            rerun = transcribe_class.prepare_job([source], root / "out", data_path=None)

            self.assertEqual(rerun["state"], "needs_tsv_review")
            self.assertEqual(rerun["combined_transcript"], combined_before)
            self.assertEqual(rerun["segments"][0]["scribe_sha256"], scribe_sha_before)
            self.assertEqual(rerun["segments"][0]["state"], "Complete")

    def test_free_preparation_preserves_completed_tsv_and_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            execute_with_saved_approval(
                state_path, [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner([]),
            )
            data_path = root / "data.json"
            data_path.write_text(
                json.dumps({"generated_at": 1, "lessons": []}), encoding="utf-8"
            )
            handoff = transcribe_class.prepare_tsv_handoff(state_path, data_path)
            draft = Path(handoff["draft_path"])
            draft.write_text("สวัสดี\tsawatdi\t你好\tword\t\n", encoding="utf-8")
            completed = transcribe_class.validate_and_promote_tsv(
                state_path, draft, data_path
            )
            tsv_before = dict(completed["tsv"])
            handoff_before = dict(completed["tsv_handoff"])
            combined_before = dict(completed["combined_transcript"])

            rerun = transcribe_class.prepare_job(
                [source], root / "out", data_path=data_path
            )

            self.assertEqual(rerun["state"], "complete")
            self.assertEqual(rerun["tsv"], tsv_before)
            self.assertEqual(rerun["tsv_handoff"], handoff_before)
            self.assertEqual(rerun["combined_transcript"], combined_before)
            self.assertFalse(rerun["tsv"]["sheet_written"])

            data_path.write_text(
                json.dumps({"generated_at": 2, "lessons": []}), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "data.json snapshot evidence"):
                transcribe_class.prepare_job(
                    [source], root / "out", data_path=data_path
                )

    def test_expired_rate_check_stops_before_secret_read_or_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            calls = []
            original_date = transcribe_class._common.RATE_CHECKED_ON
            transcribe_class._common.RATE_CHECKED_ON = "2026-01-01"
            try:
                blocked = execute_with_saved_approval(
                    state_path, [source], confirm_paid_api=True,
                    secrets_path=root / "missing.env",
                    http_runner=self.success_runner(calls),
                )
            finally:
                transcribe_class._common.RATE_CHECKED_ON = original_date
            self.assertEqual(calls, [])
            self.assertEqual(blocked["next_action"], "refresh_official_rate_then_rerun_free_preflight")

    def test_matching_complete_in_another_job_is_reused_without_key_or_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "class.mp4"
            make_mp4(source)
            first = transcribe_class.prepare_job(
                [source], root / "out", job_id="job-a", data_path=None
            )
            second = transcribe_class.prepare_job(
                [source], root / "out", job_id="job-b", data_path=None
            )
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            first_calls = []
            execute_with_saved_approval(
                Path(first["job_root"]) / "job.json", [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=self.success_runner(first_calls),
            )
            self.assertEqual(len(first_calls), 1)
            reused_calls = []

            reused = execute_with_saved_approval(
                Path(second["job_root"]) / "job.json", [source], confirm_paid_api=True,
                secrets_path=root / "missing.env", http_runner=self.success_runner(reused_calls),
            )

            self.assertEqual(reused_calls, [])
            self.assertEqual(reused["state"], "needs_tsv_review")
            self.assertEqual(reused["segments"][0]["attempts"][-1]["method"], "reused_local_complete")

    def test_matching_unknown_blocks_fresh_job_without_deadlocking_original_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "class.mp4"
            make_mp4(source)
            first = transcribe_class.prepare_job(
                [source], root / "out", job_id="job-a", data_path=None
            )
            second = transcribe_class.prepare_job(
                [source], root / "out", job_id="job-b", data_path=None
            )
            key_path = root / "stt.env"
            write_stt_secrets(key_path)

            def timeout_runner(args, **kwargs):
                raise subprocess.TimeoutExpired(args, 7200)

            execute_with_saved_approval(
                Path(first["job_root"]) / "job.json", [source], confirm_paid_api=True,
                secrets_path=key_path, http_runner=timeout_runner,
            )
            calls = []
            blocked = execute_with_saved_approval(
                Path(second["job_root"]) / "job.json", [source], confirm_paid_api=True,
                secrets_path=root / "missing.env", http_runner=self.success_runner(calls),
            )

            self.assertEqual(calls, [])
            self.assertEqual(blocked["segments"][0]["state"], "Prepared")
            self.assertEqual(blocked["segments"][0]["attempts"], [])
            self.assertEqual(blocked["state"], "blocked_by_local_evidence")
            self.assertEqual(blocked["next_action"], "inspect_matching_local_paid_evidence")

            retry_calls = []
            retried = execute_with_saved_approval(
                Path(first["job_root"]) / "job.json", [source],
                confirm_paid_api=True, force_paid_retry=True,
                secrets_path=key_path, http_runner=self.success_runner(retry_calls),
            )
            self.assertEqual(len(retry_calls), 1)
            self.assertEqual(retried["segments"][0]["state"], "Complete")

    def test_global_paid_lock_blocks_a_second_local_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, state_path = self.prepared_job(root)
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            calls = []

            with transcribe_class.paid_execution_lock(state_path):
                with self.assertRaisesRegex(ValueError, "另一個本機付費"):
                    execute_with_saved_approval(
                        state_path, [source], confirm_paid_api=True,
                        secrets_path=key_path, http_runner=self.success_runner(calls),
                    )
            self.assertEqual(calls, [])


@unittest.skipUnless(transcribe_class.tool_available("ffmpeg") and transcribe_class.tool_available("ffprobe"), "FFmpeg required")
class CombinedTranscriptTest(unittest.TestCase):
    def test_combined_transcript_preserves_verbatim_text_and_namespaces_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sources = [root / "260814-1.mp4", root / "260814-2.mp4"]
            for source in sources:
                make_mp4(source, duration=1.0)
            job = transcribe_class.prepare_job(sources, root / "out", data_path=None)
            state_path = Path(job["job_root"]) / "job.json"
            key_path = root / "stt.env"
            write_stt_secrets(key_path)
            responses = [
                {
                    "language_code": "th", "text": "สวัสดีครับ",
                    "words": [
                        {"text": "สวัสดี", "start": 0.0, "end": 0.4, "speaker_id": "speaker_0", "type": "word"},
                        {"text": "ครับ", "start": 0.4, "end": 0.8, "speaker_id": "speaker_0", "type": "word"},
                    ],
                },
                {
                    "language_code": "zh", "text": "你好 世界",
                    "words": [
                        {"text": "你好", "start": 0.0, "end": 0.3, "speaker_id": "speaker_0", "type": "word"},
                        {"text": " ", "start": 0.3, "end": 0.3, "speaker_id": "speaker_0", "type": "spacing"},
                        {"text": "世界", "start": 0.3, "end": 0.7, "speaker_id": "speaker_1", "type": "word"},
                    ],
                },
            ]
            calls = []

            def runner(args, **kwargs):
                response = responses[len(calls)]
                calls.append(args)
                header_path = Path(args[args.index("--dump-header") + 1])
                body_path = Path(args[args.index("--output") + 1])
                header_path.write_bytes(b"HTTP/1.1 200 OK\r\nrequest-id: req\r\n\r\n")
                body_path.write_text(json.dumps(response, ensure_ascii=False), encoding="utf-8")
                return subprocess.CompletedProcess(args, 0, stdout=b"200", stderr=b"")

            complete = execute_with_saved_approval(
                state_path, sources, confirm_paid_api=True,
                secrets_path=key_path, http_runner=runner,
            )

            self.assertEqual(len(calls), 2)
            self.assertEqual(complete["state"], "needs_tsv_review")
            combined = Path(complete["combined_transcript"]["path"]).read_text(encoding="utf-8")
            self.assertLess(combined.index("สวัสดีครับ"), combined.index("你好 世界"))
            self.assertIn("part1:speaker_0", combined)
            self.assertIn("part2:speaker_0", combined)
            self.assertIn("part2:speaker_1", combined)
            self.assertNotIn("ALIGNMENT WARNING", combined)

    def test_combined_transcript_warns_without_rewriting_mismatched_text(self):
        response = {
            "language_code": "th", "text": "ข้อความ ต้นฉบับ",
            "words": [{
                "text": "คนละข้อความ", "start": 0.0, "end": 0.5,
                "speaker_id": "speaker_0", "type": "word",
            }],
        }

        text, warning = transcribe_class.render_part_transcript(1, "part.mp4", response, 0.0)

        self.assertTrue(warning)
        self.assertIn("ข้อความ ต้นฉบับ", text)
        self.assertIn("ALIGNMENT WARNING", text)


class TsvWorkflowTest(unittest.TestCase):
    def make_review_job(self, root):
        job_root = root / "out" / "260814"
        transcribe_class.ensure_private_dir(job_root)
        combined = job_root / "260814-combined-transcript.txt"
        combined_bytes = b"untrusted transcript data\n"
        transcribe_class.atomic_write_bytes(combined, combined_bytes)
        state_path = job_root / "job.json"
        job = {
            "schema_version": 1,
            "job_id": "260814",
            "job_root": str(job_root.resolve()),
            "state": "needs_tsv_review",
            "next_action": "create_and_validate_five_column_tsv",
            "segments": [],
            "combined_transcript": {
                "path": str(combined.resolve()),
                "sha256": transcribe_class.sha256_bytes(combined_bytes),
            },
            "data_snapshot": None,
            "tsv": None,
        }
        transcribe_class.atomic_write_json(state_path, job)
        data_path = root / "data.json"
        data_path.write_text(json.dumps({
            "generated_at": 123,
            "lessons": [{"cards": [{"thai": "เดิม", "karaoke": "doem", "zh": "原有"}]}],
        }, ensure_ascii=False), encoding="utf-8")
        return state_path, data_path, job_root

    def test_handoff_records_data_identity_and_valid_tsv_completes_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path, data_path, job_root = self.make_review_job(root)

            handoff = transcribe_class.prepare_tsv_handoff(state_path, data_path)

            self.assertEqual(handoff["field_order"], ["thai", "karaoke", "zh", "type", "note"])
            self.assertIn("untrusted", handoff["security_boundary"].lower())
            self.assertEqual(len(handoff["data_snapshot"]["sha256"]), 64)
            draft = Path(handoff["draft_path"])
            draft.write_text(
                "สวัสดี\tsawatdi\t你好\tword\t課堂問候\n"
                "ขอบคุณ\tkhop khun\t謝謝\tphrase\t\n",
                encoding="utf-8",
            )
            os.chmod(draft, 0o600)

            complete = transcribe_class.validate_and_promote_tsv(state_path, draft, data_path)

            final = job_root / "260814-Google-Sheets.tsv"
            self.assertEqual(complete["state"], "complete")
            self.assertEqual(complete["tsv"]["row_count"], 2)
            self.assertEqual(final.read_text(encoding="utf-8"), draft.read_text(encoding="utf-8"))
            self.assertEqual(os.stat(final).st_mode & 0o777, 0o600)

    def test_validator_rejects_structural_and_sheet_injection_cases(self):
        invalid = {
            "missing column": "ก\tko\t中\tword\n",
            "extra column": "ก\tko\t中\tword\tnote\textra\n",
            "header": "thai\tkaraoke\tzh\ttype\tnote\n",
            "numbering": "1. ก\tko\t中\tword\t\n",
            "karaoke hyphen": "ก\tk-o\t中\tword\t\n",
            "duplicate": "ก\tko\t中\tword\t\nก\tko\t中\tword\t\n",
            "formula": "ก\tko\t=IMPORTXML(\"x\")\tword\t\n",
            "nul": "ก\tko\t中\tword\tbad\x00note\n",
        }
        for name, text in invalid.items():
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    transcribe_class.validate_tsv_text(text)

    def test_invalid_draft_preserves_prior_final_and_invalid_utf8_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path, data_path, job_root = self.make_review_job(root)
            handoff = transcribe_class.prepare_tsv_handoff(state_path, data_path)
            final = job_root / "260814-Google-Sheets.tsv"
            final.write_text("old valid output\n", encoding="utf-8")
            draft = Path(handoff["draft_path"])
            draft.write_bytes(b"\xff\xfe")

            with self.assertRaises(ValueError):
                transcribe_class.validate_and_promote_tsv(state_path, draft, data_path)

            self.assertEqual(final.read_text(encoding="utf-8"), "old valid output\n")
            self.assertEqual(transcribe_class.load_json_object(state_path)["state"], "needs_tsv_review")

    def test_data_change_after_handoff_blocks_tsv_promotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path, data_path, job_root = self.make_review_job(root)
            handoff = transcribe_class.prepare_tsv_handoff(state_path, data_path)
            draft = Path(handoff["draft_path"])
            draft.write_text("ก\tko\t中\tword\t\n", encoding="utf-8")
            data_path.write_text(json.dumps({"generated_at": 124, "lessons": []}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "data.json"):
                transcribe_class.validate_and_promote_tsv(state_path, draft, data_path)

            self.assertFalse((job_root / "260814-Google-Sheets.tsv").exists())
            self.assertEqual(transcribe_class.load_json_object(state_path)["state"], "needs_tsv_review")


if __name__ == "__main__":
    unittest.main()
