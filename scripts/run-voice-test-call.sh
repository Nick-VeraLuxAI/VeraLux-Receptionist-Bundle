#!/usr/bin/env bash
# One-command VeraLux voice forensic test: preflight → live watcher → post-call analysis.
# Does not change runtime STT/TTS/audio logic. Does not bundle .env files.
# Limitations: --enable-forensics appends AUDIO_FORENSICS_DIR=/app/audio/forensics (adjust /etc if your deploy differs);
#   requires sudo + /etc/veralux/voice-runtime.env. Multi-call uses RUN_DIR/call-N/ (not a flat -callN suffix on OUT_BASE alone).
# Usage: ./scripts/run-voice-test-call.sh [--duration SEC] [--label SLUG] [--calls N] [--out DIR]
#         [--call-id ID] [--no-prompt] [--dry-run] [--enable-forensics] [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DURATION=180
LABEL=""
CALLS=1
OUT_BASE="/tmp/veralux-live-tests"
CALL_FILTER=""
DRY_RUN=0
NO_PROMPT=0
ENABLE_FORENSICS=0
ALLOW_OLD_SESSION=0
DEBUG_SESSION_SELECTION=0
VOICE_ENV_FILE="${VERALUX_VOICE_ENV_FILE:-/etc/veralux/voice-runtime.env}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/run-voice-test-call.sh
  ./scripts/run-voice-test-call.sh --duration 240
  ./scripts/run-voice-test-call.sh --label echo-test-1
  ./scripts/run-voice-test-call.sh --calls 3
  ./scripts/run-voice-test-call.sh --out /tmp/veralux-live-tests
  ./scripts/run-voice-test-call.sh --call-id 'v3:...'
  ./scripts/run-voice-test-call.sh --dry-run
  ./scripts/run-voice-test-call.sh --no-prompt
  ./scripts/run-voice-test-call.sh --enable-forensics   # sudo: enable forensics in voice env + restart (see script)

Flags:
  --duration SEC     Watcher window per call (default 180)
  --label SLUG       Run directory name segment (default: voice-test)
  --calls N          Number of sequential calls (default 1)
  --out DIR          Base output directory (default /tmp/veralux-live-tests)
  --call-id ID       Passed to live-call-test-watch.sh for forensics filter
  --no-prompt        Do not wait for Enter between calls (--calls > 1)
  --dry-run          Preflight only; no watcher or analysis
  --enable-forensics If forensics disabled: sudo-append safe keys to VERALUX_VOICE_ENV_FILE and run start-production.sh
  --allow-old-session  Allow selecting a forensics session older than the current call window (default: reject stale)
  --debug-session-selection  Print candidate timeline.jsonl paths, mtimes, and selection (stderr)
  -h, --help         This help
USAGE
}

resolve_repo_root() {
  if [[ -f "$SCRIPT_DIR/../scripts/live-call-test-watch.sh" ]]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    return 0
  fi
  if [[ -f "$(pwd)/scripts/live-call-test-watch.sh" ]]; then
    REPO_ROOT="$(cd "$(pwd)" && pwd)"
    return 0
  fi
  echo "[error] Could not resolve repo root (expected scripts/live-call-test-watch.sh)." >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="${2:?}"; shift 2 ;;
    --label) LABEL="${2:?}"; shift 2 ;;
    --calls) CALLS="${2:?}"; shift 2 ;;
    --out) OUT_BASE="${2:?}"; shift 2 ;;
    --call-id) CALL_FILTER="${2:?}"; shift 2 ;;
    --no-prompt) NO_PROMPT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --enable-forensics) ENABLE_FORENSICS=1; shift ;;
    --allow-old-session) ALLOW_OLD_SESSION=1; shift ;;
    --debug-session-selection) DEBUG_SESSION_SELECTION=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

resolve_repo_root

WATCHER_SH="$REPO_ROOT/scripts/live-call-test-watch.sh"
ANALYZE_SH="$REPO_ROOT/scripts/analyze-audio-forensics.sh"
START_PROD_SH="$REPO_ROOT/scripts/start-production.sh"
SELECTOR_PY="$REPO_ROOT/scripts/lib/select_forensics_session.py"
SUMMARY_PY="$REPO_ROOT/scripts/lib/generate_combined_summary.py"

LABEL_SLUG="${LABEL:-voice-test}"
LABEL_SLUG="$(echo -n "$LABEL_SLUG" | tr -c 'A-Za-z0-9._-' '_' | sed 's/^_//;s/_$//')"
[[ -z "$LABEL_SLUG" ]] && LABEL_SLUG="voice-test"

if ! [[ "$CALLS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[error] --calls must be a positive integer" >&2
  exit 1
fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [[ "$DURATION" -lt 10 ]]; then
  echo "[error] --duration must be an integer >= 10" >&2
  exit 1
fi

redact_url_val() {
  local v="${1:-}"
  [[ -z "$v" ]] && { printf '(unset)\n'; return; }
  if [[ "$v" =~ ^https?://([^/?#]+) ]]; then
    printf '%s (URL host only)\n' "${BASH_REMATCH[1]}"
    return
  fi
  printf '(set, %s chars)\n' "${#v}"
}

runtime_env_line() {
  local var="$1"
  local val
  val="$(docker exec veralux-runtime sh -c "printf '%s' \"\${$var:-}\"" 2>/dev/null || true)"
  case "$var" in
    WHISPER_URL|CHATTERBOX_URL|OPENAI_API_KEY|TELNYX_API_KEY|MEDIA_STREAM_TOKEN|JWT_SECRET|ADMIN_API_KEY|SECRET_ENCRYPTION_KEY|POSTGRES_PASSWORD)
      printf '%s=%s\n' "$var" "$(redact_url_val "$val")"
      ;;
    *)
      printf '%s=%s\n' "$var" "${val:-(unset)}"
      ;;
  esac
}

preflight() {
  echo "=== VeraLux run-voice-test-call preflight ==="
  echo "repo_root: $REPO_ROOT"

  if ! command -v docker &>/dev/null; then
    echo "[error] docker not found in PATH" >&2
    return 1
  fi
  if ! docker info &>/dev/null; then
    echo "[error] docker daemon not reachable" >&2
    return 1
  fi
  if ! docker inspect veralux-runtime &>/dev/null; then
    echo "[error] container veralux-runtime is not running" >&2
    return 1
  fi

  if [[ ! -f "$WATCHER_SH" ]]; then
    echo "[error] missing $WATCHER_SH" >&2
    return 1
  fi
  if [[ ! -f "$ANALYZE_SH" ]]; then
    echo "[error] missing $ANALYZE_SH" >&2
    return 1
  fi
  if [[ ! -x "$WATCHER_SH" ]]; then
    echo "[warn] live-call-test-watch.sh is not executable; chmod +x recommended" >&2
  fi
  if [[ ! -x "$ANALYZE_SH" ]]; then
    echo "[warn] analyze-audio-forensics.sh is not executable; chmod +x recommended" >&2
  fi

  echo ""
  echo "=== HTTP health (localhost:4001) ==="
  if ! curl -sS -m 4 -o /dev/null "http://localhost:4001/health" 2>/dev/null; then
    echo "[error] curl http://localhost:4001/health failed" >&2
    return 1
  fi
  echo "[ok] /health responded (body not saved)"
  if ! curl -sS -m 4 -o /dev/null "http://localhost:4001/health/voice" 2>/dev/null; then
    echo "[error] curl http://localhost:4001/health/voice failed" >&2
    return 1
  fi
  echo "[ok] /health/voice responded (body not saved)"

  echo ""
  echo "=== Runtime env (non-secret redaction for URLs) ==="
  local fe fd fp es gr cap miss=0
  fe="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_ENABLED:-}"' 2>/dev/null || true)"
  fd="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_DIR:-}"' 2>/dev/null || true)"
  fp="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_ALLOW_PII:-}"' 2>/dev/null || true)"
  es="$(docker exec veralux-runtime sh -c 'printf %s "${STT_ECHO_SUPPRESSION_MODE:-}"' 2>/dev/null || true)"
  gr="$(docker exec veralux-runtime sh -c 'printf %s "${STT_POST_PLAYBACK_GRACE_MS:-}"' 2>/dev/null || true)"
  cap="$(docker exec veralux-runtime sh -c 'printf %s "${STT_CAPTURE_DURING_POST_PLAYBACK_GRACE:-}"' 2>/dev/null || true)"

  runtime_env_line AUDIO_FORENSICS_ENABLED
  runtime_env_line AUDIO_FORENSICS_DIR
  runtime_env_line AUDIO_FORENSICS_ALLOW_PII
  runtime_env_line STT_ECHO_SUPPRESSION_MODE
  runtime_env_line STT_POST_PLAYBACK_GRACE_MS
  runtime_env_line STT_CAPTURE_DURING_POST_PLAYBACK_GRACE

  if [[ -z "${fe:-}" ]]; then
    echo "[warn] AUDIO_FORENSICS_ENABLED is empty in container"
    miss=1
  fi
  if [[ -z "${fd:-}" ]]; then
    echo "[warn] AUDIO_FORENSICS_DIR is empty in container"
    miss=1
  fi
  if [[ "${fe:-}" != "true" && "${fe:-}" != "1" ]]; then
    echo "[warn] AUDIO_FORENSICS_ENABLED is not true (forensics may be off)"
    miss=1
  fi

  if [[ "$miss" == "1" ]] && [[ "$ENABLE_FORENSICS" != "1" ]] && [[ "$DRY_RUN" != "1" ]]; then
    echo ""
    echo "[error] Forensics not enabled in runtime. Options:"
    echo "  1) Enable AUDIO_FORENSICS_ENABLED=true (and AUDIO_FORENSICS_DIR) in voice env, restart runtime, re-run."
    echo "  2) Re-run with --enable-forensics to append safe lines to $VOICE_ENV_FILE and restart via start-production.sh (requires sudo)."
    exit 1
  fi
  if [[ "$miss" == "1" ]] && [[ "$DRY_RUN" == "1" ]]; then
    echo "[warn] dry-run: would fail real run without forensics or --enable-forensics"
  fi

  return 0
}

maybe_enable_forensics() {
  [[ "$ENABLE_FORENSICS" == "1" ]] || return 0
  echo ""
  echo "=== --enable-forensics: updating $VOICE_ENV_FILE and restarting ==="
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] would sudo-append forensics keys and run start-production.sh"
    return 0
  fi
  if ! command -v sudo &>/dev/null; then
    echo "[error] sudo not found; cannot modify $VOICE_ENV_FILE" >&2
    exit 1
  fi
  sudo test -f "$VOICE_ENV_FILE" || {
    echo "[error] missing $VOICE_ENV_FILE (set VERALUX_VOICE_ENV_FILE if different)" >&2
    exit 1
  }
  local appended=0
  if sudo grep -qE '^[[:space:]]*AUDIO_FORENSICS_ENABLED=(true|1)' "$VOICE_ENV_FILE" 2>/dev/null; then
    echo "[info] $VOICE_ENV_FILE already has AUDIO_FORENSICS_ENABLED=true"
  else
    echo "[info] appending minimal forensics block to $VOICE_ENV_FILE"
    sudo tee -a "$VOICE_ENV_FILE" >/dev/null <<'BLOCK'

# --- Added by run-voice-test-call.sh --enable-forensics (safe keys only) ---
AUDIO_FORENSICS_ENABLED=true
AUDIO_FORENSICS_DIR=/app/audio/forensics
BLOCK
    appended=1
  fi
  local fe
  fe="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_ENABLED:-}"' 2>/dev/null || true)"
  if [[ "$appended" == "1" ]] || [[ "${fe:-}" != "true" && "${fe:-}" != "1" ]]; then
    (cd "$REPO_ROOT" && sudo -E VERALUX_VOICE_ENV_FILE="$VOICE_ENV_FILE" "$START_PROD_SH") || {
      echo "[error] start-production.sh failed" >&2
      exit 1
    }
    echo "[ok] restart issued; waiting for runtime health..."
    local i
    for i in $(seq 1 30); do
      if curl -sS -m 2 -o /dev/null "http://localhost:4001/health" 2>/dev/null; then
        echo "[ok] health is up"
        return 0
      fi
      sleep 2
    done
    echo "[warn] health did not become ready quickly; continue at your own risk" >&2
  else
    echo "[info] runtime already reports AUDIO_FORENSICS_ENABLED; skipping restart"
  fi
}

fallback_copy_forensics() {
  local dest_parent="${1:?}"
  local cutoff_epoch="${2:?}"
  local root remote_sess
  root="$(docker exec veralux-runtime sh -c 'printf %s "${AUDIO_FORENSICS_DIR:-/app/audio/forensics}"')"
  docker cp "${SELECTOR_PY}" "veralux-runtime:/tmp/select_forensics_session.py" 2>/dev/null || true
  local -a dex=(docker exec veralux-runtime python3 /tmp/select_forensics_session.py --search-root "$root" --cutoff-epoch "$cutoff_epoch")
  [[ "$ALLOW_OLD_SESSION" == "1" ]] && dex+=(--allow-old-session)
  [[ "$DEBUG_SESSION_SELECTION" == "1" ]] && dex+=(--debug)
  remote_sess="$("${dex[@]}")"
  if [[ -z "$remote_sess" ]]; then
    echo "[error] no suitable forensics session in container under $root" >&2
    return 1
  fi
  mkdir -p "${dest_parent}/forensics_runtime_copy"
  docker cp "veralux-runtime:${remote_sess}" "${dest_parent}/forensics_runtime_copy/session" || return 1
  python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "${dest_parent}/forensics_runtime_copy/session"
}

# Select session dir: sort_key from folder ISO name or timeline mtime; optional cutoff (UTC epoch).
# Args: search_root... use $@ after --
select_forensic_session_dir() {
  local cutoff_epoch="${1:?}"
  shift
  local -a roots=("$@")
  if [[ ! -f "$SELECTOR_PY" ]]; then
    echo "[error] missing $SELECTOR_PY" >&2
    return 1
  fi
  local -a py=(python3 "$SELECTOR_PY")
  local r
  for r in "${roots[@]}"; do
    [[ -e "$r" ]] || continue
    py+=(--search-root "$r")
  done
  py+=(--cutoff-epoch "$cutoff_epoch")
  [[ "$ALLOW_OLD_SESSION" == "1" ]] && py+=(--allow-old-session)
  [[ "$DEBUG_SESSION_SELECTION" == "1" ]] && py+=(--debug)
  "${py[@]}"
}

run_one_call() {
  local call_idx="${1:?}"
  local call_dir="${2:?}"
  local health_out="${3:?}"

  mkdir -p "$call_dir"
  curl -sS -m 4 -o "$health_out" "http://localhost:4001/health" 2>/dev/null || echo '{"error":"health failed"}' >"$health_out"
  curl -sS -m 4 -o "${health_out%.json}-voice.json" "http://localhost:4001/health/voice" 2>/dev/null || echo '{"error":"health/voice failed"}' >"${health_out%.json}-voice.json"

  echo "" >&2
  echo "Watcher is running. Place the test call now." >&2
  echo "  output: $call_dir (watcher adds a timestamped subfolder)" >&2
  local watch_args=(--duration "$DURATION" --out "$call_dir")
  [[ -n "$CALL_FILTER" ]] && watch_args+=(--call-id "$CALL_FILTER")

  # UTC epoch seconds: sessions with folder-embedded time (or mtime) before this are rejected unless --allow-old-session.
  local call_window_start
  call_window_start="$(date -u +%s)"
  # Small skew buffer so a session starting in the same second is not dropped.
  local cutoff_epoch=$((call_window_start > 3 ? call_window_start - 3 : 0))

  bash "$WATCHER_SH" "${watch_args[@]}" >&2

  # Newest watcher child dir by embedded UTC timestamp or mtime (not string sort).
  local -a wb_py=(python3 "$SELECTOR_PY" --pick-watcher-bundle "$call_dir")
  [[ "$DEBUG_SESSION_SELECTION" == "1" ]] && wb_py+=(--debug)
  local watcher_bundle
  watcher_bundle="$("${wb_py[@]}")"
  if [[ -z "$watcher_bundle" ]]; then
    echo "[error] no watcher output dir under $call_dir" >&2
    return 1
  fi

  local -a search_roots=("$watcher_bundle")
  if [[ -d "$watcher_bundle/forensics_copy" ]]; then
    search_roots+=("$watcher_bundle/forensics_copy")
  fi

  local timeline_dir
  timeline_dir="$(select_forensic_session_dir "$cutoff_epoch" "${search_roots[@]}")"
  if [[ -z "$timeline_dir" ]]; then
    echo "[warn] no timeline matching cutoff (since UTC ~ $call_window_start); trying docker cp fallback..." >&2
    if ! fallback_copy_forensics "$watcher_bundle" "$cutoff_epoch"; then
      return 1
    fi
    search_roots+=("$watcher_bundle/forensics_runtime_copy")
    timeline_dir="$(select_forensic_session_dir "$cutoff_epoch" "${search_roots[@]}")"
  fi

  if [[ -z "$timeline_dir" ]]; then
    echo "[error] could not select a forensics session (timeline.jsonl). Re-run with --allow-old-session if you must analyze an older session." >&2
    return 1
  fi

  echo "[info] forensics session: $timeline_dir" >&2
  bash "$ANALYZE_SH" "$timeline_dir" >&2

  printf '%s\n' "$timeline_dir"
}

print_analysis_paths() {
  local analysis="${1:?}"
  echo "Analysis artifacts:"
  for f in issues_detected.md transcript_comparison.md echo_similarity.md timing_alignment.md recommended_next_steps.md; do
    if [[ -f "$analysis/$f" ]]; then
      echo "  $analysis/$f"
    fi
  done
  if [[ -f "$analysis/HUMAN_DIAGNOSIS.md" ]]; then
    echo "  $analysis/HUMAN_DIAGNOSIS.md"
  fi
}

MAIN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${OUT_BASE%/}/${MAIN_TS}-${LABEL_SLUG}"

echo "=== run-voice-test-call ==="
echo "run_dir: $RUN_DIR"
echo "calls: $CALLS  duration: ${DURATION}s  label: $LABEL_SLUG  dry_run: $DRY_RUN"

preflight || exit 1
maybe_enable_forensics
if [[ "$ENABLE_FORENSICS" == "1" ]] && [[ "$DRY_RUN" != "1" ]]; then
  preflight || exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "[dry-run] preflight OK. Would create:"
  for ((i=1; i<=CALLS; i++)); do
    echo "  $RUN_DIR/call-$i/ -> watcher -> analyze -> $RUN_DIR/COMBINED_TEST_SUMMARY.md"
  done
  exit 0
fi

mkdir -p "$RUN_DIR"
if [[ ! -f "$SELECTOR_PY" ]]; then
  echo "[error] missing $SELECTOR_PY" >&2
  exit 1
fi
if [[ ! -f "$SUMMARY_PY" ]]; then
  echo "[error] missing $SUMMARY_PY" >&2
  exit 1
fi

CALL_META_JSONL="$RUN_DIR/call_meta.jsonl"
: >"$CALL_META_JSONL"
ANALYSIS_PATHS=()
CALL_FAILURES=0

for ((i=1; i<=CALLS; i++)); do
  if [[ "$i" -gt 1 ]] && [[ "$NO_PROMPT" != "1" ]]; then
    echo ""
    read -r -p "Press Enter when ready for call $i ..." || true
  fi
  CDIR="$RUN_DIR/call-$i"
  HST="$CDIR/preflight_health_call-${i}.json"
  mkdir -p "$CDIR"
  TL=""
  ANALYSIS=""
  STATUS="ok"
  if TL="$(run_one_call "$i" "$CDIR" "$HST")"; then
    ANALYSIS="$TL/analysis"
    ANALYSIS_PATHS+=("$ANALYSIS")
    print_analysis_paths "$ANALYSIS"
  else
    STATUS="failed"
    CALL_FAILURES=$((CALL_FAILURES + 1))
    echo "[warn] call $i workflow failed; continuing to combined summary generation." >&2
  fi
  python3 -c "import json,sys; print(json.dumps({'call':$i,'call_dir':sys.argv[1],'timeline_dir':sys.argv[2],'analysis':sys.argv[3],'status':sys.argv[4]}))" "$CDIR" "$TL" "$ANALYSIS" "$STATUS" >>"$CALL_META_JSONL"
done

COMBINED="$RUN_DIR/COMBINED_TEST_SUMMARY.md"
if ! python3 "$SUMMARY_PY" \
  --out "$COMBINED" \
  --run-dir "$RUN_DIR" \
  --meta "$CALL_META_JSONL" \
  --generated-utc "$MAIN_TS" \
  --calls "$CALLS" \
  --label "$LABEL_SLUG"; then
  {
    echo "# VeraLux combined voice test summary"
    echo ""
    echo "- generated_utc: $MAIN_TS"
    echo "- label: $LABEL_SLUG"
    echo "- calls_requested: $CALLS"
    echo "- run_dir: \`$RUN_DIR\`"
    echo ""
    echo "Summary helper failed. See call metadata:"
    echo "- \`$CALL_META_JSONL\`"
  } >"$COMBINED"
  echo "[warn] summary helper failed; wrote fallback summary: $COMBINED" >&2
fi

echo ""
echo "================ COPY/PASTE FOR CURSOR ANALYSIS ================"
echo "Analyze these call test outputs:"
for ap in "${ANALYSIS_PATHS[@]}"; do
  echo "- $ap"
done
echo "- $COMBINED"
echo "Please determine whether echo contamination is resolved, whether LLM inputs were clean, whether audio quality or latency remains a concern, and what exact next changes are justified by evidence."
echo "================================================================"

if [[ "$CALL_FAILURES" -gt 0 ]]; then
  echo "[warn] $CALL_FAILURES call(s) failed during watcher/analyzer steps. Combined summary was still generated at: $COMBINED" >&2
fi
