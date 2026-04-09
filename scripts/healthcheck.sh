#!/usr/bin/env bash
# Stack verification from the host (after ./deploy.sh up).
#
# Default: readiness — matches Docker Compose healthchecks (dependencies up).
#   ./scripts/healthcheck.sh
#
# Liveness only (process bound; does not prove voice/DB readiness):
#   ./scripts/healthcheck.sh --liveness
#
# See HEALTH_MODEL.md for endpoint semantics.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LIVENESS_ONLY=0
if [[ "${1:-}" == "--liveness" ]]; then
  LIVENESS_ONLY=1
fi

ENV_FILE="${ENV_FILE:-.env}"
ENV_INTERNAL="${ENV_INTERNAL:-.env.internal}"
read_env_kv() {
  local key="$1" line val="" f
  for f in "$ENV_FILE" "$ENV_INTERNAL"; do
    [[ -f "$f" ]] || continue
    line=$(grep "^${key}=" "$f" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then
      val="${line#*=}"
    fi
  done
  if [[ -n "$val" ]]; then
    echo "$val" | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
  fi
}

if [[ -f "$ENV_FILE" ]] || [[ -f "$ENV_INTERNAL" ]]; then
  CONTROL_PORT="${CONTROL_PORT:-$(read_env_kv CONTROL_PORT)}"
  RUNTIME_PORT="${RUNTIME_PORT:-$(read_env_kv RUNTIME_PORT)}"
  WHISPER_PORT="${WHISPER_PORT:-$(read_env_kv WHISPER_PORT)}"
  BRAIN_PORT="${BRAIN_PORT:-$(read_env_kv BRAIN_PORT)}"
  BRAIN_USE_LOCAL="${BRAIN_USE_LOCAL:-$(read_env_kv BRAIN_USE_LOCAL)}"
fi

CONTROL_PORT="${CONTROL_PORT:-4000}"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"
WHISPER_PORT="${WHISPER_PORT:-9000}"
BRAIN_PORT="${BRAIN_PORT:-3001}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
fail=0

check_http() {
  local name="$1" url="$2" want="${3:-200}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$url" || echo "000")
  if [[ "$code" == "$want" ]]; then
    echo -e "${GREEN}OK${NC}  $name ($url) -> HTTP $code"
  else
    echo -e "${RED}FAIL${NC} $name ($url) -> HTTP $code (expected $want)"
    fail=1
  fi
}

if [[ "$LIVENESS_ONLY" -eq 1 ]]; then
  echo "Veralux stack healthcheck — ${YELLOW}LIVENESS${NC} (CONTROL_PORT=$CONTROL_PORT RUNTIME_PORT=$RUNTIME_PORT)"
  echo ""
  check_http "control /health (liveness)" "http://127.0.0.1:${CONTROL_PORT}/health"
  check_http "runtime /health/live (liveness)" "http://127.0.0.1:${RUNTIME_PORT}/health/live"
else
  echo "Veralux stack healthcheck — ${GREEN}READINESS${NC} (CONTROL_PORT=$CONTROL_PORT RUNTIME_PORT=$RUNTIME_PORT)"
  echo ""
  check_http "control /ready (DB + Redis)" "http://127.0.0.1:${CONTROL_PORT}/ready"
  check_http "runtime /health/ready (Redis + STT/TTS HTTP)" "http://127.0.0.1:${RUNTIME_PORT}/health/ready"
fi

echo ""
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${WHISPER_PORT}/health" | grep -q 200; then
  echo -e "${GREEN}OK${NC}  whisper /health (localhost:${WHISPER_PORT})"
else
  echo -e "${YELLOW}SKIP${NC} whisper /health (localhost:${WHISPER_PORT}) — not reachable (expected if audio profile not running or port not published)"
fi

if [[ "${BRAIN_USE_LOCAL:-}" == "true" ]]; then
  if curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${BRAIN_PORT}/health" | grep -q 200; then
    echo -e "${GREEN}OK${NC}  brain /health (localhost:${BRAIN_PORT}, BRAIN_USE_LOCAL=true)"
  else
    echo -e "${RED}FAIL${NC} brain /health (localhost:${BRAIN_PORT}) — BRAIN_USE_LOCAL=true but service not healthy"
    fail=1
  fi
fi

if docker info &>/dev/null; then
  unhealthy=$(docker ps --filter "name=veralux-" --format '{{.Names}}' 2>/dev/null | while read -r n; do
    st=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$n" 2>/dev/null || echo none)
    if [[ "$st" == "unhealthy" ]]; then echo "$n"; fi
  done)
  if [[ -n "${unhealthy:-}" ]]; then
    echo -e "${RED}FAIL${NC} Unhealthy containers:"
    echo "$unhealthy"
    fail=1
  else
    echo -e "${GREEN}OK${NC}  No veralux-* containers report Docker health=unhealthy"
  fi
else
  echo -e "${YELLOW}SKIP${NC} docker not available for container health inspection"
fi

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo -e "${GREEN}All critical checks passed.${NC}"
  exit 0
fi
echo -e "${RED}One or more critical checks failed.${NC}"
exit 1
