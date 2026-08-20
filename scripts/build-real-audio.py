#!/usr/bin/env python3
"""
build-real-audio.py - pilot: clip real teacher speech out of a class recording
for one lesson's "聽真人" card-back button, using ElevenLabs Scribe word/speaker
timestamps (out/class-transcriptions/<job>/scribe/*.json).

Local-only processing (ffmpeg on the already-extracted mono class MP3s used for
Scribe). No paid API calls.

Scope is intentionally locked to a single lesson per run - there is no --all.
See docs/plans/2026-08-20-real-teacher-audio-pilot-plan.md for the full design.

Output per lesson (under --out-dir, matches the zh-sprite layout):
  audio/real-tw/{lessonId}-{hash8}-p{n}.mp3   sprite parts (<= PART_MAX_SEC each)
  audio/real-tw/{lessonId}-{hash8}.json       {"files":[...], "items":{thai:[fileIdx,startMs,durMs]}}
Plus a root real-manifest.json: {"lessons":{lessonId:{"hash","timing"}}}.

Plus a throwaway QA page (always under out/real-audio-qa/, never under
--out-dir, so it can never accidentally ship): one small mp3 per matched card
with an inline player, for a human to actually listen before this goes live.

Usage:
  python3 scripts/build-real-audio.py --job 260814 --lesson "中 2-4"
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import html
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SAMPLE_RATE = 24000
BITRATE = "48k"
LEAD_IN_MS = 60
SPACER_MS = 120
PART_MAX_SEC = 240
AUDIO_PREFIX = "audio/real-tw"
DEFAULT_START_PAD_MS = 120
DEFAULT_END_PAD_MS = 150
TAIPEI = ZoneInfo("Asia/Taipei")

LEAD_IN_SAMPLES = SAMPLE_RATE * LEAD_IN_MS // 1000
SPACER_SAMPLES = SAMPLE_RATE * SPACER_MS // 1000


def now_taipei_iso() -> str:
    return datetime.now(TAIPEI).isoformat(timespec="seconds")


def require_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise SystemExit("ffmpeg not found in PATH")
    return path


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"not valid JSON: {path} ({exc})")


def load_job_parts(job_id: str, job_root: Path) -> list[dict]:
    """讀 job.json 的 segments，回傳依 index 排序的 [{index, scribe_path, mp3_path}]。
    直接讀 job.json 記錄的實際路徑，不猜檔名慣例。"""
    job_path = job_root / job_id / "job.json"
    job = load_json(job_path)
    parts = []
    for seg in job.get("segments") or []:
        scribe_path = seg.get("scribe_path")
        mp3_path = (seg.get("mp3") or {}).get("path")
        if not scribe_path or not mp3_path:
            continue
        parts.append({
            "index": seg["index"],
            "scribe_path": Path(scribe_path),
            "mp3_path": Path(mp3_path),
        })
    if not parts:
        raise SystemExit(f"no usable segments in job.json: {job_path}")
    parts.sort(key=lambda p: p["index"])
    return parts


def find_lesson(data: dict, lesson_title: str) -> dict:
    for lesson in data.get("lessons") or []:
        if lesson.get("title") == lesson_title:
            return lesson
    raise SystemExit(f"lesson not found in data.json: {lesson_title!r}")


# ---- 純比對邏輯（可獨立測試，不碰 ffmpeg / 檔案）----

def build_speaker_index(words: list[dict]) -> tuple[dict[str, dict], dict[str, float]]:
    """依 speaker_id 分組，拼接 word token 文字（跳過 spacing），
    回傳 {speaker_id: {"text":..., "map":[(char_pos, token)]}} 與各講者總發言秒數。"""
    per_speaker: dict[str, dict] = {}
    durations: dict[str, float] = {}
    for w in words:
        if w.get("type") != "word":
            continue
        sid = w["speaker_id"]
        entry = per_speaker.setdefault(sid, {"text": "", "map": []})
        entry["map"].append((len(entry["text"]), w))
        entry["text"] += w["text"]
        durations[sid] = durations.get(sid, 0.0) + max(0.0, w["end"] - w["start"])
    return per_speaker, durations


def pick_teacher(durations: dict[str, float]) -> str | None:
    """總發言時長最長的講者當老師；不是 token 數，抵抗切字粒度不一致。"""
    if not durations:
        return None
    return max(durations, key=durations.get)


def find_match(entry: dict, text: str) -> tuple[float, float, int] | None:
    """在講者拼接字串裡找 text，只接受**對齊 token 邊界**的出現（起點是某個 token
    的開頭、終點是某個 token 的結尾），跳過切在 token 中間的假命中——Scribe 的
    token 切法不穩定（有時整詞、有時單字），字串子串比對容易咬到不相關長詞
    中間剛好同形的片段，那種命中播出來的音檔會跟卡片文字對不上。
    回傳第一個對齊的出現，occurrences 只計對齊的次數（給 QA 頁「多重命中」用，
    不算進不對齊而被跳過的假命中）。"""
    starts_valid = {char_pos for char_pos, _ in entry["map"]}
    ends_valid = {char_pos + len(tok["text"]) for char_pos, tok in entry["map"]}

    first: tuple[float, float] | None = None
    occurrences = 0
    search_from = 0
    while True:
        idx = entry["text"].find(text, search_from)
        if idx == -1:
            break
        search_from = idx + 1
        target_end = idx + len(text)
        if idx not in starts_valid or target_end not in ends_valid:
            continue
        starts, ends = [], []
        for char_pos, tok in entry["map"]:
            tok_end = char_pos + len(tok["text"])
            if tok_end <= idx or char_pos >= target_end:
                continue
            starts.append(tok["start"])
            ends.append(tok["end"])
        if not starts:
            continue
        occurrences += 1
        if first is None:
            first = (min(starts), max(ends))
    if first is None:
        return None
    return first[0], first[1], occurrences


def build_timeline(words: list[dict]) -> tuple[list[dict], list[float]]:
    """全部講者（不分老師/學生）依開始時間排序的 token 清單，給 padding clamp 用。"""
    toks = sorted((w for w in words if w.get("type") == "word"), key=lambda w: w["start"])
    return toks, [w["start"] for w in toks]


def gap_before(toks: list[dict], starts: list[float], match_start: float) -> float:
    """match_start 之前、最近一個「結束時間 <= match_start」的 token 到 match_start 的間隔。"""
    i = bisect.bisect_left(starts, match_start)
    for w in reversed(toks[:i]):
        if w["end"] <= match_start:
            return max(0.0, match_start - w["end"])
    return 999.0  # 前面沒有任何字，不設限（padding 直接吃到滿）


def gap_after(toks: list[dict], starts: list[float], match_end: float) -> float:
    """match_end 之後、最近一個「開始時間 >= match_end」的 token 到 match_end 的間隔。"""
    i = bisect.bisect_right(starts, match_end)
    for w in toks[i:]:
        if w["start"] >= match_end:
            return max(0.0, w["start"] - match_end)
    return 999.0


def padded_range(toks: list[dict], starts: list[float], match_start: float, match_end: float,
                  start_pad_ms: int, end_pad_ms: int) -> tuple[float, float]:
    pad_start = min(start_pad_ms / 1000, gap_before(toks, starts, match_start))
    pad_end = min(end_pad_ms / 1000, gap_after(toks, starts, match_end))
    return max(0.0, match_start - pad_start), match_end + pad_end


# 老師發言的拼接語料本來就不含空白（spacing token 建語料時就跳過了，見
# build_speaker_index），卡片文字裡的空白／句點只是 Sheet 排版習慣，不代表老師
# 講話真的停頓，所以拿掉這些字元去比對是修正語料落差、不是模糊比對。
# 禮貌尾詞則是真的文字差異（卡片為了標註男女性禮貌語氣而加，老師課堂上不一定
# 每次都講），當作明確第二輪嘗試，並在結果標記 variant 讓 QA 頁特別提示複查。
_STRIP_CHARS = " ​.。"
TRAILING_PARTICLES = ["ค่ะ", "ครับ", "นะคะ", "นะครับ", "นะ", "จ้ะ", "จ๊ะ"]


def match_variants(thai: str) -> list[tuple[str, str]]:
    """回傳依序嘗試的 (variant_text, label)。同一個 label 不重複產生。"""
    variants: list[tuple[str, str]] = [(thai, "exact")]
    normalized = "".join(ch for ch in thai if ch not in _STRIP_CHARS)
    if normalized and normalized != thai:
        variants.append((normalized, "normalized"))
    base = normalized or thai
    for particle in TRAILING_PARTICLES:
        if base.endswith(particle) and len(base) > len(particle):
            trimmed = base[: -len(particle)]
            variants.append((trimmed, f"particle-trimmed（去掉尾詞「{particle}」）"))
    return variants


def match_lesson_cards(lesson: dict, parts_words: list[list[dict]],
                        start_pad_ms: int, end_pad_ms: int) -> dict:
    """對每張卡在各 part 依序試比對（含正規化／禮貌尾詞第二輪嘗試），
    回傳 hits / misses。parts_words[i] 是第 i 個 part（依 job.json segments 順序）
    的 words 陣列。"""
    per_part = []
    for words in parts_words:
        per_speaker, durations = build_speaker_index(words)
        teacher_id = pick_teacher(durations)
        toks, starts = build_timeline(words)
        per_part.append({
            "teacher_id": teacher_id,
            "entry": per_speaker.get(teacher_id, {"text": "", "map": []}),
            "toks": toks,
            "starts": starts,
        })

    hits: list[dict] = []
    misses: list[dict] = []
    for card in lesson.get("cards") or []:
        thai = str(card.get("thai") or "").strip()
        if not thai:
            continue
        found = None
        for variant_text, label in match_variants(thai):
            if found:
                break
            for part_idx, part in enumerate(per_part):
                m = find_match(part["entry"], variant_text)
                if m:
                    start_sec, end_sec, occurrences = m
                    p_start, p_end = padded_range(part["toks"], part["starts"], start_sec, end_sec,
                                                   start_pad_ms, end_pad_ms)
                    found = {
                        "card": card,
                        "thai": thai,
                        "matched_text": variant_text,
                        "match_kind": label,
                        "part_index": part_idx,
                        "start_sec": p_start,
                        "end_sec": p_end,
                        "occurrences": occurrences,
                    }
                    break
        if found:
            hits.append(found)
        else:
            misses.append(card)
    return {"hits": hits, "misses": misses}


# ---- ffmpeg IO ----

def decode_to_pcm(ffmpeg: str, mp3_path: Path) -> bytes:
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


def slice_pcm(pcm: bytes, start_sec: float, end_sec: float) -> bytes:
    offset = max(0, round(start_sec * SAMPLE_RATE)) * 2
    end = max(offset, round(end_sec * SAMPLE_RATE) * 2)
    return pcm[offset:min(end, len(pcm))]


def lesson_hash(lesson_id: str, job_id: str, hit_keys: list[str], start_pad_ms: int, end_pad_ms: int) -> str:
    payload = json.dumps(
        [lesson_id, job_id, SAMPLE_RATE, BITRATE, start_pad_ms, end_pad_ms, *hit_keys],
        ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]


def build_sprite(ffmpeg: str, lesson_id: str, hash8: str, hits: list[dict],
                  part_pcm: dict[int, bytes], out_dir: Path) -> dict:
    """依卡片原始順序把命中片段拼成 <=240s 的 part(s)，寫出 mp3 + timing json。"""
    part_max_samples = PART_MAX_SEC * SAMPLE_RATE
    sprite_parts: list[list[tuple[dict, int, int]]] = []
    totals: list[int] = []

    cur: list[tuple[dict, int, int]] = []
    pos = LEAD_IN_SAMPLES
    for hit in hits:
        clip = slice_pcm(part_pcm[hit["part_index"]], hit["start_sec"], hit["end_sec"])
        seg_samples = len(clip) // 2
        hit["_clip"] = clip
        if cur and pos + seg_samples > part_max_samples:
            sprite_parts.append(cur)
            totals.append(pos)
            cur = []
            pos = LEAD_IN_SAMPLES
        cur.append((hit, pos, seg_samples))
        pos += seg_samples + SPACER_SAMPLES
    if cur:
        sprite_parts.append(cur)
        totals.append(pos)

    base = f"{lesson_id}-{hash8}"
    files: list[str] = []
    items: dict[str, list[int]] = {}
    for idx, (segs, total_samples) in enumerate(zip(sprite_parts, totals)):
        raw = bytearray(total_samples * 2)
        for hit, offset, seg_samples in segs:
            raw[offset * 2:(offset + seg_samples) * 2] = hit["_clip"]
            items[hit["thai"]] = [idx, round(offset * 1000 / SAMPLE_RATE), round(seg_samples * 1000 / SAMPLE_RATE)]
        rel = f"{AUDIO_PREFIX}/{base}-p{idx}.mp3"
        encode_part(ffmpeg, bytes(raw), out_dir / rel)
        files.append(rel)

    timing = {"files": files, "items": items}
    timing_rel = f"{AUDIO_PREFIX}/{base}.json"
    timing_path = out_dir / timing_rel
    timing_path.parent.mkdir(parents=True, exist_ok=True)
    timing_path.write_text(json.dumps(timing, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"hash": hash8, "timing": timing_rel, "files": files, "segments": len(hits)}


def cleanup_orphans(out_dir: Path, lesson_id: str, keep_hash: str) -> int:
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


def write_manifest(manifest_path: Path, lesson_id: str, entry: dict) -> None:
    manifest = {"generated_at": now_taipei_iso(), "lessons": {}}
    if manifest_path.exists():
        try:
            manifest = load_json(manifest_path)
        except SystemExit:
            pass
    manifest.setdefault("lessons", {})
    manifest["lessons"][lesson_id] = {"hash": entry["hash"], "timing": entry["timing"]}
    manifest["generated_at"] = now_taipei_iso()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_qa_page(qa_dir: Path, lesson_title: str, ffmpeg: str, hits: list[dict],
                   misses: list[dict], part_pcm: dict[int, bytes]) -> Path:
    """丟即用的抽查頁：每張命中的卡各給一個獨立小 mp3，聽完即刪，不進部署。"""
    clips_dir = qa_dir / "clips"
    if clips_dir.exists():
        shutil.rmtree(clips_dir)
    clips_dir.mkdir(parents=True, exist_ok=True)

    # 非精確命中的排到最前面，方便集中複查；同一組內維持原卡片順序。
    ordered = sorted(hits, key=lambda h: 0 if h["match_kind"] != "exact" else 1)

    rows = []
    for n, hit in enumerate(ordered, start=1):
        clip = hit.get("_clip") or slice_pcm(part_pcm[hit["part_index"]], hit["start_sec"], hit["end_sec"])
        clip_name = f"{n:03d}.mp3"
        encode_part(ffmpeg, clip, clips_dir / clip_name)
        flags = []
        if hit["occurrences"] > 1:
            flags.append("⚠️ 多重命中")
        if hit["match_kind"] != "exact":
            flags.append(f'🔍 {hit["match_kind"]}（實際比對「{html.escape(hit["matched_text"])}」）')
        rows.append(
            f'<tr><td>{n}</td><td>{html.escape(hit["thai"])}</td>'
            f'<td>{html.escape(hit["card"].get("zh") or "")}</td>'
            f'<td>{hit["end_sec"] - hit["start_sec"]:.2f}s</td>'
            f'<td>{" ".join(flags)}</td>'
            f'<td><audio controls src="clips/{clip_name}"></audio></td></tr>'
        )

    miss_rows = "".join(
        f'<tr><td>{html.escape(c.get("thai") or "")}</td><td>{html.escape(c.get("zh") or "")}</td></tr>'
        for c in misses
    )

    page = f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>real-audio QA — {html.escape(lesson_title)}</title>
<style>
body{{font-family:sans-serif;margin:2rem;background:#111;color:#eee}}
table{{border-collapse:collapse;width:100%;margin-bottom:2rem}}
td,th{{border:1px solid #444;padding:6px 10px;text-align:left}}
h2{{margin-top:2rem}}
</style></head><body>
<h1>{html.escape(lesson_title)} 真人語音抽查（{len(hits)} 命中 / {len(misses)} 未命中）</h1>
<p>聽完即刪，這頁不進部署。⚠️ 標記的是同一句話在老師發言裡出現超過一次，取了第一次，特別注意聽這幾個切點對不對。</p>
<table><tr><th>#</th><th>泰文</th><th>中文</th><th>片段長</th><th></th><th>播放</th></tr>
{''.join(rows)}
</table>
<h2>未命中（維持 YouGlish）</h2>
<table><tr><th>泰文</th><th>中文</th></tr>{miss_rows}</table>
</body></html>"""
    out_path = qa_dir / "index.html"
    out_path.write_text(page, encoding="utf-8")
    return out_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job", required=True, help="class-transcriptions job id, e.g. 260814")
    parser.add_argument("--lesson", required=True, help="data.json lesson title, e.g. 中 2-4")
    parser.add_argument("--data", default=Path("data.json"), type=Path)
    parser.add_argument("--job-root", default=Path("out/class-transcriptions"), type=Path)
    parser.add_argument("--out-dir", default=Path("out/site-preview"), type=Path)
    parser.add_argument("--qa-dir", default=Path("out/real-audio-qa"), type=Path)
    parser.add_argument("--start-pad-ms", default=DEFAULT_START_PAD_MS, type=int)
    parser.add_argument("--end-pad-ms", default=DEFAULT_END_PAD_MS, type=int)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    ffmpeg = require_ffmpeg()

    data = load_json(args.data)
    lesson = find_lesson(data, args.lesson)
    lesson_id = lesson["id"]

    parts = load_job_parts(args.job, args.job_root)
    parts_words = [load_json(p["scribe_path"])["words"] for p in parts]

    result = match_lesson_cards(lesson, parts_words, args.start_pad_ms, args.end_pad_ms)
    hits, misses = result["hits"], result["misses"]
    total = len(hits) + len(misses)
    multi = [h for h in hits if h["occurrences"] > 1]
    non_exact = [h for h in hits if h["match_kind"] != "exact"]

    print(f"[build-real-audio] {args.lesson}: {len(hits)}/{total} matched "
          f"({len(hits) - len(non_exact)} exact, {len(non_exact)} via normalized/particle-trimmed retry, "
          f"{len(multi)} multi-occurrence), {len(misses)} unmatched (fallback YouGlish)")

    if not hits:
        print("no hits; nothing to build.")
        return 0

    hit_keys = [f"{h['thai']}|{h['part_index']}|{h['start_sec']:.3f}|{h['end_sec']:.3f}" for h in hits]
    hash8 = lesson_hash(lesson_id, args.job, hit_keys, args.start_pad_ms, args.end_pad_ms)

    print("decoding source audio...")
    part_pcm = {i: decode_to_pcm(ffmpeg, p["mp3_path"]) for i, p in enumerate(parts)
                if i in {h["part_index"] for h in hits}}

    entry = build_sprite(ffmpeg, lesson_id, hash8, hits, part_pcm, args.out_dir)
    removed = cleanup_orphans(args.out_dir, lesson_id, hash8)
    if removed:
        print(f"removed {removed} stale sprite file(s) from a previous run")
    manifest_path = args.out_dir / "real-manifest.json"
    write_manifest(manifest_path, lesson_id, entry)
    sizes = [(args.out_dir / f).stat().st_size for f in entry["files"]]
    print(f"-> {len(entry['files'])} part(s), {sum(sizes) / 1e6:.1f} MB, manifest: {manifest_path}")

    qa_path = write_qa_page(args.qa_dir, args.lesson, ffmpeg, hits, misses, part_pcm)
    print(f"QA page: {qa_path}  (open in a browser and actually listen before wiring this into the app)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
