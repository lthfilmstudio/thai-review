#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/update-audio-deploy.sh [options]

Default is safe dry-run only. It does not call ElevenLabs and does not deploy.

Options:
  --generate             Generate missing MP3 files.
  --confirm-paid-api     Required with --generate.
  --deploy               Build out/pages-deploy and deploy to Cloudflare Pages.
  --max-chars N          Paid character cap for this run. Defaults to dry-run missing chars.
  --manifest PATH        Manifest path. Default: out/site-preview/audio-manifest.json.
  --out-dir PATH         Site/audio output root. Default: out/site-preview.
  --keychain-service S   macOS Keychain service for ELEVENLABS_API_KEY.
                         Default: elevenlabs-thai-review-sample.
  --skip-tests           Skip node tests before deploy.
  -h, --help             Show this help.

Examples:
  scripts/update-audio-deploy.sh
  scripts/update-audio-deploy.sh --generate --confirm-paid-api
  scripts/update-audio-deploy.sh --generate --confirm-paid-api --deploy
EOF
}

generate=0
confirm_paid_api=0
deploy=0
skip_tests=0
max_chars=""
manifest="out/site-preview/audio-manifest.json"
out_dir="out/site-preview"
keychain_service="elevenlabs-thai-review-sample"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --generate) generate=1; shift ;;
    --confirm-paid-api) confirm_paid_api=1; shift ;;
    --deploy) deploy=1; shift ;;
    --max-chars) max_chars="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    --out-dir) out_dir="${2:-}"; shift 2 ;;
    --keychain-service) keychain_service="${2:-}"; shift 2 ;;
    --skip-tests) skip_tests=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$generate" -eq 1 && "$confirm_paid_api" -ne 1 ]]; then
  echo "ERROR: --generate requires --confirm-paid-api." >&2
  exit 2
fi

if [[ -n "$max_chars" && ! "$max_chars" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --max-chars must be a non-negative integer." >&2
  exit 2
fi

ensure_preview_shell() {
  mkdir -p "$out_dir"
  for item in index.html data.json styles icons manifest.webmanifest sw.js src; do
    if [[ ! -e "$out_dir/$item" ]]; then
      ln -s "../../$item" "$out_dir/$item"
    fi
  done
}

json_field() {
  local expr="$1"
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$expr" <<<"$dry_json"
}

read_dry_run() {
  dry_json="$(python3 scripts/gen-audio.py --dry-run --json --manifest "$manifest" --out-dir "$out_dir")"
  missing_files="$(json_field 'd["coverage"]["missing_audio_files"]')"
  missing_chars="$(json_field 'd["coverage"]["missing_chars_to_generate"]')"
  estimated_usd="$(json_field 'format(d["cost"]["estimated_usd"], ".2f")')"
  data_generated="$(json_field 'd["data_generated_at"]')"
}

ensure_preview_shell

echo "== Dry-run: ElevenLabs baked Thai audio =="
read_dry_run
echo "Data generated: $data_generated"
echo "Missing audio files: $missing_files"
echo "Missing chars: $missing_chars"
echo "Estimated cost: US\$$estimated_usd"

if [[ "$missing_files" != "0" ]]; then
  if [[ "$generate" -ne 1 ]]; then
    echo
    echo "Missing audio found. No API calls were made."
    echo "To generate:"
    echo "  scripts/update-audio-deploy.sh --generate --confirm-paid-api"
    exit 0
  fi

  run_max_chars="${max_chars:-$missing_chars}"
  echo
  echo "== Generate missing MP3 =="
  echo "Max chars: $run_max_chars"

  if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
    if command -v security >/dev/null 2>&1; then
      set +e
      ELEVENLABS_API_KEY="$(security find-generic-password -a "$USER" -s "$keychain_service" -w 2>/dev/null)"
      key_status=$?
      set -e
      if [[ "$key_status" -eq 0 && -n "$ELEVENLABS_API_KEY" ]]; then
        export ELEVENLABS_API_KEY
      fi
    fi
  fi

  python3 scripts/gen-audio.py \
    --generate \
    --confirm-paid-api \
    --max-chars "$run_max_chars" \
    --out-dir "$out_dir" \
    --manifest "$manifest"

  echo
  echo "== Verify after generation =="
  python3 scripts/gen-audio.py --dry-run --manifest "$manifest" --out-dir "$out_dir"
  read_dry_run
else
  echo "Audio coverage is complete."
fi

if [[ "$deploy" -eq 1 ]]; then
  if [[ "$missing_files" != "0" ]]; then
    echo "ERROR: refusing to deploy with $missing_files missing audio files." >&2
    exit 2
  fi

  if [[ "$skip_tests" -ne 1 ]]; then
    echo
    echo "== Tests =="
    node --test tests/autoplay.test.mjs
  fi

  echo
  echo "== Build Pages deploy directory =="
  rm -rf out/pages-deploy
  mkdir -p out/pages-deploy
  rsync -aL --delete "$out_dir/" out/pages-deploy/

  symlink_count="$(find out/pages-deploy -type l -print | wc -l | tr -d ' ')"
  if [[ "$symlink_count" != "0" ]]; then
    echo "ERROR: out/pages-deploy contains symlinks." >&2
    exit 2
  fi

  echo
  echo "== Deploy Cloudflare Pages =="
  npx wrangler pages deploy out/pages-deploy --project-name thai-review --branch main
fi
