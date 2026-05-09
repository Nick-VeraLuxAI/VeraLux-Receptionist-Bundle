#!/usr/bin/env bash
# Zip all forensics timestamp subfolders for a call_control_id.
# Usage: ./scripts/collect-audio-forensics.sh <callControlId> [AUDIO_FORENSICS_DIR]
set -euo pipefail

CALL_ID="${1:?call_control_id required}"
BASE_DIR="${2:-/data/veralux/voice/forensics}"
SAFE_ID="$(echo -n "$CALL_ID" | tr -c 'A-Za-z0-9._-' '_')"
ROOT="${BASE_DIR}/${SAFE_ID}"

if [[ ! -d "$ROOT" ]]; then
  echo "error: no directory at $ROOT" >&2
  exit 1
fi

OUT="/tmp/veralux-audio-forensics-${SAFE_ID}-$(date -u +%Y%m%dT%H%M%SZ).zip"
(
  cd "$BASE_DIR" || exit 1
  zip -r "$OUT" "$SAFE_ID" \
    -x '*.env' -x '*/.env' -x '*/.env.*' \
    >/dev/null
)

echo "$OUT"
echo "Created zip (env files excluded by pattern). Review before sharing."
