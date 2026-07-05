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
node_tests=(
  tests/autoplay.test.mjs
  tests/listen_lock.test.mjs
  tests/zh_sprite.test.mjs
  tests/service_worker.test.mjs
)

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

sw_cache_name() {
  python3 - <<'PY'
import re
from pathlib import Path
text = Path("sw.js").read_text(encoding="utf-8")
m = re.search(r"const CACHE = ['\"]([^'\"]+)['\"]", text)
print(m.group(1) if m else "")
PY
}

asset_sha() {
  shasum "$1" | awk '{print $1}'
}

remote_sha() {
  curl -fsSL "$1" | shasum | awk '{print $1}'
}

verify_deploy_asset() {
  local deployment_url="$1"
  local rel="$2"
  local local_file="out/pages-deploy/$rel"
  local local_hash
  local remote_hash

  local_hash="$(asset_sha "$local_file")"
  remote_hash="$(remote_sha "${deployment_url%/}/$rel")"
  if [[ "$local_hash" != "$remote_hash" ]]; then
    echo "ERROR: deployed $rel hash mismatch." >&2
    echo "  local:  $local_hash" >&2
    echo "  remote: $remote_hash" >&2
    return 1
  fi
  echo "OK $rel $remote_hash"
}

verify_deployment_readback() {
  local deployment_url="$1"
  echo
  echo "== Verify deployed assets =="
  verify_deploy_asset "$deployment_url" "sw.js"
  verify_deploy_asset "$deployment_url" "data.json"
  verify_deploy_asset "$deployment_url" "zh-manifest.json"
  verify_deploy_asset "$deployment_url" "audio-manifest.json"
  verify_deploy_asset "$deployment_url" "deploy-info.json"
  echo "Deployment URL: $deployment_url"
  echo "Source commit: $(git rev-parse --short HEAD)"
  echo "Data generated: $data_generated"
}

write_deploy_info() {
  local deploy_info="out/pages-deploy/deploy-info.json"
  python3 - <<PY
import json
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

def sha(path):
    return subprocess.check_output(["shasum", path], text=True).split()[0]

info = {
    "generated_at": datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds"),
    "source_commit": subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip(),
    "source_branch": subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip(),
    "sw_cache": "$(sw_cache_name)",
    "data_generated": "$data_generated",
    "assets": {
        "sw.js": sha("out/pages-deploy/sw.js"),
        "data.json": sha("out/pages-deploy/data.json"),
        "zh-manifest.json": sha("out/pages-deploy/zh-manifest.json"),
        "audio-manifest.json": sha("out/pages-deploy/audio-manifest.json"),
    },
}
Path("$deploy_info").write_text(json.dumps(info, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

print_deploy_summary_json() {
  local deployment_url="$1"
  python3 - <<PY
import json
from pathlib import Path

info = json.loads(Path("out/pages-deploy/deploy-info.json").read_text(encoding="utf-8"))
info["deployment_url"] = "$deployment_url"
print("DEPLOY_SUMMARY_JSON=" + json.dumps(info, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
PY
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

echo
echo "== Dry-run: GCP zh sprite audio =="
read_zh_dry_run() {
  zh_json="$(python3 scripts/gen-zh-audio.py --dry-run --json --out-dir "$out_dir")"
  zh_stale="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["lessons_stale"])' <<<"$zh_json")"
  zh_chars="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["api_chars"])' <<<"$zh_json")"
  zh_usd="$(python3 -c 'import json,sys; print(format(json.load(sys.stdin)["estimated_usd"], ".2f"))' <<<"$zh_json")"
}
read_zh_dry_run
echo "Stale zh lessons: $zh_stale"
echo "API chars to synthesize: $zh_chars (est US\$$zh_usd)"

if [[ "$zh_stale" != "0" && "$generate" -eq 1 ]]; then
  echo
  echo "== Generate zh sprites =="
  # GCP key 由 gen-zh-audio.py 自己讀 env GCP_TTS_KEY 或 Keychain gcp-tts-thai-review
  python3 scripts/gen-zh-audio.py \
    --generate \
    --confirm-paid-api \
    --max-chars "$zh_chars" \
    --out-dir "$out_dir"
  read_zh_dry_run
fi

if [[ "$zh_stale" != "0" ]]; then
  # zh 缺料不擋 deploy：前端會 fallback 回 Worker（Sheet 剛改還沒重烤是預期常態）
  echo "WARNING: $zh_stale zh sprite lesson(s) stale; playback will fall back to the Worker for those."
fi

if [[ "$deploy" -eq 1 ]]; then
  if [[ "$missing_files" != "0" ]]; then
    echo "ERROR: refusing to deploy with $missing_files missing audio files." >&2
    exit 2
  fi

  if [[ "$skip_tests" -ne 1 ]]; then
    echo
    echo "== Tests =="
    node --test "${node_tests[@]}"
  fi

  echo
  echo "== Build Pages deploy directory =="
  rm -rf out/pages-deploy
  mkdir -p out/pages-deploy
  rsync -aL --delete "$out_dir/" out/pages-deploy/
  write_deploy_info

  symlink_count="$(find out/pages-deploy -type l -print | wc -l | tr -d ' ')"
  if [[ "$symlink_count" != "0" ]]; then
    echo "ERROR: out/pages-deploy contains symlinks." >&2
    exit 2
  fi

  echo
  echo "== Deploy Cloudflare Pages =="
  deploy_output="$(npx wrangler pages deploy out/pages-deploy --project-name thai-review --branch main 2>&1)"
  echo "$deploy_output"
  deployment_url="$(grep -Eo 'https://[0-9a-f]+\.thai-review\.pages\.dev' <<<"$deploy_output" | tail -n 1)"
  if [[ -z "$deployment_url" ]]; then
    echo "ERROR: could not find Cloudflare Pages deployment URL in wrangler output." >&2
    exit 2
  fi
  verify_deployment_readback "$deployment_url"
  print_deploy_summary_json "$deployment_url"
fi
