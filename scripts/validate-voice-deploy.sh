#!/usr/bin/env bash
# Fail fast before "up" when env would produce a known-broken voice stack.
# Usage:
#   ./scripts/validate-voice-deploy.sh           # merge .env + .env.internal (repo root)
#   ./scripts/validate-voice-deploy.sh .env.example  # single file (CI)
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "${1:-}" ]]; then
  if [[ -f "$1" ]]; then
    ENV_FILES=("$(cd "$(dirname "$1")" && pwd)/$(basename "$1")")
  elif [[ -f "$ROOT/$1" ]]; then
    ENV_FILES=("$ROOT/$1")
  else
    echo -e "${RED}[validate-voice-deploy]${NC} File not found: $1" >&2
    exit 1
  fi
else
  ENV_FILES=("$ROOT/.env" "$ROOT/.env.internal")
  if [[ ! -f "$ROOT/.env" ]]; then
    echo -e "${RED}[validate-voice-deploy]${NC} Missing $ROOT/.env" >&2
    exit 1
  fi
fi

read_merged_tts_mode() {
  local val="" line f
  for f in "${ENV_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    line=$(grep "^TTS_MODE=" "$f" 2>/dev/null | tail -n1) || true
    if [[ -n "$line" ]]; then
      val="${line#TTS_MODE=}"
    fi
  done
  echo "$val" | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | xargs
}

tts_mode="$(read_merged_tts_mode)"
if [[ -z "$tts_mode" ]]; then
  tts_mode="coqui_xtts"
fi

has_nvidia=false
if docker info 2>/dev/null | grep -qi nvidia; then
  has_nvidia=true
elif command -v nvidia-smi &>/dev/null; then
  has_nvidia=true
fi

case "$tts_mode" in
  coqui_xtts|kokoro_http|qwen3_tts_http|chatterbox_http|miso_tts_http) ;;
  *)
    echo -e "${RED}[validate-voice-deploy]${NC} Invalid TTS_MODE='$tts_mode'." >&2
    echo "  Must be one of: coqui_xtts, kokoro_http, qwen3_tts_http, chatterbox_http, miso_tts_http" >&2
    exit 1
    ;;
esac

if [[ "$tts_mode" == "chatterbox_http" && "$has_nvidia" != "true" ]]; then
  echo -e "${RED}[validate-voice-deploy]${NC} TTS_MODE=chatterbox_http requires an NVIDIA GPU and NVIDIA Container Toolkit." >&2
  echo "  There is no chatterbox-cpu service in docker-compose.yml; deploy.sh would select --profile cpu on this host." >&2
  echo "  Use a GPU host, or set TTS_MODE to coqui_xtts, kokoro_http, or qwen3_tts_http." >&2
  exit 1
fi

if [[ "$has_nvidia" != "true" ]]; then
  echo -e "${YELLOW}[validate-voice-deploy]${NC} No NVIDIA GPU detected — deploy will use --profile cpu (slower STT/TTS)."
fi

exit 0
