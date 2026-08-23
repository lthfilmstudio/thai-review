#!/usr/bin/env python3
"""Build read-only stable-card-ID proposals from a local catalog snapshot.

This command never contacts or writes Google Sheets.  It reads a local
``data.json`` snapshot and emits a deterministic manifest that can be reviewed
before a separately approved Sheet mutation.  The proposed IDs are UUIDv5
values derived from the published spreadsheet identity, lesson gid, canonical
content fingerprint, and the occurrence rank of identical content.  A local
catalog cannot prove a Google Sheet row binding, so this output is never a
write payload and must be checked against a live Sheet before mutation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any


DEFAULT_DATA_PATH = Path("data.json")
REPORT_TYPE = "stable-card-id-backfill-dry-run"
SCHEMA_VERSION = 2
CARD_FIELDS = (
    "thai",
    "karaoke",
    "zh",
    "type",
    "note",
    "audio_url",
    "lesson",
    "start_ms",
    "end_ms",
)
PUBLISHED_SHEET_RE = re.compile(r"/d/(?:e/)?([A-Za-z0-9_-]{20,})")
CANONICAL_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def load_data(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"找不到 data.json：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"data.json 不是有效 JSON：{path} ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("lessons"), list):
        raise ValueError("data.json 缺少 lessons 陣列")
    return data


def spreadsheet_id(source_url: str) -> str:
    match = PUBLISHED_SHEET_RE.search(str(source_url or ""))
    if match:
        return match.group(1)
    # A fixture may intentionally omit a Google URL.  Keep the namespace
    # deterministic without pretending that an unknown source was verified.
    return "unknown-source-" + hashlib.sha256(
        str(source_url or "").encode("utf-8")
    ).hexdigest()[:16]


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def legacy_alias(lesson_id: str, card: dict[str, Any]) -> str:
    source_thai = _text(card.get("_sourceThai") or card.get("thai"))
    return f"{lesson_id}:{source_thai}"


def content_fingerprint(card: dict[str, Any]) -> str:
    payload = {
        field: _text(card.get(field)) if field not in {"start_ms", "end_ms"}
        else card.get(field)
        for field in CARD_FIELDS
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def is_uuid(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    return bool(CANONICAL_UUID_RE.fullmatch(value.strip()))


def proposed_card_id(sheet_id: str, gid: str, fingerprint: str, occurrence_rank: int) -> str:
    namespace = uuid.uuid5(uuid.NAMESPACE_URL, "https://thai-review.lthfilmstudio.com/card")
    source_key = f"{sheet_id}|{gid}|{fingerprint}|{occurrence_rank}"
    return str(uuid.uuid5(namespace, source_key))


def _load_learning_map(snapshot: dict[str, Any], *names: str) -> dict[str, Any]:
    for name in names:
        value = snapshot.get(name)
        if isinstance(value, dict):
            if isinstance(value.get("cards"), dict):
                return value["cards"]
            return value
    return {}


def _nonempty(value: Any) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, (dict, list, tuple, set)):
        return bool(value)
    return True


def learning_intersections(
    collision_groups: dict[str, dict[str, Any]],
    learning_snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    if learning_snapshot is None:
        return {
            "learning_snapshot_status": "not_provided",
            "collision_alias_count": len(collision_groups),
            "collision_aliases_with_nonempty_srs_count": None,
            "collision_aliases_with_nonempty_srs_ratio": None,
            "collision_aliases_with_nonempty_grade_history_count": None,
            "collision_aliases_with_nonempty_grade_history_ratio": None,
            "collision_aliases_with_any_learning_count": None,
            "collision_aliases_with_any_learning_ratio": None,
            "details": [],
        }
    progress = _load_learning_map(learning_snapshot, "progress", "srs")
    history = _load_learning_map(learning_snapshot, "grade_history", "gradeHistory", "history")
    details = []
    srs_count = 0
    history_count = 0
    any_learning_count = 0
    for alias, group in sorted(collision_groups.items()):
        srs_value = progress.get(alias)
        history_value = history.get(alias)
        has_srs = _nonempty(srs_value)
        has_history = _nonempty(history_value)
        if has_srs:
            srs_count += 1
        if has_history:
            history_count += 1
        if has_srs or has_history:
            any_learning_count += 1
        details.append({
            "legacy_alias": alias,
            "collision_group": group["collision_group"],
            "collision_size": group["collision_size"],
            "nonempty_srs": has_srs,
            "nonempty_grade_history": has_history,
            "grade_history_item_count": len(history_value) if isinstance(history_value, list) else 0,
        })
    total = len(collision_groups)
    return {
        "learning_snapshot_status": "provided",
        "collision_alias_count": total,
        "collision_aliases_with_nonempty_srs_count": srs_count,
        "collision_aliases_with_nonempty_srs_ratio": srs_count / total if total else 0,
        "collision_aliases_with_nonempty_grade_history_count": history_count,
        "collision_aliases_with_nonempty_grade_history_ratio": history_count / total if total else 0,
        "collision_aliases_with_any_learning_count": any_learning_count,
        "collision_aliases_with_any_learning_ratio": any_learning_count / total if total else 0,
        "details": details,
    }


def build_dry_run(
    data: dict[str, Any],
    learning_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_url = _text(data.get("source_url"))
    sheet_id = spreadsheet_id(source_url)
    rows: list[dict[str, Any]] = []
    aliases: defaultdict[str, list[int]] = defaultdict(list)
    seen_existing: defaultdict[str, list[int]] = defaultdict(list)
    fingerprint_occurrences: defaultdict[tuple[str, str], int] = defaultdict(int)
    fingerprint_totals: defaultdict[tuple[str, str], int] = defaultdict(int)

    for lesson in data["lessons"]:
        if not isinstance(lesson, dict):
            raise ValueError("lesson 必須是物件")
        lesson_id = _text(lesson.get("id"))
        gid = _text(lesson.get("gid")) or lesson_id
        cards = lesson.get("cards")
        if not lesson_id or not isinstance(cards, list):
            raise ValueError("lesson 必須有 id 與 cards 陣列")
        for index, card in enumerate(cards, start=1):
            if not isinstance(card, dict):
                raise ValueError(f"{lesson_id} 第 {index} 張卡不是物件")
            alias = legacy_alias(lesson_id, card)
            existing = _text(card.get("card_id") or card.get("cardId"))
            valid_existing = is_uuid(existing)
            canonical_existing = existing.lower() if valid_existing else None
            fingerprint = content_fingerprint(card)
            fingerprint_totals[(gid, fingerprint)] += 1
            fingerprint_occurrences[(gid, fingerprint)] += 1
            occurrence_rank = fingerprint_occurrences[(gid, fingerprint)]
            generated_candidate = proposed_card_id(sheet_id, gid, fingerprint, occurrence_rank)
            proposed = canonical_existing if valid_existing else generated_candidate
            row = {
                "old_card_id": existing or None,
                "proposed_card_id": proposed,
                "proposal_action": "preserve_existing" if valid_existing else "add_proposed",
                "lesson_id": lesson_id,
                "gid": gid,
                "catalog_ordinal": index,
                "legacy_alias": alias,
                "content_fingerprint": fingerprint,
                "binding_status": "unverified_local_snapshot",
            }
            if existing and not is_uuid(existing):
                row["invalid_existing_card_id"] = existing
            row_index = len(rows)
            rows.append(row)
            aliases[alias].append(row_index)
            if valid_existing:
                seen_existing[canonical_existing].append(row_index)

    collision_groups: dict[str, dict[str, Any]] = {}
    for alias, indexes in aliases.items():
        if len(indexes) > 1:
            group_id = "legacy-collision-" + hashlib.sha256(alias.encode("utf-8")).hexdigest()[:16]
            collision_groups[alias] = {
                "collision_group": group_id,
                "collision_size": len(indexes),
            }
            for index in indexes:
                rows[index].update(collision_groups[alias])
    for row in rows:
        row.setdefault("collision_group", None)
        row.setdefault("collision_size", 1)

    live_binding_required = 0
    for row in rows:
        fingerprint_count = fingerprint_totals[(row["gid"], row["content_fingerprint"])]
        row["proposal_binding_status"] = (
            "requires_live_binding" if fingerprint_count > 1 else "content_deterministic"
        )
        if fingerprint_count > 1:
            live_binding_required += 1

    duplicate_card_ids = {
        card_id: indexes for card_id, indexes in seen_existing.items() if len(indexes) > 1
    }
    for card_id, indexes in duplicate_card_ids.items():
        for index in indexes:
            rows[index].update({
                "proposal_action": "quarantine",
                "proposal_binding_status": "quarantine_duplicate_stable_card_id",
                "quarantine_reason": "duplicate_stable_card_id",
            })
    proposed_ids = [row["proposed_card_id"] for row in rows]
    learning = learning_intersections(collision_groups, learning_snapshot)
    summary = {
        "lesson_count": len(data["lessons"]),
        "card_count": len(rows),
        "unique_card_id_count": len(set(proposed_ids)),
        "collision_group_count": len(collision_groups),
        "collision_card_count": sum(
            len(indexes) for indexes in aliases.values() if len(indexes) > 1
        ),
        "existing_card_id_count": sum(row["old_card_id"] is not None and is_uuid(row["old_card_id"]) for row in rows),
        "invalid_existing_card_id_count": sum("invalid_existing_card_id" in row for row in rows),
        "duplicate_existing_card_id_count": sum(len(indexes) for indexes in duplicate_card_ids.values()),
        "live_binding_required_count": live_binding_required,
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "report_type": REPORT_TYPE,
        "source": {
            "source_url": source_url,
            "spreadsheet_id": sheet_id,
        },
        "catalog": {
            "generated_at": data.get("generated_at"),
        },
        "binding_status": "unverified_local_snapshot",
        "write_guard": "cannot_write_sheet_without_live_binding",
        "learning_snapshot_status": learning["learning_snapshot_status"],
        "learning_snapshot": learning,
        "summary": summary,
        "proposals": rows,
    }


def serialize_report(report: dict[str, Any]) -> bytes:
    return (
        json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def write_report(report: dict[str, Any], path: Path) -> None:
    path.write_bytes(serialize_report(report))


def load_learning_snapshot(path: Path) -> dict[str, Any]:
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"找不到 learning snapshot：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"learning snapshot 不是有效 JSON：{path} ({exc})") from exc
    if not isinstance(snapshot, dict):
        raise ValueError("learning snapshot 必須是物件")
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA_PATH)
    parser.add_argument("--learning-snapshot", type=Path)
    parser.add_argument("--out", type=Path, help="寫入本機 manifest JSON；省略則輸出 stdout")
    args = parser.parse_args(argv)

    try:
        learning_snapshot = (
            load_learning_snapshot(args.learning_snapshot)
            if args.learning_snapshot else None
        )
        report = build_dry_run(load_data(args.data), learning_snapshot)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.out:
        write_report(report, args.out)
    else:
        sys.stdout.buffer.write(serialize_report(report))
    summary = report["summary"]
    print(
        "dry-run: "
        f"{summary['card_count']} cards, "
        f"{summary['collision_group_count']} collision groups, "
        f"{summary['unique_card_id_count']} unique proposed IDs",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
