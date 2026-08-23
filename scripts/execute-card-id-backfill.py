#!/usr/bin/env python3
"""Dependency-injected executor seam for an approved card_id update plan.

This module has no credentials, Google client, CLI write mode, retry, or
automatic rollback path.  A caller must provide a transport, two explicit
approval keys, exact external hashes, and the already-built plan.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PLANNER_PATH = ROOT / "scripts" / "plan-card-id-backfill.py"
SPEC = importlib.util.spec_from_file_location("card_id_backfill_planner", PLANNER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import failure is fatal
    raise RuntimeError(f"無法載入 {PLANNER_PATH}")
PLANNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLANNER)

APPROVAL_ACTION = "write-production-card-id-column-f"


class BackfillExecutionError(RuntimeError):
    """A write was attempted but could not be proved complete.

    ``rollback_plan`` is evidence for a separately approved recovery action.
    The executor never submits it.
    """

    def __init__(
        self,
        *,
        stage: str,
        cause: Exception,
        rollback_plan: dict[str, Any] | None,
        rollback_error: Exception | None = None,
    ) -> None:
        self.stage = stage
        self.cause = cause
        self.rollback_plan = rollback_plan
        self.rollback_error = rollback_error
        rollback_status = "rollback plan available; separate approval required"
        if rollback_plan is None:
            rollback_status = "rollback plan unavailable; manual investigation required"
        super().__init__(f"card_id backfill {stage} failed: {cause}; {rollback_status}")


def approval_fingerprint(
    *,
    spreadsheet_id: str,
    expected_manifest_sha256: str,
    expected_plan_sha256: str,
) -> str:
    """Bind human approval evidence to one target and two immutable inputs."""
    target = str(spreadsheet_id).strip()
    if not target:
        raise ValueError("approval spreadsheet_id 不可為空")
    manifest_digest = PLANNER._require_sha256(
        expected_manifest_sha256, "approval manifest SHA-256"
    )
    plan_digest = PLANNER._require_sha256(
        expected_plan_sha256, "approval plan SHA-256"
    )
    payload = {
        "action": APPROVAL_ACTION,
        "spreadsheet_id": target,
        "manifest_sha256": manifest_digest,
        "plan_sha256": plan_digest,
    }
    return PLANNER.manifest_sha256_bytes(PLANNER._canonical_json(payload))


def _validate_authority(
    *,
    manifest: dict[str, Any],
    plan: dict[str, Any],
    spreadsheet_id: str,
    expected_manifest_sha256: str,
    expected_plan_sha256: str,
) -> tuple[str, str, str]:
    target = str(spreadsheet_id).strip()
    manifest_digest = PLANNER._require_sha256(
        expected_manifest_sha256, "expected manifest SHA-256"
    )
    plan_digest = PLANNER._require_sha256(
        expected_plan_sha256, "expected plan SHA-256"
    )
    PLANNER.validate_manifest_shape(manifest)
    actual_manifest_digest = PLANNER._canonical_manifest_sha256(manifest)
    if manifest_digest != actual_manifest_digest:
        raise ValueError("external manifest SHA-256 mismatch")
    PLANNER._validate_plan_shape(manifest, plan, plan_digest)
    if plan.get("manifest_sha256") != manifest_digest:
        raise ValueError("plan manifest SHA-256 與 external evidence 不一致")

    physical_identities = {
        "manifest spreadsheet_id": manifest["source"].get("spreadsheet_id"),
        "plan spreadsheet_id": plan.get("spreadsheet_id"),
    }
    for label, value in physical_identities.items():
        if value != target:
            raise ValueError(f"{label} 與 explicit target spreadsheet_id 不一致")
    return target, manifest_digest, plan_digest


def _validate_write_response(
    response: Any, *, spreadsheet_id: str, request_count: int
) -> None:
    if not isinstance(response, dict):
        raise ValueError("batchUpdate response 不是物件")
    if response.get("spreadsheetId") != spreadsheet_id:
        raise ValueError("batchUpdate response spreadsheetId mismatch")
    replies = response.get("replies")
    if (
        not isinstance(replies, list)
        or len(replies) != request_count
        or any(not isinstance(reply, dict) for reply in replies)
    ):
        raise ValueError("batchUpdate response replies count/shape mismatch")


def _raise_after_write(
    *,
    stage: str,
    cause: Exception,
    transport: Any,
    spreadsheet_id: str,
    manifest: dict[str, Any],
    plan: dict[str, Any],
    plan_digest: str,
    current_snapshot: dict[str, Any] | None = None,
) -> None:
    rollback_error = None
    if current_snapshot is None:
        try:
            current_snapshot = transport.fetch_snapshot(spreadsheet_id)
        except Exception as exc:  # transport-specific errors are caller-owned
            rollback_error = exc
    rollback_plan = None
    if current_snapshot is not None:
        try:
            rollback_plan = PLANNER.build_rollback_plan(
                manifest, plan, plan_digest, current_snapshot
            )
        except Exception as exc:
            rollback_error = exc
    error = BackfillExecutionError(
        stage=stage,
        cause=cause,
        rollback_plan=rollback_plan,
        rollback_error=rollback_error,
    )
    raise error from cause


def execute_approved_plan(
    *,
    manifest: dict[str, Any],
    plan: dict[str, Any],
    spreadsheet_id: str,
    expected_manifest_sha256: str,
    expected_plan_sha256: str,
    confirm_write: bool,
    provided_approval_fingerprint: str | None,
    transport: Any,
) -> dict[str, Any]:
    """Submit one approved batchUpdate and prove its fresh read-back."""
    target, manifest_digest, plan_digest = _validate_authority(
        manifest=manifest,
        plan=plan,
        spreadsheet_id=spreadsheet_id,
        expected_manifest_sha256=expected_manifest_sha256,
        expected_plan_sha256=expected_plan_sha256,
    )
    expected_approval = approval_fingerprint(
        spreadsheet_id=target,
        expected_manifest_sha256=manifest_digest,
        expected_plan_sha256=plan_digest,
    )
    if confirm_write is not True:
        raise ValueError("confirm_write 必須明確為 true；本次 0 writes")
    if provided_approval_fingerprint != expected_approval:
        raise ValueError("approval fingerprint 不符合 target/manifest/plan；本次 0 writes")

    before_snapshot = transport.fetch_snapshot(target)
    PLANNER.validate_pre_write(manifest, plan, plan_digest, before_snapshot)

    def fail_after_write(
        stage: str,
        cause: Exception,
        *,
        current_snapshot: dict[str, Any] | None = None,
    ) -> None:
        _raise_after_write(
            stage=stage,
            cause=cause,
            transport=transport,
            spreadsheet_id=target,
            manifest=manifest,
            plan=plan,
            plan_digest=plan_digest,
            current_snapshot=current_snapshot,
        )

    try:
        response = transport.batch_update(target, plan["requests"])
    except Exception as exc:
        fail_after_write("write", exc)

    response_validation_warning = None
    try:
        _validate_write_response(
            response, spreadsheet_id=target, request_count=len(plan["requests"])
        )
    except Exception as exc:
        response_validation_warning = str(exc)

    try:
        post_snapshot = transport.fetch_snapshot(target)
    except Exception as exc:
        fail_after_write("post_read", exc)
    try:
        PLANNER.validate_post_write(manifest, plan, plan_digest, post_snapshot)
    except Exception as exc:
        fail_after_write("post_write", exc, current_snapshot=post_snapshot)

    result = {
        "status": "verified",
        "spreadsheet_id": target,
        "manifest_sha256": manifest_digest,
        "plan_sha256": plan_digest,
        "request_count": len(plan["requests"]),
    }
    if response_validation_warning is not None:
        result["response_validation_warning"] = response_validation_warning
    return result
