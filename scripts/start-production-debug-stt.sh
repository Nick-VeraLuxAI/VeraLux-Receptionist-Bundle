#!/usr/bin/env bash
# Start production stack with STT WAV + call transcript capture (see deploy/production-env-debug-stt.env).
# Same as start-production.sh but sets VERALUX_STT_DEBUG=1 for the merge step.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export VERALUX_STT_DEBUG=1
exec "${SCRIPT_DIR}/start-production.sh" "$@"
