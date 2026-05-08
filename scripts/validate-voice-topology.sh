#!/usr/bin/env bash
set -euo pipefail

EFFECTIVE_ENV="${1:-/etc/veralux/voice-runtime.env}"
if [[ ! -f "$EFFECTIVE_ENV" ]]; then
  echo "[error] env file not found: $EFFECTIVE_ENV"
  exit 1
fi

TTS_MODE="$(grep -E '^TTS_MODE=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr -d '\r')"
WHISPER_URL="$(grep -E '^WHISPER_URL=' "$EFFECTIVE_ENV" | tail -1 | cut -d= -f2- | tr -d '\r')"

echo "[info] validate-voice-topology: TTS_MODE=$TTS_MODE"

echo "--- runtime → DNS whisper ---"
if docker exec veralux-runtime getent hosts whisper >/dev/null 2>&1; then
  docker exec veralux-runtime getent hosts whisper
else
  echo "[fail] whisper does not resolve inside veralux-runtime"
  exit 1
fi

echo "--- runtime → GET whisper health ---"
if docker exec veralux-runtime wget -qO- --timeout=5 http://whisper:9000/health | head -c 200; then
  echo ""
else
  echo "[fail] whisper /health not reachable from runtime"
  exit 1
fi

case "$TTS_MODE" in
  chatterbox_http)
    echo "--- runtime → DNS chatterbox ---"
    docker exec veralux-runtime getent hosts chatterbox
    echo "--- runtime → GET chatterbox health ---"
    docker exec veralux-runtime wget -qO- --timeout=10 http://chatterbox:7005/health | head -c 200 || {
      echo "[fail] chatterbox /health unreachable"
      exit 1
    }
    echo ""
    ;;
  kokoro_http)
    echo "--- runtime → DNS kokoro ---"
    docker exec veralux-runtime getent hosts kokoro
    echo "--- runtime → GET kokoro health ---"
    docker exec veralux-runtime wget -qO- --timeout=5 http://kokoro:7001/health | head -c 200 || {
      echo "[fail] kokoro /health unreachable"
      exit 1
    }
    echo ""
    ;;
  coqui_xtts)
    echo "--- runtime → DNS xtts ---"
    docker exec veralux-runtime getent hosts xtts
    docker exec veralux-runtime wget -qO- --timeout=5 http://xtts:7002/health | head -c 200 || {
      echo "[fail] xtts /health unreachable"
      exit 1
    }
    echo ""
    ;;
  *)
    echo "[warn] no extra TTS checks for TTS_MODE=$TTS_MODE"
    ;;
esac

echo "[ok] validate-voice-topology passed (WHISPER_URL in env is $WHISPER_URL)"
