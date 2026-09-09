#!/usr/bin/env bash
# Mandatory Kokoro CUDA warmup before any sales/proof dial.
# Cold first /tts after container start is ~40s+; warm path is ~37ms.
set -euo pipefail
URL="${KOKORO_URL:-http://127.0.0.1:7001/tts}"
echo "warmup-kokoro: $URL"
for i in 1 2 3; do
  curl -sf -o /dev/null -w "ping$i=%{time_total}s http=%{http_code}\n" \
    -H "Content-Type: application/json" \
    -d "{"text":"Hi thanks for calling.","voice":"af_heart"}" \
    "$URL"
done
echo "warmup-kokoro: done"
