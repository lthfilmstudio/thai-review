#!/usr/bin/env python3
"""Thin CLI entrypoint for guarded Thai class transcription."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SCRIPT_DIR = str(Path(__file__).resolve().parent)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import transcribe_class_common as _common
import transcribe_class_paid as _paid
import transcribe_class_postprocess as _postprocess
from transcribe_class_common import *
from transcribe_class_postprocess import *
from transcribe_class_paid import *


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare explicit Thai class MP4 files for guarded ElevenLabs Scribe v2 transcription."
    )
    parser.add_argument(
        "sources",
        nargs="*",
        type=Path,
        help="Explicit MP4 files in class order; required for preparation, paid execution and recovery",
    )
    parser.add_argument("--job-id", help="Safe output job ID; defaults to the source prefix")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--data", type=Path, default=Path("data.json"))
    parser.add_argument(
        "--keyterms-file",
        type=Path,
        help=(
            "Free preparation only: JSON file containing a plain list of keyterm strings "
            "to bias Scribe recognition toward (adds a 20%% ElevenLabs surcharge). "
            "Sticky across re-preparation once set; omit to keep the previous choice."
        ),
    )
    parser.add_argument(
        "--secrets-file",
        type=Path,
        default=DEFAULT_STT_SECRETS_PATH,
        help="Repo-external mode 0600 file containing only the restricted STT key checklist",
    )
    parser.add_argument(
        "--confirm-paid-api",
        action="store_true",
        help="Confirm only the currently saved matching paid disclosure (requires a separate user approval)",
    )
    parser.add_argument(
        "--approval-fingerprint",
        help="Exact 64-character fingerprint printed by the currently approved paid disclosure",
    )
    parser.add_argument(
        "--force-paid-retry",
        action="store_true",
        help="Allow a separately approved Unknown retry together with --confirm-paid-api",
    )
    parser.add_argument(
        "--recover-unknown",
        action="store_true",
        help="Perform a fixed read-only GET for Unknown segments that have a transcription ID",
    )
    parser.add_argument(
        "--handoff",
        action="store_true",
        help="Record the current data.json identity and print the untrusted-data TSV handoff",
    )
    parser.add_argument(
        "--validate-tsv",
        type=Path,
        metavar="DRAFT",
        help="Validate and atomically promote the fixed five-column TSV draft",
    )
    parser.add_argument("--status", action="store_true", help="Read the current durable job state only")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.confirm_paid_api and not args.approval_fingerprint:
        raise SystemExit("--confirm-paid-api 必須與 --approval-fingerprint 一起使用")
    if args.approval_fingerprint and not args.confirm_paid_api:
        raise SystemExit("--approval-fingerprint 只可與 --confirm-paid-api 一起使用")
    if args.approval_fingerprint and not re.fullmatch(r"[0-9a-f]{64}", args.approval_fingerprint):
        raise SystemExit("--approval-fingerprint 必須是 64 位小寫十六進位字串")
    if args.force_paid_retry and not args.confirm_paid_api:
        raise SystemExit("--force-paid-retry 必須與 --confirm-paid-api 一起使用")
    if args.keyterms_file and (
        args.confirm_paid_api or args.recover_unknown or args.handoff
        or args.validate_tsv or args.status
    ):
        raise SystemExit("--keyterms-file 只能用在免費 preparation")
    operation_count = sum(bool(value) for value in (
        args.confirm_paid_api, args.recover_unknown, args.handoff, args.validate_tsv, args.status
    ))
    if operation_count > 1:
        raise SystemExit("付費、Unknown recovery、handoff、TSV validation 與 status 一次只能選一項")
    try:
        output: dict | None = None
        if operation_count:
            ordered: list[Path] = []
            derived_job_id: str | None = None
            if args.sources:
                ordered, derived_job_id = order_sources(args.sources)
            if (args.confirm_paid_api or args.recover_unknown) and not ordered:
                raise ValueError("付費執行與 Unknown recovery 必須重新提供原始 MP4")
            selected_job_id = args.job_id or derived_job_id
            if not selected_job_id:
                raise ValueError("這項操作未提供來源 MP4 時，必須指定 --job-id")
            state_path = safe_job_root(args.out_root, selected_job_id) / "job.json"
            if args.recover_unknown:
                job = recover_unknown(
                    state_path,
                    ordered,
                    secrets_path=args.secrets_file,
                )
            elif args.confirm_paid_api:
                job = execute_paid(
                    state_path,
                    ordered,
                    confirm_paid_api=True,
                    approval_fingerprint=args.approval_fingerprint,
                    force_paid_retry=args.force_paid_retry,
                    secrets_path=args.secrets_file,
                )
            elif args.handoff:
                output = prepare_tsv_handoff(state_path, args.data)
                job = load_json_object(state_path)
            elif args.validate_tsv:
                job = validate_and_promote_tsv(state_path, args.validate_tsv, args.data)
            elif args.status:
                job = load_json_object(state_path)
        else:
            if not args.sources:
                raise ValueError("免費 preparation 必須提供至少一個原始 MP4")
            keyterms = None
            if args.keyterms_file:
                loaded = json.loads(args.keyterms_file.read_text(encoding="utf-8"))
                if not isinstance(loaded, list) or not all(isinstance(t, str) for t in loaded):
                    raise ValueError("--keyterms-file 必須是純字串陣列的 JSON")
                validate_keyterms(loaded)
                keyterms = loaded
            job = prepare_job(
                args.sources,
                args.out_root,
                job_id=args.job_id,
                data_path=args.data,
                keyterms=keyterms,
            )
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    if output is None:
        output = {
            "job_id": job["job_id"],
            "state": job["state"],
            "next_action": job.get("next_action"),
            "approval_fingerprint": job.get("approval_fingerprint"),
            "approval": job.get("approval"),
            "combined_transcript": job.get("combined_transcript"),
            "data_snapshot": job.get("data_snapshot"),
            "tsv": job.get("tsv"),
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
