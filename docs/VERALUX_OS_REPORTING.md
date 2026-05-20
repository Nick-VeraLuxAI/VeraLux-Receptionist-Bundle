# Reporting to VeraLux OS (Receptionist control plane)

Optional. The **control plane** sends heartbeats and **aggregate** DB metrics (call row counts, approximate missed-by-stage filter, call-quality summary row counts, analytics call_count sum). No transcripts, history, recordings, or phone numbers are transmitted.

## Environment

Same pattern as Solomon; use `VERALUX_PRODUCT_TYPE=receptionist` (default in reporter).

| Variable | Notes |
|----------|--------|
| `VERALUX_OS_REPORTING_ENABLED` | `true` to enable |
| `VERALUX_OS_URL` | VeraLux System base URL |
| `VERALUX_OS_API_KEY` | Matches OS `VERALUX_INTERNAL_API_KEY` |
| `VERALUX_DEPLOYMENT_ID` | Stable deployment identifier |
| `VERALUX_DEPLOYMENT_PUBLIC_URL` | Optional public control-plane URL |
| `VERALUX_OS_HEARTBEAT_INTERVAL_MS` | Optional |
| `VERALUX_OS_METRICS_INTERVAL_MS` | Optional |

## Code

`control-plane/src/veraluxOsReporter.ts`, started from `control-plane/src/server.ts` after the HTTP server listens. STT/TTS runtime error counters are **not** included in Phase 1 (would require a separate voice-runtime reporter).
