#!/usr/bin/env python3
"""
gen-audio.py - dry-run planner for ElevenLabs baked Thai MP3 audio.

Dry-run mode reads data.json, dedupes Thai strings, checks an optional audio
manifest, and reports the estimated cost for the selected ElevenLabs voice/model.
Generate mode is guarded by explicit paid-API confirmation and a character cap.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib import error, parse, request
from zoneinfo import ZoneInfo


DEFAULT_VOICE_NAME = "Jessica - Playful, Bright, Warm"
DEFAULT_VOICE_ID = "r1KmysJdVYZjJCm4mL3b"
DEFAULT_MODEL_ID = "eleven_v3"
DEFAULT_LANGUAGE_CODE = "th"
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"
DEFAULT_AUDIO_PREFIX = "audio/jessica-v1"
DEFAULT_OUT_DIR = Path("out")
DEFAULT_USD_PER_1K_CHARS = 0.10
DEFAULT_TWD_RATE = 31.835
CREATOR_CREDITS = 121_000
TAIPEI = ZoneInfo("Asia/Taipei")
ELEVENLABS_TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech"


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


def normalize_audio_text(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "").strip())


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


def local_audio_path(key: str, spec: AudioSpec, out_dir: Path) -> Path:
    return out_dir / audio_path(key, spec)


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


def manifest_coverage(path: Path) -> tuple[set[str], set[str]]:
    if not path.exists():
        return set(), set()

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path} ({exc})")

    keys: set[str] = set()
    normalized_thai: set[str] = set()

    def add_entry(entry: object, fallback_key: object = None) -> None:
        if fallback_key:
            keys.add(str(fallback_key))
        if isinstance(entry, dict):
            key = entry.get("key") or entry.get("audio_key") or entry.get("hash")
            if key:
                keys.add(str(key))
            normalized = normalize_audio_text(str(entry.get("thai") or ""))
            if normalized:
                normalized_thai.add(normalized)
        elif isinstance(entry, str):
            keys.add(entry)

    if isinstance(data, dict):
        for field in ("keys", "generated_keys", "audio_keys"):
            value = data.get(field)
            if isinstance(value, list):
                keys.update(str(item) for item in value)

        entries = data.get("entries") or data.get("items") or data.get("audio")
        if isinstance(entries, list):
            for entry in entries:
                add_entry(entry)
        elif isinstance(entries, dict):
            for key, entry in entries.items():
                add_entry(entry, key)

    elif isinstance(data, list):
        for entry in data:
            add_entry(entry)

    return keys, normalized_thai


def manifest_keys(path: Path) -> set[str]:
    keys, _ = manifest_coverage(path)
    return keys


def load_manifest(path: Path, spec: AudioSpec) -> dict:
    if not path.exists():
        return {
            "version": 1,
            "generated_at": None,
            "spec": manifest_spec(spec),
            "items": {},
        }

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path} ({exc})")

    if not isinstance(data, dict):
        raise SystemExit(f"manifest root must be a JSON object: {path}")

    data.setdefault("version", 1)
    data.setdefault("spec", manifest_spec(spec))
    data.setdefault("items", {})
    if not isinstance(data["items"], dict):
        raise SystemExit(f"manifest items must be a JSON object: {path}")
    return data


def manifest_spec(spec: AudioSpec) -> dict:
    return {
        "provider": "elevenlabs",
        "voice_name": spec.voice_name,
        "voice_id": spec.voice_id,
        "model_id": spec.model_id,
        "language_code": spec.language_code,
        "output_format": spec.output_format,
        "audio_prefix": spec.audio_prefix,
    }


def write_manifest(path: Path, manifest: dict) -> None:
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def now_taipei_iso() -> str:
    return datetime.now(TAIPEI).isoformat(timespec="seconds")


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
    existing_normalized_thai: set[str] | None = None,
) -> dict:
    existing_normalized_thai = existing_normalized_thai or set()
    keyed_items = [
        {
            "key": key,
            "path": audio_path(key, spec),
            "item": item,
            "chars": text_len(item.thai),
        }
        for item in items
        for key in [audio_key(item.thai, spec)]
    ]
    normalized_reused = [
        entry for entry in keyed_items
        if entry["key"] not in existing_keys
        and normalize_audio_text(entry["item"].thai) in existing_normalized_thai
    ]
    missing = [
        entry for entry in keyed_items
        if entry["key"] not in existing_keys
        and normalize_audio_text(entry["item"].thai) not in existing_normalized_thai
    ]
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
            "space_normalized_reused_files": len(normalized_reused),
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


def select_for_generation(missing: list[dict], limit: int | None, max_chars: int) -> tuple[list[dict], int, bool]:
    selected: list[dict] = []
    used_chars = 0
    hit_cap = False

    for entry in missing:
        if limit is not None and len(selected) >= limit:
            break

        entry_chars = int(entry["chars"])
        if max_chars >= 0 and used_chars + entry_chars > max_chars:
            hit_cap = True
            break

        selected.append(entry)
        used_chars += entry_chars

    return selected, used_chars, hit_cap


def call_elevenlabs_tts(text: str, spec: AudioSpec, api_key: str) -> bytes:
    endpoint = f"{ELEVENLABS_TTS_ENDPOINT}/{parse.quote(spec.voice_id)}"
    url = f"{endpoint}?output_format={parse.quote(spec.output_format)}"
    payload = json.dumps(
        {
            "text": text,
            "model_id": spec.model_id,
            "language_code": spec.language_code,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
            "xi-api-key": api_key,
        },
    )
    try:
        with request.urlopen(req, timeout=90) as resp:
            return resp.read()
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ElevenLabs HTTP {exc.code}: {detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"ElevenLabs request failed: {exc}") from exc


def write_audio_file(path: Path, audio: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_bytes(audio)
    tmp_path.replace(path)


def generate_audio(dry_run: dict, spec: AudioSpec, args: argparse.Namespace) -> int:
    if not args.confirm_paid_api:
        print("ERROR: --generate requires --confirm-paid-api.", file=sys.stderr)
        return 2

    if args.max_chars is None:
        print("ERROR: --generate requires --max-chars to cap paid API usage.", file=sys.stderr)
        return 2

    missing = dry_run["missing"]
    limit = args.limit if args.limit is not None else None
    selected, selected_chars, hit_cap = select_for_generation(missing, limit, args.max_chars)

    print("ElevenLabs Thai audio generation")
    print("=" * 36)
    print(f"Selected files: {len(selected):,}")
    print(f"Selected chars: {selected_chars:,}")
    print(f"Max chars: {args.max_chars:,}")
    if limit is not None:
        print(f"Limit: {limit:,}")
    if hit_cap:
        print("Stopped at max char cap before selecting all missing items.")

    if not selected:
        print("Nothing selected; no API calls made.")
        return 0

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY is required for --generate.", file=sys.stderr)
        return 2

    manifest = load_manifest(args.manifest, spec)
    manifest["spec"] = manifest_spec(spec)
    manifest["generated_at"] = now_taipei_iso()
    items = manifest["items"]

    for index, entry in enumerate(selected, start=1):
        key = entry["key"]
        item: ThaiItem = entry["item"]
        rel_path = entry["path"]
        file_path = local_audio_path(key, spec, args.out_dir)
        if file_path.exists():
            print(f"[{index}/{len(selected)}] skip existing file {rel_path}")
        else:
            print(f"[{index}/{len(selected)}] generate {rel_path} ({entry['chars']} chars)")
            audio = call_elevenlabs_tts(item.thai, spec, api_key)
            write_audio_file(file_path, audio)

        items[key] = {
            "path": rel_path,
            "chars": entry["chars"],
            "first_lesson": item.lesson,
            "thai": item.thai,
            "generated_at": now_taipei_iso(),
        }
        write_manifest(args.manifest, manifest)

    print(f"Updated manifest: {args.manifest}")
    print(f"Local audio root: {args.out_dir}")
    return 0


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
        if coverage.get("space_normalized_reused_files"):
            print(f"- Reused after whitespace normalization: {coverage['space_normalized_reused_files']:,}")
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
    print("- Dry-run did not call ElevenLabs.")
    print("- Dry-run did not write MP3 files.")
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
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Report missing audio and cost.")
    mode.add_argument("--generate", action="store_true", help="Generate missing audio through ElevenLabs.")
    parser.add_argument("--data", default="data.json", type=Path, help="Path to thai-review data.json.")
    parser.add_argument("--manifest", default="audio-manifest.json", type=Path, help="Path to audio manifest JSON.")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, type=Path, help="Local root for generated audio files.")
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
    parser.add_argument("--limit", type=int, help="Maximum number of missing items to generate.")
    parser.add_argument("--max-chars", type=int, help="Maximum paid characters allowed for this generate run.")
    parser.add_argument("--confirm-paid-api", action="store_true", help="Required with --generate to acknowledge paid API usage.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.dry_run and not args.generate:
        print("ERROR: choose --dry-run or --generate.", file=sys.stderr)
        return 2
    if args.generate and args.json:
        print("ERROR: --json is only supported with --dry-run.", file=sys.stderr)
        return 2
    if args.limit is not None and args.limit < 0:
        print("ERROR: --limit must be >= 0.", file=sys.stderr)
        return 2
    if args.max_chars is not None and args.max_chars < 0:
        print("ERROR: --max-chars must be >= 0.", file=sys.stderr)
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
    existing_keys, existing_normalized_thai = manifest_coverage(manifest_path)
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
        existing_normalized_thai=existing_normalized_thai,
        usd_per_1k_chars=args.usd_per_1k_chars,
        twd_rate=args.twd_rate,
    )
    if args.json:
        print(json.dumps(json_ready(dry_run), ensure_ascii=False, indent=2))
    elif args.dry_run:
        print_report(dry_run=dry_run, show_examples=max(args.show_examples, 0))
    else:
        return generate_audio(dry_run, spec, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
