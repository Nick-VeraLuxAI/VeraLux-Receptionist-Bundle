#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.test.yml"
PROJECT_NAME="veralux-test"

DATABASE_URL="${DATABASE_URL:-postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56379}"

POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-55432}"
POSTGRES_USER="${POSTGRES_USER:-veralux_test}"
POSTGRES_DB="${POSTGRES_DB:-veralux_test}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-veralux_test}"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-56379}"

dc() {
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" "$@"
}

usage() {
  cat <<'EOF'
Usage: ./scripts/test-infra.sh <command>

Commands:
  up      Start isolated postgres-test and redis-test containers
  wait    Wait for health + verify host reachability and basic queries
  status  Show compose status
  logs    Show compose logs
  reset   Reset Postgres schema and flush Redis
  down    Stop and remove test containers/network
EOF
}

wait_for_tcp() {
  local host="$1" port="$2" name="$3"
  local tries=60
  for _ in $(seq 1 "${tries}"); do
    if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      echo "[test-infra] ${name} TCP reachable at ${host}:${port}"
      return 0
    fi
    sleep 1
  done
  echo "[test-infra] ERROR: ${name} TCP not reachable at ${host}:${port}" >&2
  return 1
}

wait_for_health() {
  local service="$1"
  local tries=60
  for _ in $(seq 1 "${tries}"); do
    local status
    status="$(dc ps --format json "${service}" | node -e 'const fs=require("fs");const s=fs.readFileSync(0,"utf8").trim();if(!s){process.exit(2)};const j=JSON.parse(s);process.stdout.write(String(j.Health||""))' || true)"
    if [[ "${status}" == "healthy" ]]; then
      echo "[test-infra] ${service} is healthy"
      return 0
    fi
    sleep 1
  done
  echo "[test-infra] ERROR: ${service} did not become healthy" >&2
  dc logs "${service}" || true
  return 1
}

verify_postgres() {
  if ! command -v psql >/dev/null 2>&1; then
    echo "[test-infra] psql not found on host; using docker exec for query check"
    dc exec -T postgres-test psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "SELECT 1;" >/dev/null
    return 0
  fi
  PGPASSWORD="${POSTGRES_PASSWORD}" psql "${DATABASE_URL}" -c "SELECT 1;" >/dev/null
}

verify_redis() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping | grep -Eq "^PONG$"
    return 0
  fi
  echo "[test-infra] redis-cli not found on host; using docker exec for ping check"
  dc exec -T redis-test redis-cli ping | grep -Eq "^PONG$"
}

cmd="${1:-}"
case "${cmd}" in
  up)
    dc up -d postgres-test redis-test
    ;;
  wait)
    wait_for_health postgres-test
    wait_for_health redis-test
    wait_for_tcp "${POSTGRES_HOST}" "${POSTGRES_PORT}" "postgres-test"
    wait_for_tcp "${REDIS_HOST}" "${REDIS_PORT}" "redis-test"
    verify_postgres
    echo "[test-infra] postgres query check passed"
    verify_redis
    echo "[test-infra] redis ping check passed"
    ;;
  status)
    dc ps
    ;;
  logs)
    dc logs --tail=200
    ;;
  reset)
    wait_for_tcp "${POSTGRES_HOST}" "${POSTGRES_PORT}" "postgres-test"
    wait_for_tcp "${REDIS_HOST}" "${REDIS_PORT}" "redis-test"
    if command -v psql >/dev/null 2>&1; then
      PGPASSWORD="${POSTGRES_PASSWORD}" psql "${DATABASE_URL}" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null
    else
      dc exec -T postgres-test psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null
    fi
    if command -v redis-cli >/dev/null 2>&1; then
      redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" FLUSHALL >/dev/null
    else
      dc exec -T redis-test redis-cli FLUSHALL >/dev/null
    fi
    echo "[test-infra] reset complete"
    ;;
  down)
    dc down -v --remove-orphans
    ;;
  *)
    usage
    exit 2
    ;;
esac
