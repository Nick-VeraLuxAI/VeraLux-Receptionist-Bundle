# shellcheck shell=bash
# Shared by start-production.sh, stop-production.sh, status-production.sh
# Docker Compose v2 plugin only — never invoke docker-compose v1.

# Pick a docker(1) that has `docker compose` (v2 plugin). Never return a docker without compose:
# /usr/bin/docker from distro packages often lacks the plugin until docker-compose-plugin is installed.
#
# Override: export VERALUX_DOCKER_BIN=/full/path/to/docker before start-production.sh
veralux_resolve_docker_bin() {
  local d
  declare -A _vl_seen=()

  _vl_docker_has_compose() {
    d="${1:?}"
    [[ -n "${_vl_seen[$d]:-}" ]] && return 1
    _vl_seen[$d]=1
    [[ -x "$d" ]] || return 1
    "$d" compose version &>/dev/null
  }

  if [[ -n "${VERALUX_DOCKER_BIN:-}" && -x "${VERALUX_DOCKER_BIN}" ]]; then
    if _vl_docker_has_compose "${VERALUX_DOCKER_BIN}"; then
      printf '%s\n' "${VERALUX_DOCKER_BIN}"
      return 0
    fi
    echo "[warn] VERALUX_DOCKER_BIN=${VERALUX_DOCKER_BIN} has no working 'docker compose' — trying others" >&2
  fi

  for d in /usr/local/bin/docker /usr/bin/docker /bin/docker /snap/bin/docker; do
    if _vl_docker_has_compose "$d"; then
      printf '%s\n' "$d"
      return 0
    fi
  done

  local search_path
  search_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:${PATH:-}"
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    if _vl_docker_has_compose "$d"; then
      printf '%s\n' "$d"
      return 0
    fi
  done < <(PATH="$search_path" type -ap docker 2>/dev/null || true)

  return 1
}

# Load env for compose variable interpolation; set path for docker-compose.production.yml env_file:.
# Args: path to env file (merged or /etc).
veralux_compose_prepare_env() {
  local envfile="${1:?env file required}"
  export VERALUX_COMPOSE_ENV_FILE="$envfile"
  # Avoid sourced env turning `compose` into a command that resolves to docker-compose v1.
  shopt -u expand_aliases 2>/dev/null || true
  set -a
  # shellcheck disable=SC1090
  source "$envfile"
  set +a
  shopt -u expand_aliases 2>/dev/null || true
  unset -f compose 2>/dev/null || true
  unset compose 2>/dev/null || true
}

veralux_compose() {
  [[ -n "${PROD_ROOT:-}" ]] || {
    echo "[error] PROD_ROOT unset" >&2
    return 1
  }
  local docker_bin
  docker_bin="$(veralux_resolve_docker_bin)" || {
    echo "[error] docker CLI not found (tried VERALUX_DOCKER_BIN, /usr/local/bin/docker, /usr/bin/docker, PATH)" >&2
    return 1
  }
  "$docker_bin" compose \
    -f "${PROD_ROOT}/docker-compose.yml" \
    -f "${PROD_ROOT}/docker-compose.production.yml" \
    -p veralux \
    "$@"
}
