#!/usr/bin/env bash
# Copy production voice env into .env.development and append local-dev overrides.
# Duplicate keys below win (dotenv last-wins within one file).
#
# Usage (from repo root or this package):
#   npm run init:dev-env -w veralux-voice-runtime -- /etc/veralux/voice-runtime.env
#   bash veralux-voice-runtime/scripts/init-dev-env-from-prod.sh /path/to/voice-runtime.env
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PKG_ROOT}"

SRC="${1:-}"
if [[ -z "${SRC}" ]]; then
  echo "Usage: npm run init:dev-env -w veralux-voice-runtime -- /etc/veralux/voice-runtime.env"
  echo "   or: bash scripts/init-dev-env-from-prod.sh /path/to/voice-runtime.env"
  exit 1
fi
if [[ ! -f "${SRC}" ]]; then
  echo "[error] Not a file: ${SRC}"
  exit 1
fi

OUT="${PKG_ROOT}/.env.development"
cp "${SRC}" "${OUT}"

cat >>"${OUT}" <<'EOF'

# ------------------------------------------------------------------
# VeraLux — local development overrides (appended by init-dev-env-from-prod.sh)
# dotenv applies last-wins for duplicate variable names in this file.
# Point WHISPER_URL / TTS URLs at services reachable from THIS host (127.0.0.1
# or published Docker ports). Point PUBLIC_BASE_URL at your tunnel if testing PSTN.
# ------------------------------------------------------------------
NODE_ENV=development
PORT=4010
REDIS_URL=redis://127.0.0.1:6379
AUDIO_STORAGE_DIR=/tmp/veralux-audio-runtime-dev
HEALTH_VOICE_DEPENDENCIES=false
LOG_LEVEL=debug
LOG_REDACT_TRANSCRIPTS=false
AUDIO_DIAGNOSTICS=true
CALL_TRANSCRIPT_DIR=/tmp/veralux-transcripts
STT_DEBUG_DIR=/tmp/veralux-stt-debug
AMRWB_DEBUG_DIR=/tmp/veralux-stt-debug
STT_DEBUG_DUMP_RX_WAV=true
STT_DEBUG_DUMP_WHISPER_WAVS=true
STT_DEBUG_DUMP_PCM16=true
STT_PREWHISPER_DUMP_DIR=/tmp/veralux-stt-debug
STT_TRACE=true
STT_TRACE_LIMIT=500
STT_PARTIALS_ENABLED=true
STT_TRANSCRIPT_LOG_MAX_CHARS=16000
EOF

echo "[ok] Wrote ${OUT}"
echo "     Start Redis (if needed): bash scripts/dev_redis.sh"
echo "     Run runtime: npm run dev"
