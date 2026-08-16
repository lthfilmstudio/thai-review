"""Guarded ElevenLabs Scribe preparation, execution, and recovery."""

from __future__ import annotations

from transcribe_class_common import *
from transcribe_class_postprocess import build_combined_transcript


def prepare_job(
    sources: Iterable[Path],
    output_root: Path = DEFAULT_OUTPUT_ROOT,
    *,
    job_id: str | None = None,
    data_path: Path | None = Path("data.json"),
    available_bytes: int | None = None,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    ordered, derived_job_id = order_sources(sources)
    selected_job_id = job_id or derived_job_id
    state_path = safe_job_root(Path(output_root), selected_job_id) / "job.json"
    with paid_execution_lock(state_path):
        return _prepare_job_locked(
            ordered,
            output_root,
            job_id=selected_job_id,
            data_path=data_path,
            available_bytes=available_bytes,
            runner=runner,
        )


def _prepare_job_locked(
    sources: Iterable[Path],
    output_root: Path = DEFAULT_OUTPUT_ROOT,
    *,
    job_id: str | None = None,
    data_path: Path | None = Path("data.json"),
    available_bytes: int | None = None,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    if not tool_available("ffmpeg") or not tool_available("ffprobe"):
        raise ValueError("需要先安裝 ffmpeg 與 ffprobe")
    ordered, derived_job_id = order_sources(sources)
    selected_job_id = job_id or derived_job_id
    job_root = safe_job_root(Path(output_root), selected_job_id)
    if len({path.stem for path in ordered}) != len(ordered):
        raise ValueError("來源檔名 stem 重複，無法建立唯一 MP3")

    inspected: list[dict] = []
    for source in ordered:
        _check_source(source)
        resolved = source.resolve(strict=True)
        media = inspect_single_audio(resolved, runner)
        inspected.append(
            {
                "path": resolved,
                "name": source.name,
                "size_bytes": resolved.stat().st_size,
                "sha256": sha256_file(resolved),
                **media,
            }
        )

    ensure_private_dir(job_root)
    audio_dir = job_root / "audio"
    scribe_dir = job_root / "scribe"
    ensure_private_dir(audio_dir)
    ensure_private_dir(scribe_dir)
    state_path = job_root / "job.json"
    existing = load_json_object(state_path) if state_path.exists() else None
    existing_segments = (existing or {}).get("segments") or []
    if existing and existing.get("job_id") != selected_job_id:
        raise ValueError("既有 job ID 與目前輸入不符")
    if existing and len(existing_segments) != len(inspected):
        raise ValueError("既有 job 的來源數量已變更")

    projected_bytes = MIN_FREE_HEADROOM + math.ceil(
        sum(item["duration_seconds"] for item in inspected) * (MP3_BITRATE / 8) * 2
    )
    free_bytes = available_bytes
    if free_bytes is None:
        free_bytes = shutil.disk_usage(job_root).free
    if free_bytes < projected_bytes:
        raise ValueError(f"磁碟空間不足，需要至少 {projected_bytes:,} bytes")

    segments: list[dict] = []
    for index, source in enumerate(inspected, start=1):
        prior = existing_segments[index - 1] if index <= len(existing_segments) else None
        if prior:
            prior_source = prior.get("source") or {}
            if (
                prior_source.get("name") != source["name"]
                or prior_source.get("sha256") != source["sha256"]
                or prior_source.get("path") != str(source["path"])
            ):
                raise ValueError(f"來源內容已變更：{source['name']}")

        mp3_path = audio_dir / f"{Path(source['name']).stem}.mp3"
        mp3_details: dict
        if mp3_path.exists():
            prior_mp3 = (prior or {}).get("mp3") or {}
            mp3_details = _validate_mp3(mp3_path, source["duration_seconds"], runner)
            if prior_mp3.get("sha256") != mp3_details["sha256"]:
                raise ValueError(f"既有 MP3 內容與 job evidence 不符：{mp3_path.name}")
            mp3_details["path"] = str(mp3_path.resolve())
        else:
            mp3_details = _convert_mp3_atomic(
                source["path"],
                source["stream_index"],
                source["duration_seconds"],
                source["sha256"],
                mp3_path,
                runner,
            )
        segment = copy.deepcopy(prior) if prior else {}
        segment.update({
            "index": index,
            "source": {
                "path": str(source["path"]),
                "name": source["name"],
                "size_bytes": source["size_bytes"],
                "sha256": source["sha256"],
                "duration_seconds": source["duration_seconds"],
                "audio_stream_index": source["stream_index"],
                "audio_stream_count": source["audio_stream_count"],
                "audio_stream_selection": source["selection"],
            },
            "mp3": mp3_details,
            "scribe_path": str((scribe_dir / f"{Path(source['name']).stem}.json").resolve()),
            "attempts": list((prior or {}).get("attempts") or []),
        })
        segment.setdefault("state", "Prepared")
        segment.setdefault("next_action", "await_paid_approval")
        segments.append(segment)

    downstream_state = bool(
        existing and existing.get("state") in {"needs_tsv_review", "complete"}
    )
    if downstream_state and not all(
        segment.get("state") == "Complete" for segment in segments
    ):
        raise ValueError("既有下游完成狀態與分段 evidence 不一致")
    preserve_downstream = downstream_state
    if preserve_downstream:
        for segment in segments:
            _, artifact_sha256 = _load_matching_scribe_artifact(segment)
            segment["scribe_sha256"] = artifact_sha256
        combined = existing.get("combined_transcript") or {}
        combined_path = Path(combined.get("path") or "")
        if not combined_path.is_file() or sha256_file(combined_path) != combined.get("sha256"):
            raise ValueError("既有 combined transcript evidence 不完整")
        snapshot = existing.get("data_snapshot")
        if isinstance(snapshot, dict) and data_path is not None:
            if capture_data_snapshot(Path(data_path)) != snapshot:
                raise ValueError("既有 data.json snapshot evidence 不符")
        handoff = existing.get("tsv_handoff")
        if isinstance(handoff, dict) and (
            not isinstance(snapshot, dict)
            or handoff.get("data_sha256") != snapshot.get("sha256")
        ):
            raise ValueError("既有 TSV handoff evidence 不符")
        if existing.get("state") == "complete":
            tsv = existing.get("tsv") or {}
            tsv_path = Path(tsv.get("path") or "")
            if not tsv_path.is_file() or sha256_file(tsv_path) != tsv.get("sha256"):
                raise ValueError("既有 TSV evidence 不完整")
            if (
                not isinstance(snapshot, dict)
                or tsv.get("data_sha256") != snapshot.get("sha256")
            ):
                raise ValueError("既有 TSV 與 data snapshot evidence 不符")

    approval = _approval_summary(segments)
    if not within_paid_caps(approval["estimate"]):
        raise ValueError("待上傳音訊超出 120 分鐘或 USD 0.50 付費硬上限")
    timestamp = now_utc()
    job = {
        "schema_version": STATE_VERSION,
        "job_id": selected_job_id,
        "job_root": str(job_root.resolve()),
        "created_at": (existing or {}).get("created_at", timestamp),
        "updated_at": timestamp,
        "state": existing.get("state") if preserve_downstream else "awaiting_paid_approval",
        "next_action": (
            existing.get("next_action") if preserve_downstream else "review_paid_disclosure"
        ),
        "segments": segments,
        "approval": approval,
        "approval_fingerprint": paid_input_fingerprint(approval),
        "data_snapshot": (existing or {}).get("data_snapshot"),
        "data_snapshot_preparation": (existing or {}).get("data_snapshot_preparation"),
        "combined_transcript": (existing or {}).get("combined_transcript"),
        "tsv_handoff": (existing or {}).get("tsv_handoff"),
        "tsv": (existing or {}).get("tsv"),
    }
    if data_path is not None and Path(data_path).exists() and job["data_snapshot"] is None:
        job["data_snapshot_preparation"] = capture_data_snapshot(Path(data_path))
    atomic_write_json(state_path, job)
    return job


def _sanitize_identifier(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9._:-]", "", text)[:128]
    return cleaned or None


def _response_identifiers(header_bytes: bytes) -> dict:
    result: dict[str, str] = {}
    for raw_line in header_bytes.decode("utf-8", errors="replace").splitlines():
        if ":" not in raw_line:
            continue
        name, value = raw_line.split(":", 1)
        normalized = name.strip().lower()
        if normalized in {"request-id", "x-request-id", "x-trace-id", "transcription-id"}:
            safe = _sanitize_identifier(value)
            if safe:
                result[normalized.replace("-", "_")] = safe
    return result


def _validate_scribe_response(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Scribe response 最上層不是 object")
    if not isinstance(value.get("text"), str):
        raise ValueError("Scribe response 缺少 text")
    if not isinstance(value.get("language_code"), str) or not value["language_code"].strip():
        raise ValueError("Scribe response 缺少 language_code")
    words = value.get("words")
    if not isinstance(words, list):
        raise ValueError("Scribe response 缺少 words")
    if value["text"].strip() and not words:
        raise ValueError("Scribe response 有正文但沒有 word timestamps")
    for index, word in enumerate(words):
        if not isinstance(word, dict):
            raise ValueError(f"Scribe word {index} 不是 object")
        if not isinstance(word.get("text"), str):
            raise ValueError(f"Scribe word {index} text 無效")
        if not isinstance(word.get("type"), str):
            raise ValueError(f"Scribe word {index} type 無效")
        if not isinstance(word.get("speaker_id"), str) or not word["speaker_id"].strip():
            raise ValueError(f"Scribe word {index} speaker_id 無效")
        if not isinstance(word.get("start"), (int, float)) or not math.isfinite(word["start"]):
            raise ValueError(f"Scribe word {index} start 無效")
        if not isinstance(word.get("end"), (int, float)) or not math.isfinite(word["end"]):
            raise ValueError(f"Scribe word {index} end 無效")
        if word["start"] < 0 or word["end"] < word["start"]:
            raise ValueError(f"Scribe word {index} 時間範圍無效")
    return value


def load_stt_secrets(path: Path) -> dict[str, str]:
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"找不到獨立 STT secrets file：{path}")
    stat = path.stat()
    if stat.st_mode & 0o777 != 0o600:
        raise ValueError("STT secrets file 權限必須是 0600")
    if hasattr(os, "geteuid") and stat.st_uid != os.geteuid():
        raise ValueError("STT secrets file 擁有者不是目前使用者")
    repo_root = Path(__file__).resolve().parents[1]
    resolved = path.resolve(strict=True)
    if resolved == repo_root or repo_root in resolved.parents:
        raise ValueError("STT secrets file 必須位於 repo 外")

    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        values[name.strip()] = value.strip().strip("'\"")
    key = values.get("ELEVENLABS_STT_API_KEY", "")
    if not re.fullmatch(r"[A-Za-z0-9._-]{8,}", key):
        raise ValueError("secrets file 缺少有效 ELEVENLABS_STT_API_KEY；不接受 TTS key fallback")
    if values.get("ELEVENLABS_STT_KEY_SCOPE") != "speech_to_text":
        raise ValueError("STT key checklist 必須明列 scope=speech_to_text")
    quota_text = values.get("ELEVENLABS_STT_CREDIT_QUOTA")
    provider_guard = values.get("ELEVENLABS_STT_PROVIDER_GUARD")
    if quota_text and provider_guard:
        raise ValueError("STT key checklist 只能設定一種 provider 付費防呆")
    if quota_text:
        try:
            quota = Decimal(quota_text)
        except ValueError as exc:
            raise ValueError("STT credit quota 格式無效") from exc
        if quota <= 0:
            raise ValueError("STT credit quota 必須大於 0")
        return {
            "api_key": key,
            "scope": "speech_to_text",
            "provider_guard": "credit_quota",
            "credit_quota": str(quota),
        }
    if provider_guard != "ip_allowlist":
        raise ValueError("STT key checklist 必須明列 credit quota 或 provider guard=ip_allowlist")
    return {
        "api_key": key,
        "scope": "speech_to_text",
        "provider_guard": "ip_allowlist",
    }


def _scribe_post_form_args() -> list[str]:
    args: list[str] = []
    for field in SCRIBE_POST_FIELDS:
        value = SCRIBE_REQUEST_CONTRACT[field]
        rendered = str(value).lower() if isinstance(value, bool) else str(value)
        args.extend(["--form", f"{field}={rendered}"])
    return args


def run_scribe_curl(
    mp3_path: Path,
    api_key: str,
    temp_parent: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    if any(ord(character) < 33 or ord(character) == 127 for character in api_key):
        raise ValueError("STT API key 格式無效")
    header_path = _exclusive_transport_temp(temp_parent, "scribe-headers")
    body_path = _exclusive_transport_temp(temp_parent, "scribe-body")
    args = [
        "curl",
        "-q",
        "--config",
        "-",
        "--silent",
        "--show-error",
        "--request",
        "POST",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--retry",
        "0",
        "--max-redirs",
        "0",
        "--connect-timeout",
        "30",
        "--max-time",
        str(SCRIBE_TIMEOUT_SECONDS),
        "--max-filesize",
        str(MAX_RESPONSE_BYTES),
        "--dump-header",
        str(header_path),
        "--output",
        str(body_path),
        "--write-out",
        "%{http_code}",
        "--form",
        f"file=@{mp3_path};type=audio/mpeg",
        *_scribe_post_form_args(),
        SCRIBE_ENDPOINT,
    ]
    child_env = {
        name: value
        for name, value in os.environ.items()
        if not name.upper().startswith("ELEVENLABS")
    }
    config = f'header = "xi-api-key: {api_key}"\n'.encode("utf-8")
    try:
        completed = runner(
            args,
            input_bytes=config,
            timeout=SCRIBE_TIMEOUT_SECONDS + 30,
            env=child_env,
        )
        if header_path.stat().st_size > MAX_HEADER_BYTES:
            raise ValueError("Scribe response headers 超過大小上限")
        if body_path.stat().st_size > MAX_RESPONSE_BYTES:
            raise ValueError("Scribe response body 超過大小上限")
        headers = header_path.read_bytes()
        body = body_path.read_bytes()
        stdout = completed.stdout.decode("ascii", errors="ignore").strip()
        http_status = int(stdout[-3:]) if len(stdout) >= 3 and stdout[-3:].isdigit() else None
        return {
            "returncode": completed.returncode,
            "http_status": http_status,
            "identifiers": _response_identifiers(headers),
            "body": body,
            "error": _limited_error(completed),
        }
    finally:
        for path in (header_path, body_path):
            path.unlink(missing_ok=True)


def _load_matching_scribe_artifact(segment: dict) -> tuple[dict, str]:
    scribe_path = Path(segment.get("scribe_path") or "")
    raw_response, artifact_sha256 = load_json_object_with_sha256(scribe_path)
    response = _validate_scribe_response(raw_response)
    workflow = response.get("__thai_review_workflow")
    if not isinstance(workflow, dict):
        raise ValueError("Scribe artifact 缺少 workflow evidence")
    if workflow.get("version") != 1:
        raise ValueError("Scribe artifact workflow version 不支援")
    if workflow.get("mp3_sha256") != (segment.get("mp3") or {}).get("sha256"):
        raise ValueError("Scribe artifact 的 MP3 fingerprint 不符")
    attempt_fingerprints = {
        attempt.get("request_fingerprint")
        for attempt in segment.get("attempts") or []
        if attempt.get("status") in {"Uploading", "Complete"}
        and re.fullmatch(r"[0-9a-f]{64}", str(attempt.get("request_fingerprint") or ""))
    }
    if (
        not re.fullmatch(r"[0-9a-f]{64}", str(workflow.get("request_fingerprint") or ""))
        or workflow.get("request_fingerprint") not in attempt_fingerprints
    ):
        raise ValueError("Scribe artifact 的 request fingerprint 不符")
    saved_sha256 = segment.get("scribe_sha256")
    if saved_sha256 and saved_sha256 != artifact_sha256:
        raise ValueError("Scribe artifact hash 與 job evidence 不符")
    return response, artifact_sha256


def _revalidated_segments(
    job: dict,
    sources: Iterable[Path],
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> tuple[list[dict], bool]:
    ordered, _ = order_sources(sources)
    segments = job.get("segments")
    if not isinstance(segments, list) or len(segments) != len(ordered):
        raise ValueError("job 來源數量與本次輸入不符")
    refreshed: list[dict] = []
    recovery_changed = False
    for segment, source in zip(segments, ordered):
        source_path = source.resolve(strict=True)
        saved_source = segment.get("source") or {}
        if (
            saved_source.get("path") != str(source_path)
            or saved_source.get("name") != source.name
            or saved_source.get("sha256") != sha256_file(source_path)
        ):
            raise ValueError(f"來源內容已變更：{source.name}")
        next_segment = copy.deepcopy(segment)
        mp3_path = Path((segment.get("mp3") or {}).get("path", ""))
        details = _validate_mp3(mp3_path, float(saved_source["duration_seconds"]), runner)
        if details["sha256"] != (segment.get("mp3") or {}).get("sha256"):
            raise ValueError(f"MP3 內容已變更：{mp3_path.name}")
        details["path"] = str(mp3_path.resolve())
        next_segment["mp3"] = details
        if next_segment.get("state") in {"Uploading", "Complete"}:
            try:
                _, artifact_sha256 = _load_matching_scribe_artifact(next_segment)
                next_segment["state"] = "Complete"
                next_segment["next_action"] = "none"
                next_segment["scribe_sha256"] = artifact_sha256
                if next_segment.get("attempts"):
                    next_segment["attempts"][-1]["status"] = "Complete"
            except (OSError, ValueError):
                next_segment["state"] = "Unknown"
                next_segment["next_action"] = "manual_provider_lookup_then_new_dual_approval"
            recovery_changed = recovery_changed or next_segment != segment
        refreshed.append(next_segment)
    return refreshed, recovery_changed


def _save_job(state_path: Path, job: dict) -> None:
    job["updated_at"] = now_utc()
    atomic_write_json(state_path, job)


def _mark_unknown(
    state_path: Path,
    job: dict,
    segment: dict,
    attempt: dict,
    reason: str,
    outcome: dict | None = None,
) -> dict:
    segment["state"] = "Unknown"
    segment["next_action"] = "manual_provider_lookup_then_new_dual_approval"
    attempt["status"] = "Unknown"
    attempt["finished_at"] = now_utc()
    attempt["reason"] = reason[:240]
    if outcome:
        attempt["http_status"] = outcome.get("http_status")
        identifiers = dict(outcome.get("identifiers") or {})
        try:
            provider_error = json.loads((outcome.get("body") or b"").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            provider_error = None
        if isinstance(provider_error, dict):
            transcription_id = _sanitize_identifier(provider_error.get("transcription_id"))
            if transcription_id:
                identifiers["transcription_id"] = transcription_id
        attempt["identifiers"] = identifiers
    job["state"] = "unknown"
    job["next_action"] = "manual_provider_lookup_then_new_dual_approval"
    _save_job(state_path, job)
    return job


@contextlib.contextmanager
def paid_execution_lock(state_path: Path):
    output_root = Path(state_path).resolve(strict=False).parent.parent
    ensure_private_dir(output_root)
    lock_path = output_root / ".paid-api.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.chmod(lock_path, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("另一個本機付費轉錄流程正在執行；本次 0 requests") from exc
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _content_request_fingerprint(segment: dict, request_contract: dict) -> str:
    return paid_input_fingerprint({
        "mp3_sha256": (segment.get("mp3") or {}).get("sha256"),
        "request": request_contract,
        "endpoint": SCRIBE_ENDPOINT,
    })


def _find_local_paid_evidence(
    state_path: Path,
    segment: dict,
    request_contract: dict,
) -> tuple[str | None, dict | None, str | None]:
    output_root = Path(state_path).resolve(strict=False).parent.parent
    target_fingerprint = _content_request_fingerprint(segment, request_contract)
    for other_state_path in output_root.glob("*/job.json"):
        if other_state_path.is_symlink() or other_state_path.resolve(strict=False) == Path(state_path).resolve(strict=False):
            continue
        try:
            other_job = load_json_object(other_state_path)
        except (OSError, ValueError):
            continue
        other_request = (other_job.get("approval") or {}).get("request")
        for other_segment in other_job.get("segments") or []:
            if (other_segment.get("mp3") or {}).get("sha256") != (segment.get("mp3") or {}).get("sha256"):
                continue
            launched_attempts = [
                attempt
                for attempt in other_segment.get("attempts") or []
                if attempt.get("status") in {"Uploading", "Unknown", "Complete"}
                and attempt.get("content_request_fingerprint")
            ]
            fingerprints = {
                attempt.get("content_request_fingerprint") for attempt in launched_attempts
            }
            contract_matches = target_fingerprint in fingerprints or other_request == request_contract
            if not contract_matches:
                continue
            if other_segment.get("state") == "Complete":
                try:
                    response, _ = _load_matching_scribe_artifact(other_segment)
                except (OSError, ValueError):
                    return "Unknown", None, str(other_state_path)
                return "Complete", response, str(other_state_path)
            has_indeterminate_launch = any(
                attempt.get("status") in {"Uploading", "Unknown"}
                and attempt.get("content_request_fingerprint") == target_fingerprint
                for attempt in launched_attempts
            )
            if (
                other_segment.get("state") in {"Uploading", "Unknown"}
                and has_indeterminate_launch
            ):
                return "Unknown", None, str(other_state_path)
    return None, None, None


def execute_paid(
    state_path: Path,
    sources: Iterable[Path],
    *,
    confirm_paid_api: bool,
    approval_fingerprint: str | None = None,
    force_paid_retry: bool = False,
    secrets_path: Path = DEFAULT_STT_SECRETS_PATH,
    media_runner: Callable[..., subprocess.CompletedProcess] = run_process,
    http_runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    lock = paid_execution_lock(Path(state_path)) if confirm_paid_api else contextlib.nullcontext()
    with lock:
        return _execute_paid_inner(
            state_path,
            sources,
            confirm_paid_api=confirm_paid_api,
            approval_fingerprint=approval_fingerprint,
            force_paid_retry=force_paid_retry,
            secrets_path=secrets_path,
            media_runner=media_runner,
            http_runner=http_runner,
        )


def _execute_paid_inner(
    state_path: Path,
    sources: Iterable[Path],
    *,
    confirm_paid_api: bool,
    approval_fingerprint: str | None = None,
    force_paid_retry: bool = False,
    secrets_path: Path = DEFAULT_STT_SECRETS_PATH,
    media_runner: Callable[..., subprocess.CompletedProcess] = run_process,
    http_runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    state_path = Path(state_path)
    if confirm_paid_api and not re.fullmatch(r"[0-9a-f]{64}", approval_fingerprint or ""):
        raise ValueError("--confirm-paid-api 必須附上目前揭露的 64 位 approval fingerprint")
    job = load_json_object(state_path)
    job["segments"], recovery_changed = _revalidated_segments(job, sources, media_runner)
    if all(segment.get("state") == "Complete" for segment in job["segments"]):
        return build_combined_transcript(state_path, job)
    if not rate_check_is_fresh():
        job["state"] = "awaiting_paid_approval"
        job["next_action"] = "refresh_official_rate_then_rerun_free_preflight"
        _save_job(state_path, job)
        return job

    current_approval = _approval_summary(job["segments"])
    current_fingerprint = paid_input_fingerprint(current_approval)
    if (
        job.get("approval_fingerprint") != current_fingerprint
        or job.get("approval") != current_approval
    ):
        job["approval"] = current_approval
        job["approval_fingerprint"] = current_fingerprint
        job["state"] = "awaiting_paid_approval"
        job["next_action"] = "review_updated_paid_disclosure"
        _save_job(state_path, job)
        return job
    if not within_paid_caps(current_approval["estimate"]):
        raise ValueError("本次批准摘要超出付費硬上限")
    if confirm_paid_api and approval_fingerprint != current_fingerprint:
        raise ValueError("approval fingerprint 與目前付費揭露不符；本次 0 requests")
    if not confirm_paid_api:
        if recovery_changed:
            job["state"] = "unknown"
            job["next_action"] = "manual_provider_lookup_then_new_dual_approval"
            _save_job(state_path, job)
        return job

    unknown = [segment for segment in job["segments"] if segment.get("state") == "Unknown"]
    if unknown and not force_paid_retry:
        job["state"] = "unknown"
        job["next_action"] = "manual_provider_lookup_then_new_dual_approval"
        _save_job(state_path, job)
        return job
    if force_paid_retry and not unknown:
        raise ValueError("--force-paid-retry 只適用於 Unknown 分段")

    secret: dict[str, str] | None = None
    for segment in job["segments"]:
        if segment.get("state") == "Complete":
            continue
        segment.pop("blocked_by_local_evidence", None)
        evidence_state, evidence_response, evidence_path = _find_local_paid_evidence(
            state_path,
            segment,
            current_approval["request"],
        )
        if evidence_state == "Unknown":
            segment["next_action"] = "wait_for_matching_local_paid_evidence"
            segment["blocked_by_local_evidence"] = {
                "checked_at": now_utc(),
                "matching_job_state": evidence_path,
                "content_request_fingerprint": _content_request_fingerprint(
                    segment, current_approval["request"]
                ),
            }
            job["state"] = "blocked_by_local_evidence"
            job["next_action"] = "inspect_matching_local_paid_evidence"
            _save_job(state_path, job)
            return job
        request_fingerprint = paid_input_fingerprint({
            "approval_fingerprint": current_fingerprint,
            "segment_index": segment["index"],
            "mp3_sha256": segment["mp3"]["sha256"],
        })
        content_request_fingerprint = _content_request_fingerprint(
            segment, current_approval["request"]
        )
        if evidence_state == "Complete" and evidence_response is not None:
            response = copy.deepcopy(evidence_response)
            response["__thai_review_workflow"] = {
                "version": 1,
                "request_fingerprint": request_fingerprint,
                "mp3_sha256": segment["mp3"]["sha256"],
                "saved_at": now_utc(),
                "reused_from": evidence_path,
            }
            segment["scribe_sha256"] = atomic_write_json(Path(segment["scribe_path"]), response)
            segment["state"] = "Complete"
            segment["next_action"] = "none"
            segment.setdefault("attempts", []).append({
                "attempt": len(segment.get("attempts") or []) + 1,
                "started_at": now_utc(),
                "finished_at": now_utc(),
                "status": "Complete",
                "method": "reused_local_complete",
                "request_fingerprint": request_fingerprint,
                "content_request_fingerprint": content_request_fingerprint,
                "matching_job_state": evidence_path,
            })
            _save_job(state_path, job)
            continue
        if secret is None:
            secret = load_stt_secrets(secrets_path)
        attempt = {
            "attempt": len(segment.get("attempts") or []) + 1,
            "started_at": now_utc(),
            "status": "Uploading",
            "request_fingerprint": request_fingerprint,
            "content_request_fingerprint": content_request_fingerprint,
            "mp3_sha256": segment["mp3"]["sha256"],
        }
        segment.setdefault("attempts", []).append(attempt)
        segment["state"] = "Uploading"
        segment["next_action"] = "do_not_retry_while_request_in_flight"
        job["state"] = "transcribing"
        job["next_action"] = "wait_for_current_segment"
        _save_job(state_path, job)

        try:
            outcome = run_scribe_curl(
                Path(segment["mp3"]["path"]),
                secret["api_key"],
                Path(job["job_root"]),
                runner=http_runner,
            )
        except FileNotFoundError as exc:
            segment["state"] = "Prepared"
            segment["next_action"] = "fix_local_curl_before_paid_retry"
            attempt["status"] = "PrelaunchFailure"
            attempt["finished_at"] = now_utc()
            attempt["reason"] = str(exc)[:240]
            job["state"] = "awaiting_paid_approval"
            job["next_action"] = "fix_local_curl_before_paid_retry"
            _save_job(state_path, job)
            return job
        except BaseException as exc:
            return _mark_unknown(state_path, job, segment, attempt, type(exc).__name__)

        if outcome["returncode"] != 0 or outcome["http_status"] != 200:
            reason = f"curl={outcome['returncode']} http={outcome['http_status']}"
            return _mark_unknown(state_path, job, segment, attempt, reason, outcome)
        try:
            response = json.loads(outcome["body"].decode("utf-8"))
            response = _validate_scribe_response(response)
            if "__thai_review_workflow" in response:
                raise ValueError("Scribe response 使用了保留欄位")
            response["__thai_review_workflow"] = {
                "version": 1,
                "request_fingerprint": request_fingerprint,
                "mp3_sha256": segment["mp3"]["sha256"],
                "saved_at": now_utc(),
            }
            scribe_path = Path(segment["scribe_path"])
            scribe_sha256 = atomic_write_json(scribe_path, response)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as exc:
            try:
                _, scribe_sha256 = _load_matching_scribe_artifact(segment)
            except (OSError, ValueError):
                return _mark_unknown(
                    state_path, job, segment, attempt, type(exc).__name__, outcome
                )

        segment["state"] = "Complete"
        segment["next_action"] = "none"
        segment["scribe_sha256"] = scribe_sha256
        attempt["status"] = "Complete"
        attempt["finished_at"] = now_utc()
        attempt["http_status"] = 200
        attempt["identifiers"] = outcome["identifiers"]
        _save_job(state_path, job)

    return build_combined_transcript(state_path, job)


def run_scribe_get(
    transcription_id: str,
    api_key: str,
    temp_parent: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", transcription_id):
        raise ValueError("transcription ID 格式無效")
    header_path = _exclusive_transport_temp(temp_parent, "scribe-get-headers")
    body_path = _exclusive_transport_temp(temp_parent, "scribe-get-body")
    endpoint = f"{SCRIBE_ENDPOINT}/transcripts/{transcription_id}"
    args = [
        "curl", "-q", "--config", "-", "--silent", "--show-error",
        "--request", "GET", "--proto", "=https", "--proto-redir", "=https",
        "--retry", "0", "--max-redirs", "0", "--connect-timeout", "30",
        "--max-time", str(SCRIBE_TIMEOUT_SECONDS), "--max-filesize", str(MAX_RESPONSE_BYTES),
        "--dump-header", str(header_path), "--output", str(body_path),
        "--write-out", "%{http_code}", endpoint,
    ]
    child_env = {
        name: value for name, value in os.environ.items()
        if not name.upper().startswith("ELEVENLABS")
    }
    config = f'header = "xi-api-key: {api_key}"\n'.encode("utf-8")
    try:
        completed = runner(
            args,
            input_bytes=config,
            timeout=SCRIBE_TIMEOUT_SECONDS + 30,
            env=child_env,
        )
        if header_path.stat().st_size > MAX_HEADER_BYTES or body_path.stat().st_size > MAX_RESPONSE_BYTES:
            raise ValueError("Scribe GET response 超過大小上限")
        headers = header_path.read_bytes()
        body = body_path.read_bytes()
        stdout = completed.stdout.decode("ascii", errors="ignore").strip()
        http_status = int(stdout[-3:]) if len(stdout) >= 3 and stdout[-3:].isdigit() else None
        return {
            "returncode": completed.returncode,
            "http_status": http_status,
            "identifiers": _response_identifiers(headers),
            "body": body,
            "error": _limited_error(completed),
        }
    finally:
        for path in (header_path, body_path):
            path.unlink(missing_ok=True)


def recover_unknown(
    state_path: Path,
    sources: Iterable[Path],
    *,
    secrets_path: Path = DEFAULT_STT_SECRETS_PATH,
    media_runner: Callable[..., subprocess.CompletedProcess] = run_process,
    http_runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    with paid_execution_lock(Path(state_path)):
        return _recover_unknown_inner(
            state_path,
            sources,
            secrets_path=secrets_path,
            media_runner=media_runner,
            http_runner=http_runner,
        )


def _recover_unknown_inner(
    state_path: Path,
    sources: Iterable[Path],
    *,
    secrets_path: Path = DEFAULT_STT_SECRETS_PATH,
    media_runner: Callable[..., subprocess.CompletedProcess] = run_process,
    http_runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    state_path = Path(state_path)
    job = load_json_object(state_path)
    job["segments"], recovery_changed = _revalidated_segments(job, sources, media_runner)
    if all(segment.get("state") == "Complete" for segment in job["segments"]):
        return build_combined_transcript(state_path, job)

    recoverable: list[tuple[dict, dict, str]] = []
    for segment in job["segments"]:
        if segment.get("state") != "Unknown":
            continue
        for attempt in reversed(segment.get("attempts") or []):
            transcription_id = (attempt.get("identifiers") or {}).get("transcription_id")
            if transcription_id:
                recoverable.append((segment, attempt, transcription_id))
                break
    if not recoverable:
        job["state"] = "unknown"
        job["next_action"] = "manual_provider_lookup_then_new_dual_approval"
        if recovery_changed:
            _save_job(state_path, job)
        return job

    secret = load_stt_secrets(secrets_path)
    for segment, attempt, transcription_id in recoverable:
        try:
            outcome = run_scribe_get(
                transcription_id,
                secret["api_key"],
                Path(job["job_root"]),
                runner=http_runner,
            )
            if outcome["returncode"] != 0 or outcome["http_status"] != 200:
                raise ValueError(f"GET http={outcome['http_status']}")
            response = _validate_scribe_response(json.loads(outcome["body"].decode("utf-8")))
            request_fingerprint = attempt.get("request_fingerprint")
            response["__thai_review_workflow"] = {
                "version": 1,
                "request_fingerprint": request_fingerprint,
                "mp3_sha256": segment["mp3"]["sha256"],
                "saved_at": now_utc(),
                "recovered_by": "GET transcript",
            }
            segment["scribe_sha256"] = atomic_write_json(Path(segment["scribe_path"]), response)
        except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
            attempt.setdefault("recovery_checks", []).append({
                "checked_at": now_utc(),
                "status": "Unknown",
                "reason": type(exc).__name__,
            })
            job["state"] = "unknown"
            job["next_action"] = "manual_provider_lookup_then_new_dual_approval"
            _save_job(state_path, job)
            return job
        segment["state"] = "Complete"
        segment["next_action"] = "none"
        attempt["status"] = "Complete"
        attempt.setdefault("recovery_checks", []).append({
            "checked_at": now_utc(),
            "status": "Complete",
            "method": "GET transcript",
        })
        _save_job(state_path, job)

    if all(segment.get("state") == "Complete" for segment in job["segments"]):
        return build_combined_transcript(state_path, job)
    job["state"] = "awaiting_paid_approval"
    job["next_action"] = "review_updated_paid_disclosure"
    _save_job(state_path, job)
    return job



__all__ = [name for name in globals() if not name.startswith("__")]
