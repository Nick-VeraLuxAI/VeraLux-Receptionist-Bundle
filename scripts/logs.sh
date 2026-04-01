#!/usr/bin/env bash
# =============================================================================
# Tail Docker Compose logs with filters that match VeraLux JSON log shape.
#
# Voice runtime (pino): every line includes "svc":"runtime" and often call_control_id.
# Control plane: every line includes "svc":"control".
#
# Usage:
#   ./scripts/logs.sh runtime
#   ./scripts/logs.sh control
#   ./scripts/logs.sh call <call_control_id>
#   ./scripts/logs.sh voice          # runtime + STT/transcript/playback-oriented grep
#   ./scripts/logs.sh capture        # save runtime log to ./logs/capture-*.log (gitignored)
#
# Pass-through (docker compose logs):
#   ./scripts/logs.sh runtime --since 30m --tail 100
#
# Environment:
#   COMPOSE_PROJECT_NAME  default: veralux
#   COMPOSE_FILE          default: docker-compose.yml
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-veralux}"
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

VOICE_FILTER='call_control_id|"event":"stt_|stt_pipeline_diag|stt_gate_closed|stt_tuning|"event":"transcript|"event":"turn_trigger|"event":"media_|playback|LISTENING|ChunkedSTT|whisper_|dead_air|ingest|barge_in'

usage() {
  cat <<'EOF'
VeraLux — Docker log helpers (repo root: COMPOSE_PROJECT_NAME=veralux by default)

  ./scripts/logs.sh runtime [docker compose logs args]   # voice: STT, calls, media
  ./scripts/logs.sh control [args]                       # panel/API
  ./scripts/logs.sh core [args]                         # control + runtime interleaved
  ./scripts/logs.sh call <call_control_id> [args]       # one call (grep -F)
  ./scripts/logs.sh voice [args]                       # runtime + voice/STT filter
  ./scripts/logs.sh capture [path]                     # tee runtime log to ./logs/

Grep/json tips:
  docker compose -p veralux logs runtime 2>&1 | grep '"svc":"runtime"'
  docker compose -p veralux logs runtime 2>&1 | jq 'select(.event == "stt_pipeline_diag")'
  # Enable periodic pipeline JSON in .env: STT_PIPELINE_DIAG_INTERVAL_MS=2500

EOF
}

cmd="${1:-}"
shift || true

case "$cmd" in
  ""|-h|--help|help)
    usage
    ;;
  runtime)
    exec "${COMPOSE[@]}" logs -f runtime "$@"
    ;;
  control)
    exec "${COMPOSE[@]}" logs -f control "$@"
    ;;
  core)
    # Two services; docker compose accepts multiple service names
    exec "${COMPOSE[@]}" logs -f control runtime "$@"
    ;;
  call)
    id="${1:?call_control_id required (e.g. v3:uuid)}"
    shift || true
    # Fixed-string grep so ':' and UUIDs are safe
    exec "${COMPOSE[@]}" logs -f runtime "$@" 2>&1 | grep --line-buffered --color=always -F "$id"
    ;;
  voice)
    exec "${COMPOSE[@]}" logs -f runtime "$@" 2>&1 | grep --line-buffered --color=always -E "$VOICE_FILTER"
    ;;
  capture)
    out="${1:-}"
    mkdir -p "$ROOT/logs"
    if [[ -z "$out" ]]; then
      out="$ROOT/logs/capture-$(date -u +%Y%m%d-%H%M%S).log"
    fi
    echo "[logs.sh] Writing runtime logs to: $out" >&2
    echo "[logs.sh] Stop with Ctrl+C" >&2
    "${COMPOSE[@]}" logs -f runtime 2>&1 | tee -a "$out"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
