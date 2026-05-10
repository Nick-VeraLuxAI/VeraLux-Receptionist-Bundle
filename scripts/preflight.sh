#!/usr/bin/env bash
# Veralux Receptionist — preflight checks before ./deploy.sh up / update / tunnel.
# Exit 1 = blocking issues (startup should abort). Warnings print but exit 0 unless PREFLIGHT_STRICT=1.
#
# Usage:
#   ./scripts/preflight.sh
#   ./scripts/preflight.sh --ci .env.example   # CI/template: placeholder secret *values* are not enforced like prod; structural checks (e.g. SECRET_ENCRYPTION_KEY byte length when SECRET_MANAGER=db) still run when the key is set
#   PREFLIGHT_STRICT=1 ./scripts/preflight.sh  # treat warnings as failures
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

FAILS=0
WARNS=0

PREFLIGHT_CI=0
if [[ "${1:-}" == "--ci" ]]; then
  PREFLIGHT_CI=1
  shift
fi

CI_ENV_FILE="${1:-}"

fail() {
  echo -e "${RED}[FAIL]${NC} $*" >&2
  FAILS=$((FAILS + 1))
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $*" >&2
  WARNS=$((WARNS + 1))
}

ok() {
  echo -e "${GREEN}[ OK ]${NC} $*"
}

info() {
  echo -e "${BLUE}[ .. ]${NC} $*"
}

remediation() {
  echo -e "       ${BLUE}→${NC} $*" >&2
}

# -----------------------------------------------------------------------------
# Merged env read (.env then .env.internal, last wins)
# -----------------------------------------------------------------------------
read_kv() {
  local key="$1" val="" line f ef
  if [[ "$PREFLIGHT_CI" == "1" ]]; then
    ef="$CI_ENV_FILE"
    [[ -f "$ef" ]] || ef="$ROOT/$CI_ENV_FILE"
    [[ -f "$ef" ]] || { echo ""; return; }
    line=$(grep "^${key}=" "$ef" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then
      val="${line#${key}=}"
    fi
  else
    for f in .env .env.internal; do
      [[ -f "$f" ]] || continue
      line=$(grep "^${key}=" "$f" 2>/dev/null | tail -n1) || true
      if [[ -n "$line" ]]; then
        val="${line#${key}=}"
      fi
    done
  fi
  echo "$val" | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | xargs
}

trim_lower() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | xargs
}

is_empty_or_placeholder_secret() {
  local v="$1"
  [[ -z "$v" ]] && return 0
  local l
  l=$(trim_lower "$v")
  case "$l" in
    *change_me*|*changeme*|*replace_me*|*your_*|*xxx*|*sk-your-key*|sk-placeholder) return 0 ;;
  esac
  [[ "$v" == "CHANGE_ME" ]] && return 0
  return 1
}

# -----------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Veralux Receptionist — preflight${NC}"
if [[ "$PREFLIGHT_CI" == "1" ]]; then
  echo -e "${BLUE}Mode:${NC} --ci ${CI_ENV_FILE:-}(template checks only)"
fi
echo ""

# --- .env presence ---
if [[ "$PREFLIGHT_CI" != "1" ]]; then
  if [[ ! -f .env ]]; then
    fail "Missing .env in $ROOT"
    remediation "cp .env.example .env && edit secrets and URLs, then re-run."
    echo ""
    exit 1
  fi
  ok "Found .env"
  [[ -f .env.internal ]] && ok "Found .env.internal (merged for checks)"
else
  if [[ -z "$CI_ENV_FILE" ]] || { [[ ! -f "$CI_ENV_FILE" ]] && [[ ! -f "$ROOT/$CI_ENV_FILE" ]]; }; then
    fail "CI mode: pass a path to an env file (e.g. .env.example)"
    exit 1
  fi
  ok "CI env file: $CI_ENV_FILE"
fi

# --- Docker + Compose ---
if ! command -v docker &>/dev/null; then
  fail "docker not in PATH"
  remediation "Install Docker: https://docs.docker.com/get-docker/"
else
  ok "docker binary present"
fi

if [[ "$PREFLIGHT_CI" != "1" ]] || docker info &>/dev/null; then
  if ! docker info &>/dev/null; then
    if [[ "$PREFLIGHT_CI" == "1" ]]; then
      warn "Docker daemon not reachable (skipping compose config in CI if needed)"
    else
      fail "Docker daemon not running or no permission (docker info failed)"
      remediation "sudo systemctl start docker  OR  add user to group docker and re-login"
    fi
  else
    ok "Docker daemon reachable"
  fi
else
  true
fi

COMPOSE_CMD=""
if docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
  warn "Using legacy docker-compose; prefer Docker Compose V2."
else
  fail "docker compose not available"
  remediation "Install Docker Compose V2: https://docs.docker.com/compose/install/"
fi
[[ -n "$COMPOSE_CMD" ]] && ok "Compose command: $COMPOSE_CMD"

# --- docker compose config ---
if docker info &>/dev/null 2>&1; then
  _pc_err="$(mktemp)"
  if docker compose version &>/dev/null 2>&1; then
    if [[ -f .env.internal ]]; then
      if docker compose -f docker-compose.yml --env-file .env.internal config --quiet 2>"$_pc_err"; then
        ok "docker compose config --quiet"
      else
        fail "docker compose config failed (invalid compose or env interpolation)"
        remediation "Fix docker-compose.yml / .env: $(head -3 "$_pc_err" | tr '\n' ' ')"
      fi
    else
      if docker compose -f docker-compose.yml config --quiet 2>"$_pc_err"; then
        ok "docker compose config --quiet"
      else
        fail "docker compose config failed (invalid compose or env interpolation)"
        remediation "Fix docker-compose.yml / .env: $(head -3 "$_pc_err" | tr '\n' ' ')"
      fi
    fi
  elif command -v docker-compose &>/dev/null; then
    if [[ -f .env.internal ]]; then
      docker-compose -f docker-compose.yml --env-file .env.internal config --quiet 2>"$_pc_err" && ok "docker-compose config --quiet" || {
        fail "docker-compose config failed"
        remediation "$(head -3 "$_pc_err")"
      }
    else
      docker-compose -f docker-compose.yml config --quiet 2>"$_pc_err" && ok "docker-compose config --quiet" || {
        fail "docker-compose config failed"
        remediation "$(head -3 "$_pc_err")"
      }
    fi
  fi
  rm -f "$_pc_err"
fi

# --- Required keys ---
REQ_KEYS=(
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  JWT_SECRET ADMIN_API_KEY SECRET_ENCRYPTION_KEY MEDIA_STREAM_TOKEN
  TELNYX_API_KEY TELNYX_PUBLIC_KEY
  BASE_URL PUBLIC_BASE_URL AUDIO_PUBLIC_BASE_URL
  VERSION REGISTRY
)

for key in "${REQ_KEYS[@]}"; do
  v="$(read_kv "$key")"
  if [[ -z "$v" ]]; then
    if [[ "$PREFLIGHT_CI" == "1" ]]; then
      warn "CI: $key is empty in template (expected for some optional keys)"
    else
      fail "Required env missing or empty: $key"
      remediation "Set $key in .env (see .env.example)."
    fi
  fi
done

# --- Placeholder secrets ---
if [[ "$PREFLIGHT_CI" != "1" ]]; then
  for key in POSTGRES_PASSWORD JWT_SECRET ADMIN_API_KEY SECRET_ENCRYPTION_KEY MEDIA_STREAM_TOKEN TELNYX_API_KEY TELNYX_PUBLIC_KEY; do
    v="$(read_kv "$key")"
    if is_empty_or_placeholder_secret "$v"; then
      fail "Secret looks unset or placeholder: $key"
      remediation "Generate a strong value; e.g. openssl rand -hex 32  (see .env.example comments)."
    fi
  done

  llm="$(trim_lower "$(read_kv LLM_PROVIDER)")"
  [[ -z "$llm" ]] && llm="openai"
  if [[ "$llm" == "openai" ]]; then
    oa="$(read_kv OPENAI_API_KEY)"
    if is_empty_or_placeholder_secret "$oa"; then
      fail "LLM_PROVIDER=openai but OPENAI_API_KEY is missing or placeholder"
      remediation "Set OPENAI_API_KEY or set LLM_PROVIDER=local and LOCAL_LLM_URL (see .env.internal.example)."
    fi
  fi

  # Voice runtime (veralux-voice-runtime) platform LLM — default brain_local does not need OpenAI or HTTP brain.
  vplat="$(trim_lower "$(read_kv PLATFORM_LLM_PROVIDER)")"
  [[ -z "$vplat" ]] && vplat="brain_local"
  if [[ "$vplat" == "brain_http" || "$vplat" == "http_brain" || "$vplat" == "remote_brain" ]]; then
    bu="$(trim_lower "$(read_kv BRAIN_URL)")"
    if [[ -z "$bu" ]]; then
      fail "PLATFORM_LLM_PROVIDER=brain_http but BRAIN_URL is empty"
      remediation "Set BRAIN_URL to the HTTP brain base (e.g. http://brain:3001/reply) or use PLATFORM_LLM_PROVIDER=brain_local."
    fi
  fi
  if [[ "$vplat" == "openai" || "$vplat" == "gpt" || "$vplat" == "chatgpt" ]]; then
    voa="$(read_kv OPENAI_API_KEY)"
    if is_empty_or_placeholder_secret "$voa"; then
      fail "PLATFORM_LLM_PROVIDER=openai but OPENAI_API_KEY is missing or placeholder in voice env"
      remediation "Set a real OPENAI_API_KEY for the voice runtime, or set PLATFORM_LLM_PROVIDER=brain_local (default)."
    fi
  fi
fi

# --- Public URLs (production sanity) ---
PUB="$(read_kv PUBLIC_BASE_URL)"
AUD="$(read_kv AUDIO_PUBLIC_BASE_URL)"
if [[ "$PREFLIGHT_CI" != "1" ]]; then
  if [[ "$PUB" =~ your-domain\.com ]] || [[ "$PUB" =~ example\.com ]]; then
    fail "PUBLIC_BASE_URL still looks like a template ($PUB)"
    remediation "Set PUBLIC_BASE_URL to the HTTPS URL Telnyx can reach (tunnel or reverse proxy)."
  fi
  if [[ "$AUD" =~ your-domain\.com ]] || [[ "$AUD" =~ example\.com ]]; then
    fail "AUDIO_PUBLIC_BASE_URL still looks like a template ($AUD)"
    remediation "Set AUDIO_PUBLIC_BASE_URL (usually https://<host>/audio)."
  fi
  if [[ "$PUB" =~ ^https?://(localhost|127\.0\.0\.1) ]]; then
    warn "PUBLIC_BASE_URL is localhost — Telnyx cannot reach this from the internet."
    remediation "Use Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN), ngrok, or a public hostname."
  fi
  if [[ "$AUD" =~ ^https?://(localhost|127\.0\.0\.1) ]]; then
    warn "AUDIO_PUBLIC_BASE_URL is localhost — callers may not fetch hold/prompt audio."
    remediation "Point AUDIO_PUBLIC_BASE_URL at the same public origin as the runtime /audio path."
  fi

  # Tunnel hint: localhost runtime URL and no tunnel env
  if [[ "$PUB" =~ localhost|127\.0\.0\.1 ]]; then
    ct="$(read_kv CLOUDFLARE_TUNNEL_TOKEN)"
    ng="$(read_kv NGROK_AUTHTOKEN)"
    if [[ -z "$ct" ]] && [[ -z "$ng" ]]; then
      warn "No CLOUDFLARE_TUNNEL_TOKEN or NGROK_AUTHTOKEN — confirm you have another way to expose :4001."
    fi
  fi
fi

# --- Telnyx ---
TEL_PHONE="$(read_kv TELNYX_PHONE_NUMBER)"
if [[ "$PREFLIGHT_CI" != "1" ]] && [[ -z "$TEL_PHONE" ]]; then
  warn "TELNYX_PHONE_NUMBER is empty — OK if DIDs are configured only in the admin UI / DB."
fi

# --- SECRET_ENCRYPTION_KEY length (must match control-plane/src/secretStore.ts for SECRET_MANAGER=db) ---
SEK="$(read_kv SECRET_ENCRYPTION_KEY)"
SM="$(trim_lower "$(read_kv SECRET_MANAGER)")"
[[ -z "$SM" ]] && SM="db"
if [[ "$SM" == "db" ]] && [[ -n "$SEK" ]]; then
  sek_bytes=$(LC_ALL=C printf '%s' "$SEK" | wc -c | awk '{print $1}')
  if [[ "${sek_bytes:-0}" -lt 32 ]]; then
    fail "SECRET_ENCRYPTION_KEY must be at least 32 UTF-8 bytes when SECRET_MANAGER=db (got ${sek_bytes:-0} bytes; matches control plane AES-256 key material)"
    remediation "openssl rand -hex 32"
  fi
fi

# --- TTS / HF ---
TTS="$(read_kv TTS_MODE)"
[[ -z "$TTS" ]] && TTS="coqui_xtts"
case "$TTS" in
  coqui_xtts|kokoro_http|qwen3_tts_http|chatterbox_http) ;;
  *)
    fail "Invalid TTS_MODE='$TTS' (must be coqui_xtts, kokoro_http, qwen3_tts_http, chatterbox_http)"
    remediation "Fix TTS_MODE in .env or .env.internal."
    ;;
esac

if [[ "$PREFLIGHT_CI" != "1" ]]; then
  hf="$(read_kv HF_TOKEN)"
  if [[ "$TTS" == "chatterbox_http" || "$TTS" == "qwen3_tts_http" ]]; then
    if [[ -z "$hf" ]] || [[ ${#hf} -lt 8 ]]; then
      fail "TTS_MODE=$TTS requires HF_TOKEN (Hugging Face read token for gated models)"
      remediation "Create a token at https://huggingface.co/settings/tokens and set HF_TOKEN in .env"
    fi
  fi
fi

# --- GPU vs chatterbox (delegate to existing script for one source of truth) ---
if [[ -f "$ROOT/scripts/validate-voice-deploy.sh" ]]; then
  if [[ "$PREFLIGHT_CI" == "1" ]]; then
    if bash "$ROOT/scripts/validate-voice-deploy.sh" "$CI_ENV_FILE"; then
      ok "validate-voice-deploy.sh (CI file)"
    else
      fail "validate-voice-deploy.sh rejected TTS/GPU combination for $CI_ENV_FILE"
    fi
  else
    if bash "$ROOT/scripts/validate-voice-deploy.sh"; then
      ok "Voice profile / GPU compatibility (validate-voice-deploy.sh)"
    else
      fail "Voice profile / GPU check failed — see messages above"
    fi
  fi
else
  warn "scripts/validate-voice-deploy.sh missing — skipping TTS/GPU check"
fi

# --- nvidia vs expected profile ---
has_nvidia=false
if docker info 2>/dev/null | grep -qi nvidia; then
  has_nvidia=true
elif command -v nvidia-smi &>/dev/null; then
  has_nvidia=true
fi
if [[ "$has_nvidia" != "true" ]] && [[ "$TTS" == "chatterbox_http" ]]; then
  # validate-voice-deploy already fails; preflight redundant
  true
elif [[ "$has_nvidia" != "true" ]] && [[ "$PREFLIGHT_CI" != "1" ]]; then
  info "No NVIDIA GPU detected — deploy will use CPU audio profile (slower)."
fi

# --- Port conflicts (best effort) ---
if [[ "$PREFLIGHT_CI" != "1" ]]; then
  CP="$(read_kv CONTROL_PORT)"
  RP="$(read_kv RUNTIME_PORT)"
  [[ -z "$CP" ]] && CP=4000
  [[ -z "$RP" ]] && RP=4001
  check_port() {
    local port="$1" name="$2"
    if command -v ss &>/dev/null; then
      if ss -tln 2>/dev/null | grep -qE ":${port}\\s"; then
        # Ignore if our stack already bound (docker proxy)
        if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${port}->"; then
          ok "Port $port ($name): in use by a container (likely this stack)"
        else
          warn "Port $port ($name) appears in use on host — may conflict with Docker port publishing."
          remediation "Set a different ${name} in .env or free the port: ss -tlnp | grep :$port"
        fi
      else
        ok "Port $port ($name): nothing listening (ss)"
      fi
    elif command -v lsof &>/dev/null; then
      if lsof -iTCP:"$port" -sTCP:LISTEN -Pn &>/dev/null; then
        warn "Port $port ($name) may be in use (lsof). Verify before up."
      else
        ok "Port $port ($name): lsof shows no listener"
      fi
    else
      warn "Neither ss nor lsof available — skipping port conflict check"
    fi
  }
  check_port "$CP" "CONTROL_PORT"
  check_port "$RP" "RUNTIME_PORT"
fi

# --- docker-compose.override.yml bind mounts (volume lines only, not comments) ---
if [[ -f docker-compose.override.yml ]]; then
  while IFS= read -r raw; do
    [[ "$raw" == ./* ]] || continue
    dir="${raw#./}"
    if [[ -n "$dir" ]] && [[ ! -e "$dir" ]]; then
      warn "override bind source missing: $raw (docker-compose.override.yml)"
      remediation "mkdir -p \"$dir\" and set permissions (see docker-compose.override.example.yml)"
    fi
  done < <(grep -E '^\s+-\s+\./[^:]+:' docker-compose.override.yml 2>/dev/null | sed 's/^[[:space:]]*-[[:space:]]*//;s/:.*//' | sort -u || true)
  ok "Scanned docker-compose.override.yml for host paths"
fi

# --- Summary ---
echo ""
echo -e "${BOLD}Summary${NC}: ${FAILS} failure(s), ${WARNS} warning(s)"
if [[ "${PREFLIGHT_STRICT:-}" == "1" ]] && [[ "$WARNS" -gt 0 ]]; then
  echo -e "${RED}PREFLIGHT_STRICT=1:${NC} treating warnings as failures."
  exit 1
fi
if [[ "$FAILS" -gt 0 ]]; then
  echo -e "${RED}Preflight failed.${NC} Fix the [FAIL] items above, then run ./up or ./deploy.sh up."
  exit 1
fi
echo -e "${GREEN}Preflight passed.${NC} You can start the stack with ./up or ./deploy.sh up"
exit 0
