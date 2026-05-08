# shellcheck shell=bash
# Shared by start-production.sh, stop-production.sh, status-production.sh
# Docker Compose v2 plugin only — never invoke docker-compose v1.

# Load env for compose variable interpolation; set path for docker-compose.production.yml env_file:.
# Args: path to env file (merged or /etc).
veralux_compose_prepare_env() {
  local envfile="${1:?env file required}"
  export VERALUX_COMPOSE_ENV_FILE="$envfile"
  set -a
  # shellcheck disable=SC1090
  source "$envfile"
  set +a
  # Legacy env / aliases use `compose` → docker-compose v1; breaks callers.
  unset -f compose 2>/dev/null || true
  unset compose 2>/dev/null || true
}

veralux_compose() {
  [[ -n "${PROD_ROOT:-}" ]] || {
    echo "[error] PROD_ROOT unset" >&2
    return 1
  }
  command docker compose \
    -f "${PROD_ROOT}/docker-compose.yml" \
    -f "${PROD_ROOT}/docker-compose.production.yml" \
    -p veralux \
    "$@"
}
