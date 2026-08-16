#!/usr/bin/env python3
"""Prepare and transcribe explicitly listed Thai class MP4 recordings."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Callable, Iterable


STATE_VERSION = 1
MAX_JOB_ID_LENGTH = 80
MAX_TOTAL_SECONDS = Decimal("7200")
MAX_BUFFERED_USD = Decimal("0.50")
SCRIBE_USD_PER_HOUR = Decimal("0.22")
ESTIMATE_BUFFER = Decimal("1.10")
RATE_CHECKED_ON = "2026-08-16"


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
    if job_id in {".", ".."} or len(job_id) > MAX_JOB_ID_LENGTH:
        raise ValueError("job ID 不安全")

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
        try:
            if temp.exists() or temp.is_symlink():
                temp.unlink()
        except FileNotFoundError:
            pass


def load_json_object(path: Path) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"JSON 無法讀取：{path} ({exc})") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON 最上層必須是 object：{path}")
    return value


def atomic_write_json(path: Path, value: dict) -> None:
    if not isinstance(value, dict):
        raise ValueError("只允許寫入 JSON object")
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    atomic_write_bytes(path, payload.encode("utf-8"), lambda candidate: load_json_object(candidate))


def estimate_paid_usage(durations_seconds: Iterable[float]) -> dict:
    durations = [Decimal(str(value)) for value in durations_seconds]
    if not durations or any(value <= 0 for value in durations):
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


if __name__ == "__main__":
    raise SystemExit("CLI 尚未啟用；請先完成免費預檢單元。")
