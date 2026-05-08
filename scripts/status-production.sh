#!/usr/bin/env bash
set -euo pipefail

PROJECT="${VERALUX_COMPOSE_PROJECT:-veralux}"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"

echo "=== docker ps (veralux-*) ==="
docker ps -a --filter "name=veralux-" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo ""
echo "=== GET http://127.0.0.1:${RUNTIME_PORT}/health (diagnostic) ==="
curl -sS "http://127.0.0.1:${RUNTIME_PORT}/health" | head -c 600 || echo "(unreachable)"
echo ""

echo ""
echo "=== GET http://127.0.0.1:${RUNTIME_PORT}/health/voice (strict readiness) ==="
curl -sS -o /tmp/vh.json -w 'HTTP %{http_code}\n' "http://127.0.0.1:${RUNTIME_PORT}/health/voice" || true
head -c 600 /tmp/vh.json 2>/dev/null || true
echo ""

echo ""
echo "=== compose ps ($PROJECT) ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROD_ROOT="${VERALUX_PROD_ROOT:-/opt/veralux/veralux-voice-runtime}"
VOICE_ENV="${VERALUX_VOICE_ENV_FILE:-/etc/veralux/voice-runtime.env}"
[[ -d "$PROD_ROOT" ]] || PROD_ROOT="$REPO"
if [[ -f "$VOICE_ENV" && -f "${PROD_ROOT}/docker-compose.production.yml" ]]; then
  docker compose --env-file "$VOICE_ENV" -f "${PROD_ROOT}/docker-compose.yml" -f "${PROD_ROOT}/docker-compose.production.yml" -p "$PROJECT" ps 2>/dev/null || true
fi
