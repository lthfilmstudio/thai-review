#!/usr/bin/env python3
"""Shared media inspection, durable I/O, and paid-disclosure primitives."""

from __future__ import annotations

import argparse
import copy
import contextlib
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import subprocess
from decimal import Decimal, ROUND_HALF_UP
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable


STATE_VERSION = 1
MAX_TOTAL_SECONDS = Decimal("7200")
MAX_BUFFERED_USD = Decimal("0.50")
SCRIBE_USD_PER_HOUR = Decimal("0.22")
ESTIMATE_BUFFER = Decimal("1.10")
RATE_CHECKED_ON = "2026-08-16"
RATE_MAX_AGE_DAYS = 30
DEFAULT_OUTPUT_ROOT = Path("out/class-transcriptions")
DEFAULT_STT_SECRETS_PATH = Path.home() / ".secrets" / "elevenlabs-stt.env"
SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
MP3_SAMPLE_RATE = 16000
MP3_CHANNELS = 1
MP3_BITRATE = 64000
MIN_FREE_HEADROOM = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024
SCRIBE_TIMEOUT_SECONDS = 7200
SCRIBE_REQUEST_CONTRACT = {
    "model_id": "scribe_v2",
    "language_code": None,
    "diarize": True,
    "timestamps_granularity": "word",
    "tag_audio_events": False,
    "use_multi_channel": False,
    "no_verbatim": False,
    "detect_speaker_roles": False,
    "use_speaker_library": False,
    "keyterms": [],
    "entity_detection": None,
}
SCRIBE_POST_FIELDS = (
    "model_id",
    "diarize",
    "timestamps_granularity",
    "tag_audio_events",
    "use_multi_channel",
    "no_verbatim",
    "detect_speaker_roles",
    "use_speaker_library",
)


def tool_available(name: str) -> bool:
    return shutil.which(name) is not None


def rate_check_is_fresh(today: date | None = None) -> bool:
    try:
        checked = date.fromisoformat(RATE_CHECKED_ON)
    except ValueError:
        return False
    taipei = timezone(timedelta(hours=8))
    current = today or datetime.now(taipei).date()
    age = (current - checked).days
    return 0 <= age <= RATE_MAX_AGE_DAYS


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def paid_input_fingerprint(summary: dict) -> str:
    return sha256_bytes(canonical_json_bytes(summary))


def order_sources(paths: Iterable[Path]) -> tuple[list[Path], str]:
    sources = [Path(path) for path in paths]
    if not sources:
        raise ValueError("至少要明確指定一支 MP4")
    if any(path.suffix.lower() != ".mp4" for path in sources):
        raise ValueError("正式流程只接受 MP4")
    if len(sources) == 1:
        return sources, sources[0].stem

    parsed: list[tuple[int, Path]] = []
    common_prefix: str | None = None
    for path in sources:
        match = re.fullmatch(r"(.+)-(\d+)", path.stem)
        if not match:
            raise ValueError("多支 MP4 必須使用共同前綴與數字尾碼")
        prefix, suffix = match.groups()
        if common_prefix is None:
            common_prefix = prefix
        elif prefix != common_prefix:
            raise ValueError("多支 MP4 必須使用相同共同前綴")
        parsed.append((int(suffix), path))

    suffixes = [suffix for suffix, _ in parsed]
    if len(suffixes) != len(set(suffixes)):
        raise ValueError("MP4 數字尾碼重複")
    expected = list(range(1, len(suffixes) + 1))
    if sorted(suffixes) != expected:
        raise ValueError("MP4 數字尾碼必須從 1 連續排列")
    return [path for _, path in sorted(parsed)], str(common_prefix)


def safe_job_root(output_root: Path, job_id: str) -> Path:
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", job_id):
        raise ValueError("job ID 必須是 1 至 80 字的安全單一路徑片段")

    root = Path(output_root)
    if root.exists() and root.is_symlink():
        raise ValueError("輸出根目錄不可為 symlink")
    resolved_root = root.resolve(strict=False)
    candidate = root / job_id
    if candidate.is_symlink():
        raise ValueError("job 目錄不可為 symlink")
    resolved_candidate = candidate.resolve(strict=False)
    if resolved_candidate.parent != resolved_root:
        raise ValueError("job 目錄超出輸出根目錄")
    return candidate


def ensure_private_dir(path: Path) -> None:
    path = Path(path)
    if path.exists() and path.is_symlink():
        raise ValueError(f"目錄不可為 symlink：{path}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    if hasattr(os, "geteuid") and path.stat().st_uid != os.geteuid():
        raise ValueError(f"目錄擁有者不是目前使用者：{path}")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_bytes(
    path: Path,
    data: bytes,
    validator: Callable[[Path], None] | None = None,
) -> None:
    path = Path(path)
    ensure_private_dir(path.parent)
    if path.is_symlink():
        raise ValueError(f"輸出檔不可為 symlink：{path}")

    temp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}"
    descriptor = -1
    try:
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, 0o600)
        if validator:
            validator(temp)
        os.replace(temp, path)
        _fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temp.unlink(missing_ok=True)


def _decode_json_object(raw: bytes, path: Path) -> dict:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"JSON 無法讀取：{path} ({exc})") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON 最上層必須是 object：{path}")
    return value


def _read_json_bytes(path: Path) -> bytes:
    path = Path(path)
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ValueError(f"JSON 無法讀取：{path} ({exc})") from exc


def load_json_object(path: Path) -> dict:
    path = Path(path)
    return _decode_json_object(_read_json_bytes(path), path)


def load_json_object_with_sha256(path: Path) -> tuple[dict, str]:
    path = Path(path)
    raw = _read_json_bytes(path)
    return _decode_json_object(raw, path), sha256_bytes(raw)


def atomic_write_json(path: Path, value: dict) -> str:
    if not isinstance(value, dict):
        raise ValueError("只允許寫入 JSON object")
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    payload_bytes = payload.encode("utf-8")
    atomic_write_bytes(path, payload_bytes, lambda candidate: load_json_object(candidate))
    return sha256_bytes(payload_bytes)


def estimate_paid_usage(durations_seconds: Iterable[float]) -> dict:
    durations = [Decimal(str(value)) for value in durations_seconds]
    if any(value <= 0 for value in durations):
        raise ValueError("每段音訊時長都必須大於 0")
    billed_minutes = sum(math.ceil(float(value / Decimal(60))) for value in durations)
    raw = Decimal(billed_minutes) * SCRIBE_USD_PER_HOUR / Decimal(60)
    buffered = raw * ESTIMATE_BUFFER
    quant = Decimal("0.0001")
    return {
        "total_seconds": float(sum(durations)),
        "billed_minutes": billed_minutes,
        "usd_per_hour": str(SCRIBE_USD_PER_HOUR),
        "rate_checked_on": RATE_CHECKED_ON,
        "raw_usd": str(raw.quantize(quant, rounding=ROUND_HALF_UP)),
        "buffered_usd": str(buffered.quantize(quant, rounding=ROUND_HALF_UP)),
        "buffer_percent": 10,
        "tax_included": False,
    }


def within_paid_caps(estimate: dict) -> bool:
    try:
        duration = Decimal(str(estimate["total_seconds"]))
        buffered = Decimal(str(estimate["buffered_usd"]))
    except (KeyError, ValueError, TypeError):
        return False
    return duration <= MAX_TOTAL_SECONDS and buffered <= MAX_BUFFERED_USD


def capture_data_snapshot(path: Path) -> dict:
    path = Path(path)
    raw = path.read_bytes()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"data.json 無法讀取：{exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("lessons"), list):
        raise ValueError("data.json 缺少 lessons 陣列")
    lessons = data["lessons"]
    card_count = sum(len(lesson.get("cards") or []) for lesson in lessons if isinstance(lesson, dict))
    return {
        "path": str(path.resolve()),
        "sha256": sha256_bytes(raw),
        "size_bytes": len(raw),
        "generated_at": data.get("generated_at"),
        "lesson_count": len(lessons),
        "card_count": card_count,
    }


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_process(
    args: list[str],
    *,
    input_bytes: bytes | None = None,
    timeout: float | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        input=input_bytes,
        capture_output=True,
        check=False,
        timeout=timeout,
        env=env,
    )


def _limited_error(completed: subprocess.CompletedProcess, limit: int = 2000) -> str:
    raw = completed.stderr or completed.stdout or b""
    if isinstance(raw, bytes):
        text = raw.decode("utf-8", errors="replace")
    else:
        text = str(raw)
    return text.replace("\x00", "").strip()[:limit]


def ffprobe_json(
    path: Path,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    completed = runner(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ]
    )
    if completed.returncode != 0:
        raise ValueError(f"ffprobe 無法讀取 {path.name}：{_limited_error(completed)}")
    try:
        payload = json.loads(completed.stdout.decode("utf-8"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"ffprobe 回傳無效 JSON：{path.name}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"ffprobe 回傳格式錯誤：{path.name}")
    return payload


def inspect_single_audio(
    path: Path,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    payload = ffprobe_json(path, runner)
    streams = payload.get("streams") if isinstance(payload.get("streams"), list) else []
    audio_streams = [stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"]
    if not audio_streams:
        raise ValueError(f"{path.name} 沒有可用音軌")
    if len(audio_streams) == 1:
        stream = audio_streams[0]
        selection = "only_audio_stream"
    else:
        default_streams = [
            candidate
            for candidate in audio_streams
            if (candidate.get("disposition") or {}).get("default") == 1
        ]
        if len(default_streams) != 1:
            raise ValueError(
                f"{path.name} 有 {len(audio_streams)} 個可用音軌，"
                f"但 default 音軌為 {len(default_streams)} 個，無法安全自動選擇"
            )
        stream = default_streams[0]
        selection = "unique_default_audio_stream"
    duration_value = stream.get("duration") or (payload.get("format") or {}).get("duration")
    try:
        duration = float(duration_value)
        stream_index = int(stream["index"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{path.name} 缺少有效音軌時長或 index") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"{path.name} 音軌時長無效")
    return {
        "stream_index": stream_index,
        "audio_stream_count": len(audio_streams),
        "selection": selection,
        "duration_seconds": duration,
        "codec_name": str(stream.get("codec_name") or ""),
        "sample_rate": int(stream.get("sample_rate") or 0),
        "channels": int(stream.get("channels") or 0),
        "bit_rate": int(stream.get("bit_rate") or (payload.get("format") or {}).get("bit_rate") or 0),
    }


def _validate_mp3(
    path: Path,
    source_duration: float,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    if not path.is_file() or path.stat().st_size <= 0:
        raise ValueError(f"MP3 為空或不存在：{path}")
    details = inspect_single_audio(path, runner)
    if details["codec_name"] != "mp3":
        raise ValueError(f"MP3 codec 不符：{details['codec_name']}")
    if details["sample_rate"] != MP3_SAMPLE_RATE or details["channels"] != MP3_CHANNELS:
        raise ValueError("MP3 必須是 16 kHz mono")
    if not 50000 <= details["bit_rate"] <= 80000:
        raise ValueError(f"MP3 bitrate 不在約 64 kbps 範圍：{details['bit_rate']}")
    tolerance = max(1.0, source_duration * 0.02)
    if abs(details["duration_seconds"] - source_duration) > tolerance:
        raise ValueError("MP3 與來源時長差異超出容許範圍")

    decoded = runner(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
        ]
    )
    if decoded.returncode != 0:
        raise ValueError(f"MP3 無法完整解碼：{_limited_error(decoded)}")
    return {
        **details,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def _convert_mp3_atomic(
    source: Path,
    stream_index: int,
    source_duration: float,
    source_sha256: str,
    target: Path,
    runner: Callable[..., subprocess.CompletedProcess] = run_process,
) -> dict:
    ensure_private_dir(target.parent)
    if target.exists() or target.is_symlink():
        raise ValueError(f"MP3 輸出已存在且無法證明可重用：{target}")
    temp = _exclusive_transport_temp(target.parent, target.name)
    try:
        completed = runner(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-map",
                f"0:{stream_index}",
                "-vn",
                "-codec:a",
                "libmp3lame",
                "-ar",
                str(MP3_SAMPLE_RATE),
                "-ac",
                str(MP3_CHANNELS),
                "-b:a",
                f"{MP3_BITRATE // 1000}k",
                "-f",
                "mp3",
                str(temp),
            ]
        )
        if completed.returncode != 0:
            raise ValueError(f"FFmpeg 轉檔失敗：{_limited_error(completed)}")
        os.chmod(temp, 0o600)
        details = _validate_mp3(temp, source_duration, runner)
        if sha256_file(source) != source_sha256:
            raise ValueError("來源內容已在轉檔期間變更")
        with temp.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temp, target)
        _fsync_directory(target.parent)
        details["path"] = str(target.resolve())
        return details
    finally:
        temp.unlink(missing_ok=True)


def _exclusive_transport_temp(parent: Path, label: str) -> Path:
    path = parent / f".{label}.tmp-{os.getpid()}-{secrets.token_hex(6)}"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    return path


def _approval_summary(segments: list[dict]) -> dict:
    pending_segments = [segment for segment in segments if segment["state"] != "Complete"]
    estimate = estimate_paid_usage(
        segment["mp3"]["duration_seconds"] for segment in pending_segments
    )
    return {
        "version": 1,
        "destination": "ElevenLabs Speech-to-Text API",
        "endpoint": SCRIBE_ENDPOINT,
        "retention_disclosure": (
            "ElevenLabs standard logging may retain uploaded STT audio and text; "
            "Zero Retention is Enterprise-only and is not assumed for this run."
        ),
        "request": copy.deepcopy(SCRIBE_REQUEST_CONTRACT),
        "segments": [
            {
                "index": segment["index"],
                "source_name": segment["source"]["name"],
                "source_sha256": segment["source"]["sha256"],
                "mp3_name": Path(segment["mp3"]["path"]).name,
                "mp3_sha256": segment["mp3"]["sha256"],
                "duration_seconds": segment["mp3"]["duration_seconds"],
                "size_bytes": segment["mp3"]["size_bytes"],
            }
            for segment in pending_segments
        ],
        "estimate": estimate,
    }


def _check_source(path: Path) -> None:
    if path.suffix.lower() != ".mp4":
        raise ValueError(f"只接受 MP4：{path}")
    if path.is_symlink():
        raise ValueError(f"來源不可為 symlink：{path}")
    if not path.is_file() or path.stat().st_size <= 0:
        raise ValueError(f"來源不存在或為空：{path}")



__all__ = [name for name in globals() if not name.startswith("__")]
