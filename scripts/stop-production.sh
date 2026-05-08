#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROD_ROOT="${VERALUX_PROD_ROOT:-/opt/veralux/veralux-voice-runtime}"
VOICE_ENV="${VERALUX_VOICE_ENV_FILE:-/etc/veralux/voice-runtime.env}"
[[ -d "$PROD_ROOT" ]] || PROD_ROOT="$REPO"
[[ -f "$VOICE_ENV" ]] || {
  echo "[error] missing $VOICE_ENV"
  exit 1
}

if [[ ! -f "${SCRIPT_DIR}/veralux-compose-helper.sh" ]]; then
  echo "[error] Missing ${SCRIPT_DIR}/veralux-compose-helper.sh — sync from VeraLux-Receptionist-Bundle (see start-production.sh header)."
  exit 1
fi
# shellcheck source=veralux-compose-helper.sh
source "${SCRIPT_DIR}/veralux-compose-helper.sh"
# Do not `source` the voice env here: operator files may contain prose or unquoted spaces
# (bash would execute stray words — e.g. "are: command not found"). Compose stop only needs
# the env_file path for YAML interpolation.
export VERALUX_COMPOSE_ENV_FILE="$VOICE_ENV"

if [[ -f "${PROD_ROOT}/docker-compose.production.yml" ]]; then
  echo "[info] docker compose stop (project veralux)"
  veralux_compose stop 2>/dev/null || true
fi

mapfile -t TO_STOP < <(docker ps -q --filter "name=veralux-runtime" --filter "name=veralux-control" --filter "name=veralux-whisper" --filter "name=veralux-chatterbox" --filter "name=veralux-kokoro" --filter "name=veralux-xtts" --filter "name=veralux-qwen3" --filter "name=veralux-postgres" --filter "name=veralux-redis" --filter "name=veralux-brain" --filter "name=veralux-vllm" --filter "name=veralux-cloudflared" 2>/dev/null || true)
if [[ ${#TO_STOP[@]} -gt 0 ]]; then
  docker stop "${TO_STOP[@]}" >/dev/null 2>&1 || true
fi

echo "[ok] Stop issued for VeraLux stack (compose + named containers)."
