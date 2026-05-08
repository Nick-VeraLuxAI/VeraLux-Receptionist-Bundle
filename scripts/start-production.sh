#!/usr/bin/env bash
# =============================================================================
# VeraLux Receptionist — production bring-up (Ubuntu / VeraTitan)
#
# Authoritative paths:
#   Install root: VERALUX_PROD_ROOT=/opt/veralux/veralux-voice-runtime
#   Voice env:    VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env
#
# Applies docker-compose.yml + docker-compose.production.yml (injects env_file).
# Prefers systemd cloudflared; stops docker veralux-cloudflared when running (duplicate tunnel risk).
#
# Usage:
#   sudo VERALUX_PROD_ROOT=/opt/veralux/veralux-voice-runtime ./scripts/start-production.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROD_ROOT="${VERALUX_PROD_ROOT:-/opt/veralux/veralux-voice-runtime}"
VOICE_ENV="${VERALUX_VOICE_ENV_FILE:-/etc/veralux/voice-runtime.env}"

if [[ ! -d "$PROD_ROOT" ]]; then
  echo "[warn] PROD_ROOT $PROD_ROOT missing — falling back to this repository ($DEFAULT_REPO_ROOT)"
  PROD_ROOT="$DEFAULT_REPO_ROOT"
fi
FRAGMENT="${PROD_ROOT}/deploy/production-env-fragment.env"
if [[ ! -f "$FRAGMENT" ]]; then
  FRAGMENT="${DEFAULT_REPO_ROOT}/deploy/production-env-fragment.env"
fi

if [[ ! -f "$VOICE_ENV" ]]; then
  echo "[error] Missing voice env file: $VOICE_ENV"
  exit 1
fi

docker compose version >/dev/null 2>&1 || {
  echo "[error] docker compose plugin is required"
  exit 1
}

MERGED_ENV_TMP=""

build_effective_env() {
  if [[ -f "$FRAGMENT" ]]; then
    MERGED_ENV_TMP="$(mktemp)"
    python3 "${DEFAULT_REPO_ROOT}/scripts/merge-voice-env.py" "$VOICE_ENV" "$FRAGMENT" >"$MERGED_ENV_TMP"
    EFFECTIVE_ENV="$MERGED_ENV_TMP"
    echo "[info] Effective compose env = merge($VOICE_ENV + deploy/production-env-fragment.env) (no secrets printed)"
  else
    EFFECTIVE_ENV="$VOICE_ENV"
  fi
}

cleanup_merged_env() {
  [[ -n "${MERGED_ENV_TMP}" ]] && rm -f "${MERGED_ENV_TMP}"
}

trap cleanup_merged_env EXIT

require_nonplaceholder() {
  local key="$1"
  local line val
  line="$(grep -E "^${key}=" "$EFFECTIVE_ENV" | tail -1 || true)"
  if [[ -z "$line" ]]; then
    echo "[error] Missing $key in effective env"
    exit 1
  fi
  val="${line#*=}"
  val="${val//$'\r'/}"
  if [[ -z "${val//[[:space:]]/}" ]]; then
    echo "[error] $key is empty"
    exit 1
  fi
  if [[ "$val" == CHANGE_ME* ]]; then
    echo "[error] $key is still a CHANGE_ME placeholder"
    exit 1
  fi
}

check_required_secrets() {
  local keys=(
    POSTGRES_PASSWORD JWT_SECRET ADMIN_API_KEY SECRET_ENCRYPTION_KEY MEDIA_STREAM_TOKEN
    TELNYX_API_KEY TELNYX_PUBLIC_KEY OPENAI_API_KEY
  )
  local k
  for k in "${keys[@]}"; do
    require_nonplaceholder "$k"
  done
}

warn_placeholder_secrets() {
  local keys=(
    POSTGRES_PASSWORD JWT_SECRET ADMIN_API_KEY MEDIA_STREAM_TOKEN SECRET_ENCRYPTION_KEY
    OPENAI_API_KEY TELNYX_API_KEY TELNYX_PUBLIC_KEY
  )
  local k warned=0
  local line val
  for k in "${keys[@]}"; do
    line="$(grep -E "^${k}=" "$EFFECTIVE_ENV" | tail -1 || true)"
    [[ -z "$line" ]] && continue
    val="${line#*=}"
    if [[ "$val" == CHANGE_ME* ]] || [[ -z "${val//$'\r'/}" ]]; then
      echo "[warn] $k looks unset or CHANGE_ME_* — rotate before production (${VERALUX_VOICE_ENV_FILE})"
      warned=1
    fi
  done
  if [[ "$warned" == "1" ]] && [[ "${VERALUX_STRICT_SECRETS:-0}" == "1" ]]; then
    echo "[error] VERALUX_STRICT_SECRETS=1 — fix placeholders in voice env."
    exit 1
  fi
}

ensure_network() {
  docker network inspect veralux-network &>/dev/null || docker network create veralux-network
}

clear_stopped_name_conflicts() {
  local stale=(veralux-chatterbox veralux-whisper veralux-kokoro veralux-xtts)
  local n
  for n in "${stale[@]}"; do
    if docker inspect "$n" &>/dev/null; then
      state="$(docker inspect -f '{{.State.Status}}' "$n" 2>/dev/null || echo unknown)"
      if [[ "$state" != "running" ]]; then
        docker rm -f "$n" &>/dev/null || true
      fi
    fi
  done
}

stop_split_audio_stack() {
  local f="${PROD_ROOT}/veralux-audio-stack/docker-compose.yml"
  if [[ -f "$f" ]]; then
    echo "[info] Stopping legacy compose project veralux-audio-stack (split STT/TTS network)"
    docker compose -p veralux-audio-stack -f "$f" down 2>/dev/null || true
  fi
}

stop_docker_cloudflared() {
  if docker inspect veralux-cloudflared &>/dev/null; then
    local state
    state="$(docker inspect -f '{{.State.Running}}' veralux-cloudflared 2>/dev/null || echo false)"
    if [[ "$state" == "true" ]]; then
      echo "[info] Stopping docker veralux-cloudflared (use systemd + /etc/cloudflared/config.yml on production)"
      docker stop veralux-cloudflared >/dev/null || true
    fi
  fi
}

detect_profile() {
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    echo gpu
  else
    echo cpu
  fi
}

parse_tts_mode() {
  grep -E '^TTS_MODE=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

wait_runtime_voice() {
  local i
  for i in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:${RUNTIME_PORT:-4001}/health/voice" >/dev/null 2>&1; then
      echo "[ok] Runtime voice health is up"
      return 0
    fi
    sleep 2
  done
  echo "[warn] Timeout waiting for GET /health/voice — check chatterbox logs and HF_TOKEN"
  return 1
}

build_effective_env
if [[ "${VERALUX_STRICT_SECRETS:-0}" == "1" ]]; then
  check_required_secrets
else
  warn_placeholder_secrets
fi

# docker-compose.production.yml uses ${VERALUX_COMPOSE_ENV_FILE:?} for per-service env_file paths.
export VERALUX_COMPOSE_ENV_FILE="$EFFECTIVE_ENV"
# Interpolation for `docker compose` (no `docker compose --env-file` — avoids plugin/CLI flag ordering bugs).
set -a
# shellcheck disable=SC1090
source "$EFFECTIVE_ENV"
set +a

RUNTIME_PORT="$(grep -E '^RUNTIME_PORT=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr -d '\r')"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"

PROFILE="$(detect_profile)"
TTS_MODE="$(parse_tts_mode)"

echo "[info] PROD_ROOT=$PROD_ROOT"
echo "[info] Compose profile=$PROFILE TTS_MODE=$TTS_MODE (from effective env)"

if [[ "${TTS_MODE}" == "chatterbox_http" ]]; then
  hflen="$(grep '^HF_TOKEN=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | wc -c | tr -d ' ')"
  if [[ "${hflen:-0}" -lt 12 ]]; then
    echo "[warn] HF_TOKEN is unset or short; Chatterbox may fail if model downloads require Hugging Face auth."
  fi
fi

if [[ "$PROFILE" == cpu && "$TTS_MODE" == chatterbox_http ]]; then
  echo "[error] TTS_MODE=chatterbox_http requires NVIDIA GPU (--profile gpu) per deployment contract."
  exit 1
fi

ensure_network
clear_stopped_name_conflicts
stop_split_audio_stack
stop_docker_cloudflared

compose() {
  docker compose \
    -f "${PROD_ROOT}/docker-compose.yml" \
    -f "${PROD_ROOT}/docker-compose.production.yml" \
    -p veralux \
    "$@"
}

echo "[info] Docker Compose: $(docker compose version --short 2>/dev/null || docker compose version)"
echo "[info] Building runtime image (health /health/voice)…"
compose build runtime

BASE_SVC=(postgres redis control)
AUDIO_SVC=()
if [[ "$PROFILE" == gpu ]]; then
  AUDIO_SVC+=(whisper-gpu)
  case "$TTS_MODE" in
    chatterbox_http) AUDIO_SVC+=(chatterbox-gpu) ;;
    kokoro_http) AUDIO_SVC+=(kokoro-gpu) ;;
    coqui_xtts) AUDIO_SVC+=(xtts-gpu) ;;
    qwen3_tts_http) AUDIO_SVC+=(qwen3-tts-gpu) ;;
    *)
      echo "[error] Unsupported TTS_MODE for gpu profile start: ${TTS_MODE}"
      exit 1
      ;;
  esac
else
  AUDIO_SVC+=(whisper-cpu)
  case "$TTS_MODE" in
    kokoro_http) AUDIO_SVC+=(kokoro-cpu) ;;
    coqui_xtts) AUDIO_SVC+=(xtts-cpu) ;;
    *)
      echo "[error] Unsupported TTS_MODE for cpu profile start: ${TTS_MODE}"
      exit 1
      ;;
  esac
fi

echo "[info] Starting core + audio (${BASE_SVC[*]} ${AUDIO_SVC[*]} runtime) …"
compose "--profile" "$PROFILE" up -d "${BASE_SVC[@]}" "${AUDIO_SVC[@]}" runtime

wait_runtime_voice || true

echo ""
echo "[info] Compose status (veralux project):"
compose ps

echo ""
bash "${DEFAULT_REPO_ROOT}/scripts/validate-voice-topology.sh" "${EFFECTIVE_ENV}" || true

echo ""
echo "[info] Voice health:"
curl -sS "http://127.0.0.1:${RUNTIME_PORT}/health/voice" | head -c 400 || true
echo ""
