#!/usr/bin/env bash
# Post-call forensic analyzer for a copied forensics session directory.
# Usage: ./scripts/analyze-audio-forensics.sh <call-folder | call.zip | call_control_id>
# Does not read .env. Optional zip unpacks to a temp dir (excludes *.env patterns when unzipping if possible).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZER_PY="$SCRIPT_DIR/lib/veralux_forensics_analyze.py"

if [[ $# -lt 1 ]] || [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0 <call-folder | bundle.zip | call_control_id>"
  exit 0
fi

ARG="${1:?}"

abspath() {
  local p="${1:?}"
  if command -v realpath &>/dev/null; then
    realpath "$p"
  else
    python3 -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$p"
  fi
}

resolve_call_folder() {
  local a="$1"

  if [[ -f "$a" ]] && [[ "$a" == *.zip ]]; then
    local tmp
    tmp="$(mktemp -d)"
    unzip -q "$a" -x "*.env" -x "*/.env" -x "*/.env.*" -d "$tmp" || {
      echo "error: unzip failed: $a" >&2
      rm -rf "$tmp"
      exit 1
    }
    local t
    t="$(find "$tmp" -name timeline.jsonl -type f 2>/dev/null | head -1)"
    if [[ -z "$t" ]]; then
      echo "error: no timeline.jsonl in zip" >&2
      rm -rf "$tmp"
      exit 1
    fi
    abspath "$(dirname "$t")"
    return 0
  fi

  if [[ -d "$a" ]] && [[ -f "$a/timeline.jsonl" ]]; then
    abspath "$a"
    return 0
  fi

  # call_control_id or short id (no slash)
  if [[ "$a" != */* ]]; then
    local id="$a"
    local bases=(/tmp/veralux-forensics /tmp/veralux-live-tests)
    local safe
    safe="$(echo -n "$id" | tr -c 'A-Za-z0-9._-' '_')"
    local base f f2
    for base in "${bases[@]}"; do
      [[ -d "$base" ]] || continue
      f="$(find "$base" -path "*/${id}/*" -name timeline.jsonl -type f 2>/dev/null | sort | tail -1)"
      if [[ -n "$f" ]]; then
        abspath "$(dirname "$f")"
        return 0
      fi
    done
    for base in "${bases[@]}"; do
      [[ -d "$base" ]] || continue
      f2="$(find "$base" -path "*/${safe}/*" -name timeline.jsonl -type f 2>/dev/null | sort | tail -1)"
      if [[ -n "$f2" ]]; then
        abspath "$(dirname "$f2")"
        return 0
      fi
    done

    if docker inspect veralux-runtime &>/dev/null; then
      local root remote dest
      root="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_DIR:-/data/veralux/voice/forensics}"')"
      remote="$(docker exec \
        -e ROOT="$root" -e CID="$id" -e CSafe="$safe" \
        veralux-runtime sh -c \
        'find "$ROOT" \( -path "*/${CID}/*" -o -path "*/${CSafe}/*" \) -name timeline.jsonl -type f 2>/dev/null | sort | tail -1')"
      if [[ -n "$remote" ]]; then
        dest="$(mktemp -d)"
        docker cp "veralux-runtime:$(dirname "$remote")" "$dest/session" || {
          echo "error: docker cp failed for $remote" >&2
          rm -rf "$dest"
          exit 1
        }
        abspath "$dest/session"
        return 0
      fi
    fi
  fi

  echo "error: cannot resolve forensics folder for: $a" >&2
  echo "hint: pass a directory containing timeline.jsonl, a zip of a call tree, or a call id under /tmp/veralux-forensics or /tmp/veralux-live-tests" >&2
  exit 1
}

if [[ ! -f "$ANALYZER_PY" ]]; then
  echo "error: missing $ANALYZER_PY" >&2
  exit 1
fi

CALL_FOLDER="$(resolve_call_folder "$ARG")"
python3 "$ANALYZER_PY" "$CALL_FOLDER"
echo "Analysis written to: $CALL_FOLDER/analysis/"
