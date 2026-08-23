#!/usr/bin/env python3
"""Plan-only validator for a future F-column card_id backfill.

This module intentionally has no Google client and no write mode.  It reads a
LIVE_REPORT_TYPE/schema 3 manifest plus local snapshots, verifies the caller's
manifest hash, and emits deterministic ``updateCells`` request objects.  A
separate, explicitly approved writer may consume the plan later.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BACKFILL_PATH = ROOT / "scripts" / "backfill-card-ids.py"
SPEC = importlib.util.spec_from_file_location("backfill_card_ids", BACKFILL_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import failure is fatal
    raise RuntimeError(f"無法載入 {BACKFILL_PATH}")
BACKFILL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKFILL)

_text = BACKFILL._text
_row_values = BACKFILL._row_values

LIVE_REPORT_TYPE = BACKFILL.LIVE_REPORT_TYPE
LIVE_SCHEMA_VERSION = BACKFILL.LIVE_SCHEMA_VERSION
CARD_ID_HEADER = "card_id"
F_COLUMN_INDEX = 5
PLAN_TYPE = "card-id-backfill-update-cells-plan"
PLAN_SCHEMA_VERSION = 2
PREFLIGHT_TYPE = "card-id-backfill-preflight-receipt"
PREFLIGHT_SCHEMA_VERSION = 1
ROLLBACK_TYPE = "card-id-backfill-rollback-plan"
ROLLBACK_SCHEMA_VERSION = 2
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GID_RE = re.compile(r"^(0|[1-9][0-9]*)$")

def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def manifest_sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def serialize_plan(plan: dict[str, Any]) -> bytes:
    return BACKFILL.serialize_report(plan)


def plan_sha256(plan: dict[str, Any]) -> str:
    return manifest_sha256_bytes(serialize_plan(plan))


def _require_sha256(value: Any, label: str) -> str:
    digest = _text(value).lower()
    if not SHA256_RE.fullmatch(digest):
        raise ValueError(f"{label} 必須是 64 位十六進位 SHA-256")
    return digest


def load_verified_manifest(path: Path, expected_sha256: str) -> tuple[dict[str, Any], str]:
    expected = _require_sha256(expected_sha256, "expected manifest SHA-256")
    raw = path.read_bytes()
    actual = manifest_sha256_bytes(raw)
    if actual != expected:
        raise ValueError(f"manifest SHA-256 mismatch：expected={expected} actual={actual}")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("manifest 不是有效 UTF-8 JSON") from exc
    validate_manifest_shape(manifest)
    return manifest, actual


def validate_manifest_shape(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("manifest 必須是物件")
    if manifest.get("report_type") != LIVE_REPORT_TYPE:
        raise ValueError("manifest report_type 不是 live verified report")
    if manifest.get("schema_version") != LIVE_SCHEMA_VERSION:
        raise ValueError("manifest schema_version 不是 3")
    if manifest.get("binding_status") != "verified_editable_sheet_snapshot":
        raise ValueError("manifest binding_status 未 verified")
    if manifest.get("write_guard") != "read_only_manifest_only":
        raise ValueError("manifest write_guard 不允許 plan")
    source = manifest.get("source")
    proposals = manifest.get("proposals")
    if not isinstance(source, dict) or not isinstance(proposals, list) or not proposals:
        raise ValueError("manifest 缺少 source/proposals")
    if not _text(source.get("spreadsheet_id")) or not _text(source.get("canonical_spreadsheet_id")):
        raise ValueError("manifest 缺少 spreadsheet identity")
    seen: set[str] = set()
    for index, proposal in enumerate(proposals, start=1):
        if not isinstance(proposal, dict):
            raise ValueError(f"proposal {index} 不是物件")
        required = (
            "spreadsheet_id", "published_source_url", "gid", "tab_title", "target_column",
            "sheet_row", "catalog_ordinal", "legacy_alias", "content_fingerprint",
            "old_card_id", "proposed_card_id", "before_values_A_to_E", "before_row_hash",
            "binding_status",
        )
        missing = [key for key in required if key not in proposal]
        if missing:
            raise ValueError(f"proposal {index} 缺少欄位：{', '.join(missing)}")
        if _text(proposal["spreadsheet_id"]) != _text(source["spreadsheet_id"]):
            raise ValueError(f"proposal {index} spreadsheet_id drift")
        source_url = source.get("published_source_url") or source.get("source_url")
        if _text(proposal["published_source_url"]) != _text(source_url):
            raise ValueError(f"proposal {index} published_source_url drift")
        if proposal["target_column"] != "F" or proposal["binding_status"] != "verified_editable_sheet_snapshot":
            raise ValueError(f"proposal {index} target/binding 不合法")
        if not isinstance(proposal["before_values_A_to_E"], list) or len(proposal["before_values_A_to_E"]) != 5:
            raise ValueError(f"proposal {index} before_values_A_to_E 必須正好 5 欄")
        expected_row_hash = hashlib.sha256(_canonical_json(proposal["before_values_A_to_E"])).hexdigest()
        if _text(proposal["before_row_hash"]) != expected_row_hash:
            raise ValueError(f"proposal {index} before_row_hash drift")
        row = proposal["sheet_row"]
        if not isinstance(row, int) or isinstance(row, bool) or row < 2:
            raise ValueError(f"proposal {index} sheet_row 不合法")
        card_id = _text(proposal["proposed_card_id"])
        if not BACKFILL.is_uuid(card_id):
            raise ValueError(f"proposal {index} proposed_card_id 不是 UUID")
        if card_id != card_id.lower():
            raise ValueError(f"proposal {index} proposed_card_id 必須 canonical lowercase")
        if card_id in seen:
            raise ValueError(f"duplicate proposed_card_id：{card_id}")
        seen.add(card_id)
        old_id = proposal["old_card_id"]
        if old_id is not None and (not BACKFILL.is_uuid(old_id) or old_id != old_id.lower()):
            raise ValueError(f"proposal {index} old_card_id 不合法")
        if not GID_RE.fullmatch(_text(proposal["gid"])):
            raise ValueError(f"proposal {index} gid 不合法")


def _cell_data(value: str) -> dict[str, Any]:
    if value == "":
        return {}
    return {"userEnteredValue": {"stringValue": value}}


def _tab_request(sheet_id: str, values: list[str]) -> dict[str, Any]:
    if not GID_RE.fullmatch(_text(sheet_id)):
        raise ValueError(f"gid 不是 canonical 數字：{sheet_id}")
    if not values:
        raise ValueError("request range index 不合法")
    return {
        "updateCells": {
            "range": {
                "sheetId": int(sheet_id),
                "startRowIndex": 0,
                "endRowIndex": len(values),
                "startColumnIndex": F_COLUMN_INDEX,
                "endColumnIndex": F_COLUMN_INDEX + 1,
            },
            "rows": [{"values": [_cell_data(value)]} for value in values],
            "fields": "userEnteredValue",
        }
    }


def _index_sheets(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sheets = snapshot.get("sheets")
    if not isinstance(sheets, list):
        raise ValueError("snapshot 缺少 sheets")
    indexed: dict[str, dict[str, Any]] = {}
    for sheet in sheets:
        if not isinstance(sheet, dict):
            raise ValueError("snapshot sheet 不是物件")
        raw_gid = sheet.get("gid")
        if raw_gid is None or raw_gid == "":
            raw_gid = sheet.get("sheetId")
        gid = _text(raw_gid)
        if not gid or gid in indexed:
            raise ValueError("snapshot gid 缺失或重複")
        if not GID_RE.fullmatch(gid):
            raise ValueError(f"snapshot gid 不是 canonical 數字：{gid}")
        indexed[gid] = sheet
    return indexed


def _sheet_order(sheet: dict[str, Any], gid: str) -> int:
    if "order" not in sheet:
        raise ValueError(f"{gid} snapshot 缺少 order")
    value = sheet["order"]
    if isinstance(value, bool):
        raise ValueError(f"{gid} order 不合法")
    try:
        order = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{gid} order 不合法") from exc
    if order < 0:
        raise ValueError(f"{gid} order 不合法")
    return order


def _raw_text(value: Any) -> str:
    return "" if value is None else str(value)


def _tab_groups(manifest: dict[str, Any]) -> list[tuple[str, list[dict[str, Any]]]]:
    groups: list[tuple[str, list[dict[str, Any]]]] = []
    by_gid: dict[str, list[dict[str, Any]]] = {}
    for proposal in manifest["proposals"]:
        gid = _text(proposal["gid"])
        if gid not in by_gid:
            by_gid[gid] = []
            groups.append((gid, by_gid[gid]))
        by_gid[gid].append(proposal)
    return groups


def _normalized_tab_rows(
    sheet: dict[str, Any], gid: str, row_count: int,
) -> list[list[Any]]:
    values = sheet.get("values")
    if not isinstance(values, list) or len(values) < row_count:
        raise ValueError(f"{gid} values 少於已綁定 physical rows")
    rows = [_row_values(row) for row in values[:row_count]]
    for row in values[row_count:]:
        if any(_text(value) for value in _row_values(row)):
            raise ValueError(f"{gid} 已綁定範圍後有新增資料")
    return rows


def _canonical_manifest_sha256(manifest: dict[str, Any]) -> str:
    return manifest_sha256_bytes(BACKFILL.serialize_report(manifest))


def preflight(
    manifest: dict[str, Any],
    manifest_sha256: str,
    data: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Rebuild bindings and return an immutable A:F before-image receipt."""
    validate_manifest_shape(manifest)
    digest = _require_sha256(manifest_sha256, "manifest SHA-256")
    if digest != _canonical_manifest_sha256(manifest):
        raise ValueError("manifest SHA-256 drift")
    if _text(snapshot.get("spreadsheet_id")) != _text(manifest["source"]["spreadsheet_id"]):
        raise ValueError("preflight spreadsheet_id drift")
    rebuilt = BACKFILL.build_verified_manifest(
        data,
        snapshot,
        published_source_url=manifest["source"].get("published_source_url")
        or manifest["source"].get("source_url"),
        canonical_id=manifest["source"]["canonical_spreadsheet_id"],
    )
    if rebuilt["source"] != manifest["source"]:
        raise ValueError("preflight manifest source drift")
    if rebuilt["proposals"] != manifest["proposals"]:
        raise ValueError("preflight manifest proposal drift")
    sheets = _index_sheets(snapshot)
    groups = _tab_groups(manifest)
    expected_gids = [gid for gid, _ in groups]
    if set(sheets) != set(expected_gids):
        raise ValueError("preflight snapshot tab set drift")

    receipt_tabs: list[dict[str, Any]] = []
    canonical_tabs: list[dict[str, Any]] = []
    for expected_order, (gid, proposals) in enumerate(groups):
        sheet = sheets[gid]
        title = _text(proposals[0]["tab_title"])
        if _text(sheet.get("title")) != title:
            raise ValueError(f"{gid} tab title drift")
        if _sheet_order(sheet, gid) != expected_order:
            raise ValueError(f"{gid} tab order drift")
        row_count = max(proposal["sheet_row"] for proposal in proposals)
        rows = _normalized_tab_rows(sheet, gid, row_count)
        before_f_values = [_raw_text(row[5]) for row in rows]
        a_to_e_rows = [row[:5] for row in rows]
        receipt_tabs.append({
            "gid": gid,
            "tab_title": title,
            "order": expected_order,
            "row_count": row_count,
            "before_a_to_e_sha256": manifest_sha256_bytes(_canonical_json(a_to_e_rows)),
            "before_f_values": before_f_values,
        })
        canonical_tabs.append({
            "gid": gid,
            "tab_title": title,
            "order": expected_order,
            "values_A_to_F": rows,
        })
    canonical_snapshot = {
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "tabs": canonical_tabs,
    }
    return {
        "receipt_type": PREFLIGHT_TYPE,
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "manifest_sha256": digest,
        "snapshot_sha256": manifest_sha256_bytes(_canonical_json(canonical_snapshot)),
        "tabs": receipt_tabs,
    }


def _after_f_values(
    proposals: list[dict[str, Any]], row_count: int,
) -> list[str]:
    values = [""] * row_count
    values[0] = CARD_ID_HEADER
    for proposal in proposals:
        values[proposal["sheet_row"] - 1] = proposal["proposed_card_id"]
    return values


def build_update_plan(
    manifest: dict[str, Any],
    manifest_sha256: str,
    data: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    digest = _require_sha256(manifest_sha256, "manifest SHA-256")
    receipt = preflight(manifest, digest, data, snapshot)
    groups = _tab_groups(manifest)
    receipt_by_gid = {tab["gid"]: tab for tab in receipt["tabs"]}
    requests = [
        _tab_request(gid, _after_f_values(proposals, receipt_by_gid[gid]["row_count"]))
        for gid, proposals in groups
    ]
    return {
        "plan_type": PLAN_TYPE,
        "schema_version": PLAN_SCHEMA_VERSION,
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "canonical_spreadsheet_id": manifest["source"]["canonical_spreadsheet_id"],
        "manifest_sha256": digest,
        "target_column": "F",
        "preflight": receipt,
        "requests": requests,
    }


def _validate_plan_shape(
    manifest: dict[str, Any], plan: dict[str, Any], expected_plan_sha256: str,
) -> dict[str, dict[str, Any]]:
    validate_manifest_shape(manifest)
    if not isinstance(plan, dict):
        raise ValueError("plan 必須是物件")
    expected_plan_digest = _require_sha256(expected_plan_sha256, "expected plan SHA-256")
    actual_plan_digest = plan_sha256(plan)
    if actual_plan_digest != expected_plan_digest:
        raise ValueError(
            "plan SHA-256 mismatch："
            f"expected={expected_plan_digest} actual={actual_plan_digest}"
        )
    digest = _require_sha256(plan.get("manifest_sha256"), "plan manifest SHA-256")
    if digest != _canonical_manifest_sha256(manifest):
        raise ValueError("plan manifest SHA-256 drift")
    expected_top = {
        "plan_type": PLAN_TYPE,
        "schema_version": PLAN_SCHEMA_VERSION,
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "canonical_spreadsheet_id": manifest["source"]["canonical_spreadsheet_id"],
        "target_column": "F",
    }
    for key, expected in expected_top.items():
        if plan.get(key) != expected:
            raise ValueError(f"plan {key} drift")

    receipt = plan.get("preflight")
    if not isinstance(receipt, dict):
        raise ValueError("plan 缺少 preflight receipt")
    expected_receipt = {
        "receipt_type": PREFLIGHT_TYPE,
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "manifest_sha256": digest,
    }
    for key, expected in expected_receipt.items():
        if receipt.get(key) != expected:
            raise ValueError(f"preflight receipt {key} drift")
    _require_sha256(receipt.get("snapshot_sha256"), "preflight snapshot SHA-256")

    tabs = receipt.get("tabs")
    groups = _tab_groups(manifest)
    if not isinstance(tabs, list) or len(tabs) != len(groups):
        raise ValueError("preflight receipt tabs drift")
    receipt_by_gid: dict[str, dict[str, Any]] = {}
    expected_requests: list[dict[str, Any]] = []
    for expected_order, ((gid, proposals), tab) in enumerate(zip(groups, tabs)):
        if not isinstance(tab, dict):
            raise ValueError(f"preflight tab {gid} 不是物件")
        row_count = max(proposal["sheet_row"] for proposal in proposals)
        expected_tab = {
            "gid": gid,
            "tab_title": _text(proposals[0]["tab_title"]),
            "order": expected_order,
            "row_count": row_count,
        }
        for key, expected in expected_tab.items():
            if tab.get(key) != expected:
                raise ValueError(f"preflight tab {gid} {key} drift")
        _require_sha256(tab.get("before_a_to_e_sha256"), f"{gid} A:E SHA-256")
        before_f = tab.get("before_f_values")
        if (
            not isinstance(before_f, list)
            or len(before_f) != row_count
            or any(not isinstance(value, str) for value in before_f)
        ):
            raise ValueError(f"preflight tab {gid} before F drift")
        if _text(before_f[0]).lower() not in {
            "", "card_id", "card id", "卡片 id", "卡片id",
        }:
            raise ValueError(f"preflight tab {gid} F1 header drift")
        proposal_by_row = {
            proposal["sheet_row"]: proposal for proposal in proposals
        }
        for row_number, raw_value in enumerate(before_f[1:], start=2):
            normalized = _text(raw_value).lower()
            proposal = proposal_by_row.get(row_number)
            if proposal is not None:
                if normalized != (proposal["old_card_id"] or ""):
                    raise ValueError(
                        f"preflight tab {gid}!F{row_number} old_card_id drift"
                    )
            elif normalized:
                raise ValueError(
                    f"preflight tab {gid}!F{row_number} non-proposal F drift"
                )
        if gid in receipt_by_gid:
            raise ValueError(f"preflight duplicate gid：{gid}")
        receipt_by_gid[gid] = tab
        expected_requests.append(
            _tab_request(gid, _after_f_values(proposals, row_count))
        )
    if plan.get("requests") != expected_requests:
        raise ValueError("plan requests drift")
    return receipt_by_gid


def _validate_snapshot_against_plan(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    expected_plan_sha256: str,
    snapshot: dict[str, Any],
    *,
    f_state: str,
) -> dict[str, dict[str, Any]]:
    if f_state not in {"before", "after", "partial"}:
        raise ValueError(f"unknown F validation state：{f_state}")
    receipt_by_gid = _validate_plan_shape(manifest, plan, expected_plan_sha256)
    if _text(snapshot.get("spreadsheet_id")) != _text(manifest["source"]["spreadsheet_id"]):
        raise ValueError("snapshot spreadsheet_id drift")
    sheets = _index_sheets(snapshot)
    groups = _tab_groups(manifest)
    if set(sheets) != {gid for gid, _ in groups}:
        raise ValueError("snapshot tab set drift")

    for expected_order, (gid, proposals) in enumerate(groups):
        sheet = sheets[gid]
        receipt = receipt_by_gid[gid]
        if _text(sheet.get("title")) != receipt["tab_title"]:
            raise ValueError(f"{gid} tab title drift")
        if _sheet_order(sheet, gid) != expected_order:
            raise ValueError(f"{gid} tab order drift")
        rows = _normalized_tab_rows(sheet, gid, receipt["row_count"])
        current_a_to_e_sha256 = manifest_sha256_bytes(
            _canonical_json([row[:5] for row in rows])
        )
        if current_a_to_e_sha256 != receipt["before_a_to_e_sha256"]:
            raise ValueError(f"{gid} A:E drift")
        current_f = [_raw_text(row[5]) for row in rows]
        before_f = receipt["before_f_values"]
        after_f = _after_f_values(proposals, receipt["row_count"])
        proposal_rows = {proposal["sheet_row"] for proposal in proposals}
        for row_number, (current, before, after) in enumerate(
            zip(current_f, before_f, after_f), start=1
        ):
            if f_state == "before":
                if current != before:
                    raise ValueError(f"{gid}!F{row_number} pre-write F drift")
                continue
            if f_state == "after":
                if current == after:
                    continue
                if row_number == 1:
                    raise ValueError(f"{gid} F1 不是 card_id")
                if row_number in proposal_rows:
                    raise ValueError(f"{gid}!F{row_number} proposed UUID drift")
                raise ValueError(f"{gid}!F{row_number} orphan F drift")
            if current not in {before, after}:
                raise ValueError(f"{gid}!F{row_number} rollback current value drift")
    return receipt_by_gid


def validate_pre_write(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    expected_plan_sha256: str,
    snapshot: dict[str, Any],
) -> None:
    _validate_snapshot_against_plan(
        manifest, plan, expected_plan_sha256, snapshot, f_state="before"
    )


def validate_post_write(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    expected_plan_sha256: str,
    snapshot: dict[str, Any],
) -> None:
    _validate_snapshot_against_plan(
        manifest, plan, expected_plan_sha256, snapshot, f_state="after"
    )


def build_rollback_plan(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    expected_plan_sha256: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    receipt_by_gid = _validate_snapshot_against_plan(
        manifest, plan, expected_plan_sha256, snapshot, f_state="partial"
    )
    requests = [
        _tab_request(gid, receipt_by_gid[gid]["before_f_values"])
        for gid, _ in _tab_groups(manifest)
    ]
    return {
        "plan_type": ROLLBACK_TYPE,
        "schema_version": ROLLBACK_SCHEMA_VERSION,
        "spreadsheet_id": manifest["source"]["spreadsheet_id"],
        "canonical_spreadsheet_id": manifest["source"]["canonical_spreadsheet_id"],
        "manifest_sha256": plan["manifest_sha256"],
        "source_plan_sha256": expected_plan_sha256,
        "target_column": "F",
        "requests": requests,
    }


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"無法讀取 JSON：{path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON 必須是物件：{path}")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest, digest = load_verified_manifest(args.manifest, args.expected_sha256)
        data = BACKFILL.load_data(args.data)
        snapshot = _load_json(args.snapshot)
        plan = build_update_plan(manifest, digest, data, snapshot)
        encoded = serialize_plan(plan)
        if args.out:
            args.out.write_bytes(encoded)
        else:
            sys.stdout.buffer.write(encoded)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(
        f"plan-only: {len(plan['requests'])} F-column requests; "
        f"plan_sha256={plan_sha256(plan)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
