#!/usr/bin/env bash
# Post-up checks for a deployment profile (no secrets printed).
# Usage: ./scripts/validate-profile.sh --profile local-gpu|cloud-api|hybrid [--env-file PATH …] [--fragment-env PATH …]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE=""
ENV_FILES=()
FRAGMENT_ENVS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --env-file) ENV_FILES+=("${2:-}"); shift 2 ;;
    --fragment-env)
      [[ -n "${2:-}" ]] || { echo "[error] --fragment-env requires a path" >&2; exit 2; }
      [[ -f "$2" ]] || { echo "[FAIL] fragment env file not found: $2" >&2; exit 1; }
      FRAGMENT_ENVS+=("$2")
      shift 2
      ;;
    *) echo "[error] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  echo "[error] --profile required" >&2
  exit 2
fi

read_kv() {
  local key="$1" val="" line f
  for f in .env .env.internal; do
    [[ -f "$ROOT/$f" ]] || continue
    line=$(grep "^${key}=" "$ROOT/$f" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then val="${line#${key}=}"; fi
  done
  for f in "${ENV_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    line=$(grep "^${key}=" "$f" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then val="${line#${key}=}"; fi
  done
  for f in "${FRAGMENT_ENVS[@]}"; do
    [[ -f "$f" ]] || continue
    line=$(grep "^${key}=" "$f" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then val="${line#${key}=}"; fi
  done
  echo "$val" | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | xargs
}

CONTROL_PORT="$(read_kv CONTROL_PORT)"
RUNTIME_PORT="$(read_kv RUNTIME_PORT)"
CONTROL_PORT="${CONTROL_PORT:-4000}"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"
HEALTH_VOICE="$(read_kv HEALTH_VOICE_DEPENDENCIES)"

check_http() {
  local name="$1" url="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || echo "000")"
  if [[ "$code" =~ ^2 ]]; then
    echo "[ OK ] $name → HTTP $code"
  else
    echo "[WARN] $name → HTTP $code ($url)"
  fi
}

echo "[info] docker compose ps (project veralux)"
docker compose -p veralux ps 2>/dev/null || true

check_http "control /health" "http://127.0.0.1:${CONTROL_PORT}/health"
check_http "control /ready" "http://127.0.0.1:${CONTROL_PORT}/ready"
check_http "runtime /health/live" "http://127.0.0.1:${RUNTIME_PORT}/health/live"
check_http "runtime /health/voice" "http://127.0.0.1:${RUNTIME_PORT}/health/voice"

if [[ "$PROFILE" == "cloud-api" ]]; then
  hv="$(echo "${HEALTH_VOICE:-strict}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$hv" == "configured" || "$hv" == "disabled" ]]; then
    echo "[info] cloud-api: HEALTH_VOICE_DEPENDENCIES=$hv — /health/voice may succeed without local-style provider /health endpoints"
  fi
fi

echo "[ OK ] validate-profile: $PROFILE complete"
