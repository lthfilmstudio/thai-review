#!/usr/bin/env python3
"""
gen-zh-audio.py - per-lesson Chinese hint audio sprites (GCP TTS, cmn-TW-Wavenet-A).

Dry-run mode reads data.json, collects per-lesson zh hints, and reports which
lessons need (re)baking plus the estimated GCP cost. Generate mode is guarded
by explicit paid-API confirmation and a character cap.

Output per lesson (under --out-dir):
  audio/zh-tw/{lessonId}-{hash8}-p{n}.mp3   sprite parts (<= PART_MAX_SEC each)
  audio/zh-tw/{lessonId}-{hash8}.json       {"files":[...], "items":{zh:[fileIdx,startMs,durMs]}}
Plus a root zh-manifest.json: {"lessons":{lessonId:{"hash","timing"}}}.

Voice params match the lth-tts-proxy Worker exactly, so sprite audio sounds
identical to the Worker fallback.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import error, request
from zoneinfo import ZoneInfo

VOICE = "cmn-TW-Wavenet-A"
LANGUAGE_CODE = "cmn-TW"
SPEAKING_RATE = 1.0
PITCH = 0
EFFECTS_PROFILE = ["headphone-class-device"]
SAMPLE_RATE = 24000
BITRATE = "48k"
LEAD_IN_MS = 60      # 檔頭靜音，吸收 MP3 encoder delay
SPACER_MS = 120      # 段間靜音，切片誤差緩衝
PART_MAX_SEC = 240   # 單一 part 上限，防手機 decodeAudioData 記憶體爆掉
MAX_SEG_CHARS = 200  # 與 Worker MAX_TEXT_LENGTH 一致；超過的段跳過（前端 fallback）
USD_PER_1M_CHARS = 16.0  # GCP WaveNet
AUDIO_PREFIX = "audio/zh-tw"
KEYCHAIN_SERVICE = "gcp-tts-thai-review"
GCP_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"
TAIPEI = ZoneInfo("Asia/Taipei")

LEAD_IN_SAMPLES = SAMPLE_RATE * LEAD_IN_MS // 1000
SPACER_SAMPLES = SAMPLE_RATE * SPACER_MS // 1000


def now_taipei_iso() -> str:
    return datetime.now(TAIPEI).isoformat(timespec="seconds")


def seg_cache_key(text: str) -> str:
    return hashlib.sha256(f"{VOICE}|{text}".encode("utf-8")).hexdigest()[:16]


def lesson_hash(zh_list: list[str]) -> str:
    payload = json.dumps(
        [VOICE, SPEAKING_RATE, BITRATE, SPACER_MS, LEAD_IN_MS, PART_MAX_SEC, *zh_list],
        ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]


def load_data(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"data file not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"data file is not valid JSON: {path} ({exc})")


def collect_lessons(data: dict) -> list[dict]:
    """每堂課的 zh 清單：trim、堂內去重、保持首見順序、跳過過長段。"""
    lessons = []
    for lesson in data.get("lessons") or []:
        lesson_id = str(lesson.get("id") or "").strip()
        if not lesson_id:
            continue
        seen: dict[str, None] = {}
        skipped_long = 0
        for card in lesson.get("cards") or []:
            zh = str(card.get("zh") or "").strip()
            if not zh:
                continue
            if len(zh) > MAX_SEG_CHARS:
                skipped_long += 1
                continue
            seen.setdefault(zh, None)
        zh_list = list(seen.keys())
        if not zh_list:
            continue
        lessons.append({
            "id": lesson_id,
            "title": str(lesson.get("title") or ""),
            "zh_list": zh_list,
            "hash": lesson_hash(zh_list),
            "chars": sum(len(z) for z in zh_list),
            "skipped_long": skipped_long,
        })
    return lessons


def load_zh_manifest(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "voice": VOICE, "lessons": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"zh manifest is not valid JSON: {path} ({exc})")
    if not isinstance(data, dict) or not isinstance(data.get("lessons"), dict):
        raise SystemExit(f"zh manifest malformed: {path}")
    return data


def lesson_is_current(entry: dict | None, lesson: dict, out_dir: Path) -> bool:
    """manifest hash 相同且 timing + 所有 part 檔都在，才算不用重烤。"""
    if not entry or entry.get("hash") != lesson["hash"]:
        return False
    timing_rel = entry.get("timing") or ""
    timing_path = out_dir / timing_rel
    if not timing_path.is_file():
        return False
    try:
        timing = json.loads(timing_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    files = timing.get("files") or []
    if not files:
        return False
    return all((out_dir / f).is_file() for f in files)


def resolve_api_key() -> str | None:
    key = os.environ.get("GCP_TTS_KEY")
    if key:
        return key
    if shutil.which("security"):
        proc = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return None


def call_gcp_tts(text: str, api_key: str) -> bytes:
    payload = json.dumps({
        "input": {"text": text},
        "voice": {"languageCode": LANGUAGE_CODE, "name": VOICE},
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": SPEAKING_RATE,
            "pitch": PITCH,
            "effectsProfileId": EFFECTS_PROFILE,
        },
    }, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        f"{GCP_ENDPOINT}?key={api_key}",
        data=payload, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    last_err: Exception | None = None
    for attempt in range(5):
        if attempt:
            time.sleep(2 ** attempt)  # 2,4,8,16s
        try:
            with request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            audio = body.get("audioContent")
            if not audio:
                raise RuntimeError(f"GCP response missing audioContent for: {text!r}")
            return base64.b64decode(audio)
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            if exc.code in (429, 500, 502, 503):
                last_err = RuntimeError(f"GCP HTTP {exc.code}: {detail}")
                continue
            raise RuntimeError(f"GCP HTTP {exc.code}: {detail}") from exc
        except error.URLError as exc:
            last_err = exc
            continue
    raise RuntimeError(f"GCP TTS failed after retries: {last_err}")


def require_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise SystemExit("ffmpeg not found in PATH (expected e.g. ~/.local/bin/ffmpeg)")
    return path


def decode_to_pcm(ffmpeg: str, mp3_path: Path) -> bytes:
    """MP3 → 24kHz mono s16le raw PCM。"""
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(mp3_path),
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg decode failed for {mp3_path}: {proc.stderr.decode()[:200]}")
    return proc.stdout


def encode_part(ffmpeg: str, pcm: bytes, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".mp3.tmp")
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
         "-i", "-", "-codec:a", "libmp3lame", "-b:a", BITRATE, "-f", "mp3", "-y", str(tmp)],
        input=pcm, capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg encode failed for {out_path}: {proc.stderr.decode()[:200]}")
    tmp.replace(out_path)


def build_lesson_sprite(ffmpeg: str, lesson: dict, seg_pcm: dict[str, bytes], out_dir: Path) -> dict:
    """把一堂課的段落 PCM 拼成多個 part，回傳 timing dict 並寫出 mp3/json。"""
    part_max_samples = PART_MAX_SEC * SAMPLE_RATE
    parts: list[list[tuple[str, int, int]]] = []  # [(zh, offset_samples, seg_samples)]
    part_totals: list[int] = []

    cur: list[tuple[str, int, int]] = []
    pos = LEAD_IN_SAMPLES
    for zh in lesson["zh_list"]:
        seg_samples = len(seg_pcm[zh]) // 2
        if cur and pos + seg_samples > part_max_samples:
            parts.append(cur)
            part_totals.append(pos)
            cur = []
            pos = LEAD_IN_SAMPLES
        cur.append((zh, pos, seg_samples))
        pos += seg_samples + SPACER_SAMPLES
    if cur:
        parts.append(cur)
        part_totals.append(pos)

    base = f"{lesson['id']}-{lesson['hash']}"
    files: list[str] = []
    items: dict[str, list[int]] = {}
    for idx, (segs, total_samples) in enumerate(zip(parts, part_totals)):
        raw = bytearray(total_samples * 2)  # 全靜音底，段落覆寫上去
        for zh, offset, seg_samples in segs:
            raw[offset * 2:(offset + seg_samples) * 2] = seg_pcm[zh]
            items[zh] = [
                idx,
                round(offset * 1000 / SAMPLE_RATE),
                round(seg_samples * 1000 / SAMPLE_RATE),
            ]
        rel = f"{AUDIO_PREFIX}/{base}-p{idx}.mp3"
        encode_part(ffmpeg, bytes(raw), out_dir / rel)
        files.append(rel)

    timing = {"files": files, "items": items}
    timing_rel = f"{AUDIO_PREFIX}/{base}.json"
    timing_path = out_dir / timing_rel
    timing_path.parent.mkdir(parents=True, exist_ok=True)
    timing_path.write_text(json.dumps(timing, ensure_ascii=False, separators=(",", ":")) + "\n",
                           encoding="utf-8")
    return {"hash": lesson["hash"], "timing": timing_rel, "files": files,
            "segments": len(lesson["zh_list"]), "chars": lesson["chars"]}


def cleanup_orphans(out_dir: Path, lesson_id: str, keep_hash: str) -> int:
    """清掉同堂舊 hash 的 sprite 檔。"""
    audio_dir = out_dir / AUDIO_PREFIX
    if not audio_dir.is_dir():
        return 0
    removed = 0
    prefix = f"{lesson_id}-"
    keep = f"{lesson_id}-{keep_hash}"
    for f in audio_dir.iterdir():
        if f.name.startswith(prefix) and not f.name.startswith(keep):
            f.unlink()
            removed += 1
    return removed


def plan(lessons: list[dict], zh_manifest: dict, out_dir: Path, cache_dir: Path) -> dict:
    stale = []
    for lesson in lessons:
        entry = zh_manifest["lessons"].get(lesson["id"])
        if lesson_is_current(entry, lesson, out_dir):
            continue
        uncached = [z for z in lesson["zh_list"] if not (cache_dir / f"{seg_cache_key(z)}.mp3").is_file()]
        stale.append({**lesson, "uncached": uncached,
                      "uncached_chars": sum(len(z) for z in uncached)})
    api_chars = sum(l["uncached_chars"] for l in stale)
    return {
        "lessons_total": len(lessons),
        "lessons_up_to_date": len(lessons) - len(stale),
        "lessons_stale": len(stale),
        "segments_total": sum(l["segments"] if "segments" in l else len(l["zh_list"]) for l in lessons),
        "segments_to_synthesize": sum(len(l["uncached"]) for l in stale),
        "api_chars": api_chars,
        "estimated_usd": api_chars / 1_000_000 * USD_PER_1M_CHARS,
        "stale": stale,
    }


def print_dry_run(report: dict) -> None:
    print("GCP zh sprite dry-run")
    print("=" * 28)
    print(f"Voice: {VOICE} ({BITRATE}, {SAMPLE_RATE}Hz mono, part<= {PART_MAX_SEC}s)")
    print(f"Lessons: {report['lessons_total']:,} total / {report['lessons_up_to_date']:,} up-to-date / {report['lessons_stale']:,} stale")
    print(f"Segments in data: {report['segments_total']:,}")
    print(f"Segments needing GCP calls (not in seg cache): {report['segments_to_synthesize']:,}")
    print(f"API chars: {report['api_chars']:,}")
    print(f"Estimated cost: US${report['estimated_usd']:,.2f} (WaveNet US$16/1M chars)")
    if report["stale"]:
        print()
        print("Stale lessons:")
        for l in report["stale"][:50]:
            print(f"- {l['id']} ({l['title']}): {len(l['zh_list'])} segs, {len(l['uncached'])} uncached")
        if len(report["stale"]) > 50:
            print(f"  ... and {len(report['stale']) - 50} more")
    print()
    print("Safety: dry-run made no API calls and wrote no files.")


def generate(report: dict, zh_manifest: dict, manifest_path: Path, out_dir: Path,
             cache_dir: Path, args: argparse.Namespace) -> int:
    if not args.confirm_paid_api:
        print("ERROR: --generate requires --confirm-paid-api.", file=sys.stderr)
        return 2
    if args.max_chars is None:
        print("ERROR: --generate requires --max-chars to cap paid API usage.", file=sys.stderr)
        return 2
    if report["api_chars"] > args.max_chars:
        print(f"ERROR: needs {report['api_chars']:,} API chars > --max-chars {args.max_chars:,}.",
              file=sys.stderr)
        return 2
    if not report["stale"]:
        print("All lessons up to date; nothing to do.")
        return 0

    ffmpeg = require_ffmpeg()
    api_key = None
    if report["segments_to_synthesize"]:
        api_key = resolve_api_key()
        if not api_key:
            print(f"ERROR: GCP_TTS_KEY not in env and Keychain service '{KEYCHAIN_SERVICE}' not found.",
                  file=sys.stderr)
            return 2

    cache_dir.mkdir(parents=True, exist_ok=True)
    total = len(report["stale"])
    for n, lesson in enumerate(report["stale"], start=1):
        print(f"[{n}/{total}] {lesson['id']} ({lesson['title']}): {len(lesson['zh_list'])} segs, "
              f"{len(lesson['uncached'])} GCP calls")
        seg_pcm: dict[str, bytes] = {}
        for zh in lesson["zh_list"]:
            seg_path = cache_dir / f"{seg_cache_key(zh)}.mp3"
            if not seg_path.is_file():
                audio = call_gcp_tts(zh, api_key)
                tmp = seg_path.with_suffix(".mp3.tmp")
                tmp.write_bytes(audio)
                tmp.replace(seg_path)
            seg_pcm[zh] = decode_to_pcm(ffmpeg, seg_path)

        entry = build_lesson_sprite(ffmpeg, lesson, seg_pcm, out_dir)
        removed = cleanup_orphans(out_dir, lesson["id"], lesson["hash"])
        if removed:
            print(f"  removed {removed} stale sprite files")
        zh_manifest["lessons"][lesson["id"]] = entry
        zh_manifest["generated_at"] = now_taipei_iso()
        manifest_path.write_text(
            json.dumps(zh_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        sizes = [os.path.getsize(out_dir / f) for f in entry["files"]]
        print(f"  -> {len(entry['files'])} part(s), {sum(sizes) / 1e6:.1f} MB")

    print(f"Updated zh manifest: {manifest_path}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bake per-lesson Chinese sprite audio via GCP TTS.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Report stale lessons and cost.")
    mode.add_argument("--generate", action="store_true", help="Bake stale lesson sprites.")
    parser.add_argument("--data", default="data.json", type=Path)
    parser.add_argument("--out-dir", default=Path("out/site-preview"), type=Path)
    parser.add_argument("--cache-dir", default=Path("out/zh-cache"), type=Path,
                        help="Per-segment GCP MP3 cache (not deployed).")
    parser.add_argument("--max-chars", type=int, help="Cap on paid GCP chars for this run.")
    parser.add_argument("--confirm-paid-api", action="store_true")
    parser.add_argument("--json", action="store_true", help="Machine-readable dry-run summary.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.dry_run and not args.generate:
        print("ERROR: choose --dry-run or --generate.", file=sys.stderr)
        return 2

    data = load_data(args.data)
    lessons = collect_lessons(data)
    manifest_path = args.out_dir / "zh-manifest.json"
    zh_manifest = load_zh_manifest(manifest_path)
    report = plan(lessons, zh_manifest, args.out_dir, args.cache_dir)

    if args.dry_run:
        if args.json:
            summary = {k: v for k, v in report.items() if k != "stale"}
            summary["stale_lesson_ids"] = [l["id"] for l in report["stale"]]
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        else:
            print_dry_run(report)
        return 0
    return generate(report, zh_manifest, manifest_path, args.out_dir, args.cache_dir, args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
