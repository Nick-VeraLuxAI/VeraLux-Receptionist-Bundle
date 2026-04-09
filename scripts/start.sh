#!/usr/bin/env bash
# Same startup path as ./up and ./deploy.sh up (Compose profiles for Whisper/TTS).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/deploy.sh" up "$@"
