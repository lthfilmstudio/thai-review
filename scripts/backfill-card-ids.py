#!/usr/bin/env python3
"""Build read-only stable-card-ID proposals from a local or live snapshot.

The default mode never contacts Google Sheets.  ``--live`` performs only
metadata and values reads through the Google Sheets API, then emits a
deterministic manifest that can be reviewed before a separately approved Sheet
mutation.  The proposed IDs are UUIDv5
values derived from the canonical editable spreadsheet identity, lesson gid, canonical
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
LIVE_REPORT_TYPE = "stable-card-id-backfill-live-verified"
LIVE_SCHEMA_VERSION = 3
DEFAULT_EDITABLE_SPREADSHEET_ID = "11yWETpjSLs6B3w1y9LMI2DK5Rn0waUBbAqazenn2xFs"
CANONICAL_SPREADSHEET_ID = DEFAULT_EDITABLE_SPREADSHEET_ID
DEFAULT_SERVICE_ACCOUNT_PATH = Path("/Users/lth/.config/thai-review/sheets-service-account.json")
LESSON_HEADERS = (
    ("中文", "泰文", "目的達拼音"),
    ("中文", "泰文", "目的達拼音", "start_ms", "end_ms"),
)
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


def canonical_spreadsheet_id(
    data: dict[str, Any], explicit_id: str | None = None,
) -> str:
    """Return the explicit identity used for UUID proposals in every mode."""
    return (
        _text(explicit_id)
        or _text(data.get("canonical_spreadsheet_id"))
        or CANONICAL_SPREADSHEET_ID
    )


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
    *,
    spreadsheet_id_value: str | None = None,
) -> dict[str, Any]:
    source_url = _text(data.get("source_url"))
    sheet_id = canonical_spreadsheet_id(data, spreadsheet_id_value)
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
            "canonical_spreadsheet_id": sheet_id,
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


def _row_values(row: Any, width: int = 6) -> list[Any]:
    if not isinstance(row, list):
        return [""] * width
    return list(row[:width]) + [""] * max(0, width - len(row))


def _live_card_from_row(row: list[Any], header: tuple[str, ...]) -> dict[str, Any]:
    values = _row_values(row)
    card = {
        "thai": _text(values[1]),
        "karaoke": _text(values[2]),
        "zh": _text(values[0]),
        "type": "word",
        "note": "",
        "audio_url": "",
        "lesson": "",
    }
    if len(header) == 5:
        card["start_ms"] = _live_ms(values[3])
        card["end_ms"] = _live_ms(values[4])
    return card


def _live_ms(value: Any) -> int | float | None:
    if value is None or _text(value) == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        # Match sync-sheet.py: non-numeric timing annotations are ignored by
        # the catalog parser, while A:E raw values remain in the manifest.
        return None
    if number < 0:
        return None
    return int(number) if number == int(number) else number


def _live_content_matches(local: dict[str, Any], live: dict[str, Any]) -> bool:
    normalized = dict(local)
    for field, default in {
        "type": "word", "note": "", "audio_url": "", "lesson": "",
        "start_ms": None, "end_ms": None,
    }.items():
        normalized.setdefault(field, default)
    return content_fingerprint(normalized) == content_fingerprint(live)


def build_verified_manifest(
    data: dict[str, Any],
    snapshot: dict[str, Any],
    *,
    published_source_url: str | None = None,
    canonical_id: str | None = None,
) -> dict[str, Any]:
    """Compare an editable read-only snapshot to data.json and bind by row.

    ``snapshot`` is deliberately a small API-shaped value object, making all
    mutation-preparation logic testable without Google credentials.  Every
    non-empty card row is matched in catalog order; physical row numbers are
    retained so blank rows cannot shift a future write target.
    """
    source_url = _text(data.get("source_url"))
    if published_source_url is not None and _text(published_source_url) != source_url:
        raise ValueError("published source URL 與 data.json 不一致")
    live_id = _text(snapshot.get("spreadsheet_id"))
    if not live_id:
        raise ValueError("live snapshot 缺少 spreadsheet_id")
    proposal_namespace = canonical_spreadsheet_id(data, canonical_id)
    lessons = data.get("lessons")
    live_lessons = snapshot.get("sheets")
    if not isinstance(lessons, list) or not isinstance(live_lessons, list):
        raise ValueError("live snapshot 缺少 sheets")
    if len(lessons) != len(live_lessons):
        raise ValueError(f"lesson tab 數量不一致：local={len(lessons)} live={len(live_lessons)}")

    proposals: list[dict[str, Any]] = []
    seen_ids: dict[str, int] = {}
    occurrence: defaultdict[tuple[str, str], int] = defaultdict(int)
    total_cards = 0
    for lesson_index, (lesson, live_sheet) in enumerate(zip(lessons, live_lessons)):
        if not isinstance(lesson, dict) or not isinstance(live_sheet, dict):
            raise ValueError("lesson 或 live sheet 不是物件")
        expected_gid = _text(lesson.get("gid"))
        expected_title = _text(lesson.get("title"))
        live_gid = _text(live_sheet.get("gid") or live_sheet.get("sheetId"))
        live_title = _text(live_sheet.get("title"))
        if live_gid != expected_gid or live_title != expected_title:
            raise ValueError(
                f"第 {lesson_index + 1} 個 lesson tab identity drift："
                f"expected={expected_title}/{expected_gid} live={live_title}/{live_gid}"
            )
        if int(live_sheet.get("order", lesson_index)) != lesson_index:
            raise ValueError(f"{expected_title} tab order drift")
        values = live_sheet.get("values")
        if not isinstance(values, list) or not values:
            raise ValueError(f"{expected_title} 缺少 A:F values/header")
        raw_header_values = [_text(value) for value in _row_values(values[0])[:5]]
        while raw_header_values and not raw_header_values[-1]:
            raw_header_values.pop()
        raw_header = tuple(raw_header_values)
        if raw_header not in LESSON_HEADERS:
            raise ValueError(f"{expected_title} header drift：{raw_header!r}")
        f_header = _text(_row_values(values[0])[5]).lower()
        if f_header not in {"", "card_id", "card id", "卡片 id", "卡片id"}:
            raise ValueError(f"{expected_title} F header drift：{f_header!r}")
        header = raw_header
        card_rows = []
        for physical_row, raw_row in enumerate(values[1:], start=2):
            row = _row_values(raw_row)
            # A blank physical row is intentionally retained in the scan but
            # does not consume a catalog ordinal.
            if _text(row[1]):
                card_rows.append((physical_row, row))
            elif any(_text(value) for value in row):
                raise ValueError(f"{expected_title}!A{physical_row}:F{physical_row} 有孤兒或漂移資料")
        local_cards = lesson.get("cards")
        if not isinstance(local_cards, list):
            raise ValueError(f"{expected_title} local cards 不是陣列")
        if len(card_rows) != len(local_cards):
            raise ValueError(
                f"{expected_title} card count drift：local={len(local_cards)} live={len(card_rows)}"
            )
        for ordinal, (local_card, (physical_row, row)) in enumerate(zip(local_cards, card_rows), start=1):
            if not isinstance(local_card, dict):
                raise ValueError(f"{expected_title} local card {ordinal} 不是物件")
            live_card = _live_card_from_row(row, header)
            if not _live_content_matches(local_card, live_card):
                raise ValueError(f"{expected_title}!A{physical_row}:E{physical_row} content drift")
            fingerprint = content_fingerprint(local_card)
            occurrence[(expected_gid, fingerprint)] += 1
            old_id = _text(row[5])
            if old_id and not is_uuid(old_id):
                raise ValueError(f"{expected_title}!F{physical_row} invalid card_id：{old_id}")
            canonical_old = old_id.lower() if old_id else None
            if canonical_old and canonical_old in seen_ids:
                raise ValueError(f"duplicate live card_id：{canonical_old}")
            proposed = canonical_old or proposed_card_id(
                proposal_namespace, expected_gid, fingerprint, occurrence[(expected_gid, fingerprint)]
            )
            proposed_key = proposed.lower() if is_uuid(proposed) else proposed
            if proposed_key in seen_ids:
                raise ValueError(f"duplicate proposed card_id：{proposed}")
            seen_ids[proposed_key] = len(proposals)
            proposals.append({
                "spreadsheet_id": live_id,
                "published_source_url": source_url,
                "gid": expected_gid,
                "tab_title": expected_title,
                "target_column": "F",
                "sheet_row": physical_row,
                "catalog_ordinal": ordinal,
                "legacy_alias": legacy_alias(_text(lesson.get("id")), local_card),
                "content_fingerprint": fingerprint,
                "old_card_id": canonical_old,
                "proposed_card_id": proposed,
                "before_values_A_to_E": row[:5],
                "before_row_hash": hashlib.sha256(
                    json.dumps(row[:5], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                ).hexdigest(),
                "binding_status": "verified_editable_sheet_snapshot",
            })
            total_cards += 1

    if len(seen_ids) != total_cards:
        raise ValueError("proposed card_id 不唯一")
    return {
        "schema_version": LIVE_SCHEMA_VERSION,
        "report_type": LIVE_REPORT_TYPE,
        "source": {
            "source_url": source_url,
            "published_source_url": source_url,
            "spreadsheet_id": live_id,
            "canonical_spreadsheet_id": proposal_namespace,
        },
        "catalog": {"generated_at": data.get("generated_at")},
        "binding_status": "verified_editable_sheet_snapshot",
        "write_guard": "read_only_manifest_only",
        "summary": {
            "lesson_count": len(lessons),
            "card_count": total_cards,
            "unique_card_id_count": len(seen_ids),
            "existing_card_id_count": sum(row["old_card_id"] is not None for row in proposals),
            "proposed_new_card_id_count": sum(row["old_card_id"] is None for row in proposals),
        },
        "proposals": proposals,
    }


def _quote_a1_title(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def fetch_live_snapshot(service: Any, spreadsheet_id_value: str) -> dict[str, Any]:
    """Fetch metadata and A:F values only; this function has no write call."""
    metadata = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id_value,
        fields="spreadsheetId,properties(title),sheets(properties(sheetId,title,index))",
    ).execute()
    returned_id = _text(metadata.get("spreadsheetId"))
    if returned_id and returned_id != spreadsheet_id_value:
        raise ValueError(
            f"live spreadsheet ID mismatch：requested={spreadsheet_id_value} returned={returned_id}"
        )
    sheets = metadata.get("sheets") or []
    ordered = sorted(
        (sheet.get("properties") or {} for sheet in sheets),
        key=lambda props: int(props.get("index", 0)),
    )
    lesson_meta = [props for props in ordered if _text(props.get("title")) != "生活對話"]
    if not lesson_meta:
        raise ValueError("live Sheet 找不到 lesson tabs")
    ranges = [_quote_a1_title(_text(props["title"])) + "!A:F" for props in lesson_meta]
    response = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id_value,
        ranges=ranges,
        majorDimension="ROWS",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    value_ranges = response.get("valueRanges") or []
    if len(value_ranges) != len(lesson_meta):
        raise ValueError("live Sheet values 回傳數量與 tabs 不一致")
    return {
        "spreadsheet_id": returned_id or spreadsheet_id_value,
        "sheets": [
            {
                "gid": _text(props.get("sheetId")),
                "sheetId": _text(props.get("sheetId")),
                "title": _text(props.get("title")),
                "order": index,
                "values": value_range.get("values") or [],
            }
            for index, (props, value_range) in enumerate(zip(lesson_meta, value_ranges))
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA_PATH)
    parser.add_argument("--learning-snapshot", type=Path)
    parser.add_argument("--out", type=Path, help="寫入本機 manifest JSON；省略則輸出 stdout")
    parser.add_argument(
        "--live", action="store_true",
        help="只讀取 editable Sheet metadata/A:F values 並嚴格比對；沒有寫入選項",
    )
    parser.add_argument("--spreadsheet-id", default=DEFAULT_EDITABLE_SPREADSHEET_ID)
    parser.add_argument("--service-account", type=Path, default=DEFAULT_SERVICE_ACCOUNT_PATH)
    args = parser.parse_args(argv)

    try:
        data = load_data(args.data)
        if args.live:
            if not args.service_account.is_file():
                raise ValueError(f"找不到 service account：{args.service_account}")
            try:
                from google.oauth2 import service_account
                from googleapiclient.discovery import build
            except ImportError as exc:
                raise ValueError(
                    "live mode 需要以 `uv run --with google-api-python-client "
                    "--with google-auth python3 scripts/backfill-card-ids.py --live` 執行"
                ) from exc
            credentials = service_account.Credentials.from_service_account_file(
                str(args.service_account),
                scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
            )
            service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
            snapshot = fetch_live_snapshot(service, args.spreadsheet_id)
            report = build_verified_manifest(
                data,
                snapshot,
                published_source_url=_text(data.get("source_url")),
                canonical_id=args.spreadsheet_id,
            )
        else:
            learning_snapshot = (
                load_learning_snapshot(args.learning_snapshot)
                if args.learning_snapshot else None
            )
            report = build_dry_run(
                data, learning_snapshot, spreadsheet_id_value=args.spreadsheet_id
            )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.out:
        write_report(report, args.out)
    else:
        sys.stdout.buffer.write(serialize_report(report))
    summary = report["summary"]
    status = "live-verified" if args.live else "dry-run"
    collision = (
        f", {summary['collision_group_count']} collision groups"
        if "collision_group_count" in summary else ""
    )
    print(
        f"{status}: {summary['card_count']} cards{collision}, "
        f"{summary['unique_card_id_count']} unique proposed IDs",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
