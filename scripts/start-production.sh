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

if [[ ! -f "${SCRIPT_DIR}/veralux-compose-helper.sh" ]]; then
  echo "[error] Missing ${SCRIPT_DIR}/veralux-compose-helper.sh — this tree is not a full copy of VeraLux-Receptionist-Bundle."
  echo "  /opt is often a rsync target, not a git clone. Sync scripts from your clone, e.g.:"
  echo "    sudo rsync -a --delete \"\$HOME/Documents/GitHub/VeraLux-Receptionist-Bundle/\" /opt/veralux/veralux-voice-runtime/"
  exit 1
fi
# shellcheck source=veralux-compose-helper.sh
source "${SCRIPT_DIR}/veralux-compose-helper.sh"

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

VERALUX_DOCKER_BIN="$(veralux_resolve_docker_bin)" || {
  echo "[error] docker CLI not found (checked /usr/bin/docker, /bin/docker, then PATH)"
  exit 1
}
_compose_version_out="$("${VERALUX_DOCKER_BIN}" compose version 2>&1)" || {
  echo "[error] Docker Compose v2 plugin is not available for: ${VERALUX_DOCKER_BIN}"
  echo "Output from: ${VERALUX_DOCKER_BIN} compose version"
  echo "$_compose_version_out" | head -n 8
  echo ""
  echo "Fix options:"
  echo "  A) Add Docker’s official apt repository (so docker-compose-plugin exists), then:"
  echo "       https://docs.docker.com/engine/install/ubuntu/"
  echo "       sudo apt-get install -y docker-compose-plugin"
  echo ""
  echo "  B) Install the Compose v2 binary as a CLI plugin (works without that apt package):"
  echo "       sudo \"${SCRIPT_DIR}/install-docker-compose-plugin.sh\""
  echo ""
  echo "  Then: ${VERALUX_DOCKER_BIN} compose version"
  exit 1
}
unset _compose_version_out

MERGED_ENV_TMP=""

build_effective_env() {
  if [[ -f "$FRAGMENT" ]]; then
    MERGED_ENV_TMP="$(mktemp)"
    python3 "${SCRIPT_DIR}/merge-voice-env.py" "$VOICE_ENV" "$FRAGMENT" >"$MERGED_ENV_TMP"
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
    TELNYX_API_KEY TELNYX_PUBLIC_KEY
  )
  local llm_provider
  llm_provider="$(grep -E '^LLM_PROVIDER=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' | tr -d '\r ' || true)"
  if [[ "$llm_provider" != "local" ]]; then
    keys+=(OPENAI_API_KEY)
  fi
  local k
  for k in "${keys[@]}"; do
    require_nonplaceholder "$k"
  done
}

warn_placeholder_secrets() {
  local keys=(
    POSTGRES_PASSWORD JWT_SECRET ADMIN_API_KEY MEDIA_STREAM_TOKEN SECRET_ENCRYPTION_KEY
    TELNYX_API_KEY TELNYX_PUBLIC_KEY
  )
  local llm_provider
  llm_provider="$(grep -E '^LLM_PROVIDER=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' | tr -d '\r ' || true)"
  if [[ "$llm_provider" != "local" ]]; then
    keys+=(OPENAI_API_KEY)
  fi
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
    local _db
    _db="$(veralux_resolve_docker_bin)" || return 0
    "${_db}" compose -p veralux-audio-stack -f "$f" down 2>/dev/null || true
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
  local max_attempts="${1:-90}"
  local i
  for i in $(seq 1 "$max_attempts"); do
    if curl -sf "http://127.0.0.1:${RUNTIME_PORT:-4001}/health/voice" >/dev/null 2>&1; then
      echo "[ok] Runtime voice health is up"
      return 0
    fi
    sleep 2
  done
  echo "[warn] Timeout waiting for GET /health/voice — check chatterbox logs, HF_TOKEN, and vLLM/brain if profile llm is enabled"
  return 1
}

# Start vllm-qwen + brain when operators want on-host LLM for the voice runtime (HTTP brain).
# Uses merged effective env file path (same as docker compose interpolation source).
wants_local_llm_stack() {
  local e="${1:?env file}"
  local v bu brain_url
  v="$(grep -E '^VERALUX_ENABLE_LOCAL_LLM=' "$e" | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' | tr -d '\r ' || true)"
  if [[ "$v" == "1" || "$v" == "true" || "$v" == "yes" ]]; then
    return 0
  fi
  v="$(grep -E '^VERALUX_EXTRA_COMPOSE_PROFILES=' "$e" | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' | tr -d '\r' || true)"
  if [[ "$v" == "llm" ]] || [[ ",${v}," == *",llm,"* ]]; then
    return 0
  fi
  brain_url="$(grep -E '^BRAIN_URL=' "$e" | tail -1 | cut -d= -f2- | tr -d '\r' || true)"
  bu="$(grep -E '^BRAIN_USE_LOCAL=' "$e" | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' | tr -d '\r ' || true)"
  [[ -n "$brain_url" ]] || return 1
  if [[ "$bu" == "true" || "$bu" == "1" || "$bu" == "yes" ]]; then
    return 1
  fi
  if [[ "$brain_url" == *"://brain"* ]] || [[ "$brain_url" == *"//brain."* ]]; then
    return 0
  fi
  return 1
}

build_effective_env
if [[ "${VERALUX_STRICT_SECRETS:-0}" == "1" ]]; then
  check_required_secrets
else
  warn_placeholder_secrets
fi

# Interpolation for `docker compose` (no `docker compose --env-file` — Compose v5 / Docker 29 safe).
veralux_compose_prepare_env "$EFFECTIVE_ENV"

RUNTIME_PORT="$(grep -E '^RUNTIME_PORT=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr -d '\r')"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"

PROFILE="$(detect_profile)"
TTS_MODE="$(parse_tts_mode)"

LOCAL_LLM_STACK=0
if wants_local_llm_stack "$EFFECTIVE_ENV"; then
  if [[ "$PROFILE" != "gpu" ]]; then
    echo "[error] Local vLLM + brain (compose profile llm) requires NVIDIA GPUs. This host resolved to cpu profile."
    echo "  Fix: use a GPU machine, or disable the LLM stack (unset VERALUX_ENABLE_LOCAL_LLM / remove llm from VERALUX_EXTRA_COMPOSE_PROFILES / use BRAIN_USE_LOCAL=true without http://brain BRAIN_URL)."
    exit 1
  fi
  LOCAL_LLM_STACK=1
fi

echo "[info] PROD_ROOT=$PROD_ROOT"
echo "[info] Compose profile=$PROFILE TTS_MODE=$TTS_MODE local_llm_stack=${LOCAL_LLM_STACK} (from effective env)"

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

echo "[info] Docker Compose: $("${VERALUX_DOCKER_BIN}" compose version --short 2>/dev/null || "${VERALUX_DOCKER_BIN}" compose version)"
echo "[info] Building runtime image (health /health/voice)…"
veralux_compose build runtime

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

LLM_SVC=()
COMPOSE_PROFILE_ARGS=( "--profile" "$PROFILE" )
if [[ "$LOCAL_LLM_STACK" == 1 ]]; then
  COMPOSE_PROFILE_ARGS+=( "--profile" "llm" )
  LLM_SVC=( vllm-qwen brain )
  echo "[info] Local LLM: also applying compose profile llm (vllm-qwen + brain) …"
fi

echo "[info] Starting core + audio (${BASE_SVC[*]} ${AUDIO_SVC[*]} ${LLM_SVC[*]} runtime) …"
veralux_compose "${COMPOSE_PROFILE_ARGS[@]}" up -d "${BASE_SVC[@]}" "${AUDIO_SVC[@]}" "${LLM_SVC[@]}" runtime

WAIT_VOICE_ATTEMPTS=90
if [[ "$LOCAL_LLM_STACK" == 1 ]]; then
  WAIT_VOICE_ATTEMPTS=240
fi
wait_runtime_voice "$WAIT_VOICE_ATTEMPTS" || true

echo ""
echo "[info] Compose status (veralux project):"
veralux_compose ps

echo ""
bash "${SCRIPT_DIR}/validate-voice-topology.sh" "${EFFECTIVE_ENV}" || true

echo ""
echo "[info] Voice health:"
curl -sS "http://127.0.0.1:${RUNTIME_PORT}/health/voice" | head -c 400 || true
echo ""
