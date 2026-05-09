#!/usr/bin/env bash
# Remove expired Raw Audio Diagnostics trees under AUDIO_FORENSICS_DIR (or first arg).
# Preserves quality summaries in Postgres (this script only touches filesystem).
# Usage: ./scripts/cleanup-call-quality-artifacts.sh [--dry-run] [FORENSICS_ROOT]

set -euo pipefail

DRY=0
ROOT=""
for a in "$@"; do
  if [[ "$a" == "--dry-run" ]]; then
    DRY=1
  elif [[ -z "$ROOT" ]]; then
    ROOT="$a"
  fi
done

if [[ -z "${ROOT}" ]]; then
  ROOT="${AUDIO_FORENSICS_DIR:-/data/veralux/voice/forensics}"
fi

if [[ ! -d "$ROOT" ]]; then
  echo "[cleanup-call-quality-artifacts] root not a directory: $ROOT"
  exit 0
fi

NOW_TS=$(date +%s)
CUTOFF_SECS=$((24 * 3600)) # default: remove sessions older than 24h (pilot / diagnostics churn)

echo "[cleanup-call-quality-artifacts] root=$ROOT dry_run=$DRY max_age_secs=$CUTOFF_SECS"

while IFS= read -r -d '' dir; do
  mtime=$(stat -c %Y "$dir" 2>/dev/null || echo 0)
  age=$((NOW_TS - mtime))
  if (( age >= CUTOFF_SECS )); then
    if [[ "$DRY" == 1 ]]; then
      echo "would delete: $dir (age ${age}s)"
    else
      rm -rf "$dir"
      echo "deleted: $dir"
    fi
  fi
done < <(find "$ROOT" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null || true)
