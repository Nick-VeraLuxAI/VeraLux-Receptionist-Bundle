#!/usr/bin/env bash
# Profile-aware preflight (no secret values printed).
# Usage:
#   ./scripts/preflight-profile.sh --profile local-gpu|cloud-api|hybrid [--env-file PATH …] [--fragment-env PATH …]
#
# --env-file        Primary operator env (e.g. /etc/veralux/voice-runtime.env)
# --fragment-env    Additional env files merged after --env-file (e.g. compose bridge with REDIS_URL=redis://redis:6379)
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
    -h|--help)
      echo "Usage: $0 --profile local-gpu|cloud-api|hybrid [--env-file PATH] ... [--fragment-env PATH] ..."
      echo "  --fragment-env   Merged after --env-file (e.g. REDIS_URL bridge for split env files)."
      exit 0
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

fail() { echo "[FAIL] $*" >&2; exit 1; }
warn() { echo "[WARN] $*" >&2; }
ok() { echo "[ OK ] $*"; }

# VeraLux root compose ships a `redis` service; runtime often gets REDIS_URL from compose env merge
# even when /etc/veralux/voice-runtime.env omits it (split-env production model).
compose_defines_bundled_redis_service() {
  [[ -f "$ROOT/docker-compose.yml" ]] || return 1
  grep -Eq '^  redis:[[:space:]]*(#.*)?$' "$ROOT/docker-compose.yml"
}

ensure_redis_contract() {
  if [[ -n "$REDIS_URL" ]]; then
    if [[ ${#FRAGMENT_ENVS[@]} -gt 0 ]]; then
      ok "Redis source: env (REDIS_URL present after merging repo .env, --env-file, and --fragment-env; value not printed)"
    else
      ok "Redis source: env (REDIS_URL present in merged env; value not printed)"
    fi
    return 0
  fi
  if compose_defines_bundled_redis_service; then
    ok "Redis source: bundled compose service \"redis\" (REDIS_URL omitted from env file is OK — Compose injects in-container URL at deploy time for the standard stack)"
    return 0
  fi
  fail "REDIS_URL is not set and docker-compose.yml has no bundled \"redis\" service — set REDIS_URL or use the standard VeraLux compose graph"
}

POSTGRES_USER="$(read_kv POSTGRES_USER)"
POSTGRES_PASSWORD="$(read_kv POSTGRES_PASSWORD)"
POSTGRES_DB="$(read_kv POSTGRES_DB)"
DATABASE_URL="$(read_kv DATABASE_URL)"
REDIS_URL="$(read_kv REDIS_URL)"
PUBLIC_BASE_URL="$(read_kv PUBLIC_BASE_URL)"
AUDIO_PUBLIC_BASE_URL="$(read_kv AUDIO_PUBLIC_BASE_URL)"
MEDIA_STREAM_TOKEN="$(read_kv MEDIA_STREAM_TOKEN)"
SECRET_ENCRYPTION_KEY="$(read_kv SECRET_ENCRYPTION_KEY)"
SECRET_MANAGER="$(read_kv SECRET_MANAGER)"
TELNYX_PUBLIC_KEY="$(read_kv TELNYX_PUBLIC_KEY)"
TELNYX_SKIP_SIGNATURE="$(read_kv TELNYX_SKIP_SIGNATURE)"
LLM_PROVIDER="$(read_kv LLM_PROVIDER)"
OPENAI_API_KEY="$(read_kv OPENAI_API_KEY)"
WHISPER_URL="$(read_kv WHISPER_URL)"
TTS_MODE="$(read_kv TTS_MODE)"
CHATTERBOX_URL="$(read_kv CHATTERBOX_URL)"
KOKORO_URL="$(read_kv KOKORO_URL)"
COQUI_XTTS_URL="$(read_kv COQUI_XTTS_URL)"
QWEN3_TTS_URL="$(read_kv QWEN3_TTS_URL)"
MISO_TTS_URL="$(read_kv MISO_TTS_URL)"
HEALTH_VOICE="$(read_kv HEALTH_VOICE_DEPENDENCIES)"
DEPLOYMENT_PROFILE_ENV="$(read_kv DEPLOYMENT_PROFILE)"

[[ -n "$DATABASE_URL" || ( -n "$POSTGRES_USER" && -n "$POSTGRES_PASSWORD" && -n "$POSTGRES_DB" ) ]] || fail "Database: set DATABASE_URL or POSTGRES_* in env files"
ensure_redis_contract
[[ -n "$PUBLIC_BASE_URL" ]] || fail "PUBLIC_BASE_URL must be set"
[[ -n "$AUDIO_PUBLIC_BASE_URL" ]] || fail "AUDIO_PUBLIC_BASE_URL must be set"
[[ -n "$MEDIA_STREAM_TOKEN" ]] || fail "MEDIA_STREAM_TOKEN must be set"

sm="$(echo "${SECRET_MANAGER:-db}" | tr '[:upper:]' '[:lower:]')"
if [[ "$sm" == "db" ]]; then
  klen="${#SECRET_ENCRYPTION_KEY}"
  [[ "$klen" -ge 32 ]] || fail "SECRET_ENCRYPTION_KEY must be at least 32 bytes when SECRET_MANAGER=db (length=$klen)"
fi

if [[ "${TELNYX_SKIP_SIGNATURE:-}" != "true" && "${TELNYX_SKIP_SIGNATURE:-}" != "1" ]]; then
  [[ -n "$TELNYX_PUBLIC_KEY" ]] || warn "TELNYX_PUBLIC_KEY empty — required unless skipping signature verification for local dev"
fi

case "$PROFILE" in
  cloud-api)
    [[ -n "$WHISPER_URL" ]] || fail "cloud-api: WHISPER_URL must point to an external STT HTTP endpoint"
    tm="$(echo "${TTS_MODE:-kokoro_http}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$tm" == "chatterbox_http" ]]; then
      if [[ "$CHATTERBOX_URL" == *chatterbox:* ]] || [[ "$CHATTERBOX_URL" == *localhost* ]] || [[ "$CHATTERBOX_URL" == *127.0.0.1* ]]; then
        warn "cloud-api: CHATTERBOX_URL looks like a local Docker hostname — use an external HTTPS endpoint for cloud-api"
      fi
    fi
    if [[ "$tm" == "miso_tts_http" ]]; then
      if [[ "$MISO_TTS_URL" == *miso-tts:* ]] || [[ "$MISO_TTS_URL" == *localhost* ]] || [[ "$MISO_TTS_URL" == *127.0.0.1* ]]; then
        warn "cloud-api: MISO_TTS_URL looks like a local Docker hostname — use an external HTTPS endpoint for cloud-api"
      fi
    fi
    if [[ "$LLM_PROVIDER" == "openai" || -n "${OPENAI_API_KEY:-}" ]]; then
      ok "cloud-api: LLM appears configured (OpenAI path)"
    else
      warn "cloud-api: verify LLM (OpenAI or HTTP brain) is configured for your control/runtime env"
    fi
    if [[ "$HEALTH_VOICE" == "strict" || "$HEALTH_VOICE" == "true" || -z "$HEALTH_VOICE" ]]; then
      warn "cloud-api: set HEALTH_VOICE_DEPENDENCIES=configured unless external STT/TTS expose GET /health compatible with VeraLux probes"
    fi
    ;;
  local-gpu)
    if docker info 2>/dev/null | grep -qi nvidia || command -v nvidia-smi &>/dev/null; then
      ok "local-gpu: NVIDIA stack available for --profile gpu"
    else
      warn "local-gpu: no NVIDIA detected — deploy-profile will use CPU audio profile"
    fi
    ;;
  hybrid)
    warn "hybrid: Redis placement, public URLs, and GPU reachability are NOT auto-validated — see docs/HYBRID_DEPLOYMENT.md"
    ;;
esac

if [[ -n "$DEPLOYMENT_PROFILE_ENV" && "$DEPLOYMENT_PROFILE_ENV" != "$PROFILE" ]]; then
  warn "DEPLOYMENT_PROFILE in env ($DEPLOYMENT_PROFILE_ENV) differs from CLI --profile ($PROFILE)"
fi

ok "preflight-profile: $PROFILE passed"
