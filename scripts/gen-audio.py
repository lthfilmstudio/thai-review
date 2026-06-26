#!/usr/bin/env python3
"""
gen-audio.py - dry-run planner for ElevenLabs baked Thai MP3 audio.

This first version intentionally does not call ElevenLabs or write audio files.
It reads data.json, dedupes Thai strings, checks an optional audio manifest,
and reports the estimated cost for the selected ElevenLabs voice/model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


DEFAULT_VOICE_NAME = "Jessica - Playful, Bright, Warm"
DEFAULT_VOICE_ID = "r1KmysJdVYZjJCm4mL3b"
DEFAULT_MODEL_ID = "eleven_v3"
DEFAULT_LANGUAGE_CODE = "th"
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"
DEFAULT_AUDIO_PREFIX = "audio/jessica-v1"
DEFAULT_USD_PER_1K_CHARS = 0.10
DEFAULT_TWD_RATE = 31.835
CREATOR_CREDITS = 121_000
TAIPEI = ZoneInfo("Asia/Taipei")


@dataclass(frozen=True)
class AudioSpec:
    voice_name: str
    voice_id: str
    model_id: str
    language_code: str
    output_format: str
    audio_prefix: str


@dataclass(frozen=True)
class ThaiItem:
    thai: str
    zh: str
    lesson: str
    count: int


def text_len(text: str) -> int:
    return len(text)


def audio_key(text: str, spec: AudioSpec) -> str:
    payload = {
        "v": 1,
        "model_id": spec.model_id,
        "voice_id": spec.voice_id,
        "output_format": spec.output_format,
        "language_code": spec.language_code,
        "text": text,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def audio_path(key: str, spec: AudioSpec) -> str:
    return f"{spec.audio_prefix.rstrip('/')}/{key}.mp3"


def load_data(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"data file not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"data file is not valid JSON: {path} ({exc})")


def collect_unique_thai(data: dict) -> tuple[list[ThaiItem], int, int, int]:
    lessons = data.get("lessons") or []
    first_seen: dict[str, dict[str, str]] = {}
    counts: dict[str, int] = {}
    total_cards = 0
    total_chars = 0

    for lesson in lessons:
        lesson_title = str(lesson.get("title") or "")
        for card in lesson.get("cards") or []:
            thai = str(card.get("thai") or "").strip()
            if not thai:
                continue
            total_cards += 1
            total_chars += text_len(thai)
            counts[thai] = counts.get(thai, 0) + 1
            if thai not in first_seen:
                first_seen[thai] = {
                    "thai": thai,
                    "zh": str(card.get("zh") or "").strip(),
                    "lesson": lesson_title,
                }

    items = [
        ThaiItem(
            thai=value["thai"],
            zh=value["zh"],
            lesson=value["lesson"],
            count=counts[value["thai"]],
        )
        for value in first_seen.values()
    ]
    unique_chars = sum(text_len(item.thai) for item in items)
    return items, total_cards, total_chars, unique_chars


def manifest_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path} ({exc})")

    keys: set[str] = set()
    if isinstance(data, dict):
        for field in ("keys", "generated_keys", "audio_keys"):
            value = data.get(field)
            if isinstance(value, list):
                keys.update(str(item) for item in value)

        entries = data.get("entries") or data.get("items") or data.get("audio")
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    key = entry.get("key") or entry.get("audio_key") or entry.get("hash")
                    if key:
                        keys.add(str(key))
        elif isinstance(entries, dict):
            keys.update(str(key) for key in entries.keys())

    elif isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict):
                key = entry.get("key") or entry.get("audio_key") or entry.get("hash")
                if key:
                    keys.add(str(key))
            elif isinstance(entry, str):
                keys.add(entry)

    return keys


def build_dry_run(
    *,
    data_path: Path,
    manifest_path: Path,
    data: dict,
    spec: AudioSpec,
    items: list[ThaiItem],
    total_cards: int,
    total_chars: int,
    unique_chars: int,
    existing_keys: set[str],
    usd_per_1k_chars: float,
    twd_rate: float,
) -> dict:
    keyed_items = [
        {
            "key": audio_key(item.thai, spec),
            "path": audio_path(audio_key(item.thai, spec), spec),
            "item": item,
            "chars": text_len(item.thai),
        }
        for item in items
    ]
    missing = [entry for entry in keyed_items if entry["key"] not in existing_keys]
    missing_chars = sum(int(entry["chars"]) for entry in missing)
    estimated_usd = missing_chars / 1000 * usd_per_1k_chars
    duplicate_saved_chars = total_chars - unique_chars
    duplicate_saved_usd = duplicate_saved_chars / 1000 * usd_per_1k_chars

    return {
        "data_path": str(data_path),
        "data_generated_at": taipei_time_from_unix(data.get("generated_at")),
        "source_url": data.get("source_url") or "unknown",
        "manifest_path": str(manifest_path),
        "manifest_found": manifest_path.exists(),
        "audio_spec": {
            "voice_name": spec.voice_name,
            "voice_id": spec.voice_id,
            "model_id": spec.model_id,
            "language_code": spec.language_code,
            "output_format": spec.output_format,
            "audio_prefix": spec.audio_prefix,
        },
        "coverage": {
            "lessons": len(data.get("lessons") or []),
            "thai_cards": total_cards,
            "unique_thai_strings": len(items),
            "all_thai_chars_without_dedupe": total_chars,
            "unique_thai_chars": unique_chars,
            "dedupe_saved_chars": duplicate_saved_chars,
            "dedupe_saved_usd": duplicate_saved_usd,
            "existing_generated_keys": len(existing_keys),
            "missing_audio_files": len(missing),
            "missing_chars_to_generate": missing_chars,
        },
        "cost": {
            "usd_per_1k_chars": usd_per_1k_chars,
            "twd_rate": twd_rate,
            "estimated_usd": estimated_usd,
            "estimated_twd": estimated_usd * twd_rate,
            "estimated_usd_with_10pct_buffer": estimated_usd * 1.10,
            "estimated_twd_with_10pct_buffer": estimated_usd * 1.10 * twd_rate,
            "creator_credits": CREATOR_CREDITS,
            "creator_remaining_after_run": CREATOR_CREDITS - missing_chars,
        },
        "missing": missing,
    }


def format_usd(value: float) -> str:
    return f"US${value:,.2f}"


def format_twd(value: float) -> str:
    return f"NT${round(value):,}"


def taipei_time_from_unix(value: object) -> str:
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return "unknown"
    return datetime.fromtimestamp(timestamp, TAIPEI).strftime("%Y-%m-%d %H:%M:%S %Z")


def print_report(
    dry_run: dict,
    show_examples: int,
) -> None:
    spec = dry_run["audio_spec"]
    coverage = dry_run["coverage"]
    cost = dry_run["cost"]
    missing = dry_run["missing"]

    print("ElevenLabs Thai audio dry-run")
    print("=" * 32)
    print(f"Data: {dry_run['data_path']}")
    print(f"Data generated: {dry_run['data_generated_at']}")
    print(f"Source: {dry_run['source_url']}")
    print()
    print("Audio spec")
    print(f"- Voice: {spec['voice_name']}")
    print(f"- Voice ID: {spec['voice_id']}")
    print(f"- Model: {spec['model_id']}")
    print(f"- Language: {spec['language_code']}")
    print(f"- Output: {spec['output_format']}")
    print(f"- Planned path: {spec['audio_prefix']}/<key>.mp3")
    print()
    print("Current coverage")
    print(f"- Lessons: {coverage['lessons']:,}")
    print(f"- Thai cards: {coverage['thai_cards']:,}")
    print(f"- Unique Thai strings: {coverage['unique_thai_strings']:,}")
    print(f"- All Thai chars without dedupe: {coverage['all_thai_chars_without_dedupe']:,}")
    print(f"- Unique Thai chars: {coverage['unique_thai_chars']:,}")
    print(f"- Dedupe saves: {coverage['dedupe_saved_chars']:,} chars ({format_usd(coverage['dedupe_saved_usd'])})")
    print()
    if dry_run["manifest_found"]:
        print(f"Manifest: {dry_run['manifest_path']}")
        print(f"- Existing generated keys: {coverage['existing_generated_keys']:,}")
    else:
        print(f"Manifest: not found ({dry_run['manifest_path']})")
        print("- Existing generated keys: 0")
    print(f"- Missing audio files: {coverage['missing_audio_files']:,}")
    print(f"- Missing chars to generate: {coverage['missing_chars_to_generate']:,}")
    print()
    print("Estimated generation cost")
    print(f"- Rate: {format_usd(cost['usd_per_1k_chars'])} / 1,000 chars")
    print(f"- Estimate: {format_usd(cost['estimated_usd'])} ({format_twd(cost['estimated_twd'])})")
    print(f"- With 10% buffer: {format_usd(cost['estimated_usd_with_10pct_buffer'])} ({format_twd(cost['estimated_twd_with_10pct_buffer'])})")
    print(f"- Creator 121,000 credits remaining after this run: {cost['creator_remaining_after_run']:,}")
    if cost["creator_remaining_after_run"] < 0:
        print("  WARNING: Creator credits are not enough for this run without top-up or batching.")
    print()
    print("Safety")
    print("- This command did not call ElevenLabs.")
    print("- This command did not write MP3 files.")
    print("- Free plan cannot use this Voice Library voice through the API; paid plan is required for generation.")

    if show_examples > 0 and missing:
        print()
        print(f"First {min(show_examples, len(missing))} missing examples")
        for entry in missing[:show_examples]:
            item = entry["item"]
            print(f"- {entry['key']} | {entry['chars']} chars | {entry['path']} | {item.lesson} | {item.thai}")


def json_ready(value: object) -> object:
    if isinstance(value, ThaiItem):
        return {
            "thai": value.thai,
            "zh": value.zh,
            "lesson": value.lesson,
            "count": value.count,
        }
    if isinstance(value, dict):
        return {key: json_ready(item) for key, item in value.items() if key != "missing"}
    if isinstance(value, list):
        return [json_ready(item) for item in value]
    return value


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Plan ElevenLabs baked Thai MP3 generation.")
    parser.add_argument("--dry-run", action="store_true", help="Report missing audio and cost. Required in this version.")
    parser.add_argument("--data", default="data.json", type=Path, help="Path to thai-review data.json.")
    parser.add_argument("--manifest", default="audio-manifest.json", type=Path, help="Path to audio manifest JSON.")
    parser.add_argument("--voice-name", default=DEFAULT_VOICE_NAME)
    parser.add_argument("--voice-id", default=DEFAULT_VOICE_ID)
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--language-code", default=DEFAULT_LANGUAGE_CODE)
    parser.add_argument("--output-format", default=DEFAULT_OUTPUT_FORMAT)
    parser.add_argument("--audio-prefix", default=DEFAULT_AUDIO_PREFIX)
    parser.add_argument("--usd-per-1k-chars", default=DEFAULT_USD_PER_1K_CHARS, type=float)
    parser.add_argument("--twd-rate", default=DEFAULT_TWD_RATE, type=float)
    parser.add_argument("--show-examples", default=5, type=int)
    parser.add_argument("--json", action="store_true", help="Print a machine-readable summary without the full missing list.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.dry_run:
        print("ERROR: this version only supports --dry-run and never generates audio.", file=sys.stderr)
        return 2

    data_path = args.data
    manifest_path = args.manifest
    data = load_data(data_path)
    spec = AudioSpec(
        voice_name=args.voice_name,
        voice_id=args.voice_id,
        model_id=args.model_id,
        language_code=args.language_code,
        output_format=args.output_format,
        audio_prefix=args.audio_prefix,
    )
    items, total_cards, total_chars, unique_chars = collect_unique_thai(data)
    existing_keys = manifest_keys(manifest_path)
    dry_run = build_dry_run(
        data_path=data_path,
        manifest_path=manifest_path,
        data=data,
        spec=spec,
        items=items,
        total_cards=total_cards,
        total_chars=total_chars,
        unique_chars=unique_chars,
        existing_keys=existing_keys,
        usd_per_1k_chars=args.usd_per_1k_chars,
        twd_rate=args.twd_rate,
    )
    if args.json:
        print(json.dumps(json_ready(dry_run), ensure_ascii=False, indent=2))
    else:
        print_report(dry_run=dry_run, show_examples=max(args.show_examples, 0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
