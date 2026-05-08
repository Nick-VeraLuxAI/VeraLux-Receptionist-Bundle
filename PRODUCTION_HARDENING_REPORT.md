# Production hardening report (deployment consolidation)

## Changes applied (code + ops wiring)

1. **Single Docker network for voice:** All STT/TTS services used in production are started from the **main** `docker-compose.yml` (`--profile gpu` or `cpu`) so `whisper`, `chatterbox`, etc. resolve on **`veralux-network`**.
2. **Legacy split stack:** `veralux-audio-stack` can still attach to `veralux-network` (see `veralux-audio-stack/docker-compose.yml`) but `start-production.sh` runs `docker compose … down` on that project to prevent duplicate Whisper/TTS.
3. **Env authority:** `docker-compose.production.yml` injects container env from **`${VERALUX_COMPOSE_ENV_FILE}`** (merge of `/etc/veralux/voice-runtime.env` + `deploy/production-env-fragment.env` in the bring-up script).
4. **Honest readiness:** New **`GET /health/voice`**, strict **`GET /health/ready`**, runtime healthcheck now targets `/health/voice`.
5. **Cloudflared duplication:** Docker service moved to profile **`docker-cloudflared-legacy`**; production should rely on **systemd** `cloudflared`. `start-production.sh` stops `veralux-cloudflared` if it is running.
6. **Scripts:** `scripts/start-production.sh`, `stop-production.sh`, `status-production.sh`, `validate-voice-topology.sh`, `merge-voice-env.py`.
7. **Runtime `NODE_ENV=production` + STT debug dirs:** the main compose default `${STT_DEBUG_DIR:-/app/...}` prevents an “empty” `.env` value from clearing debug mode. `docker-compose.production.yml` now forces empty `STT_DEBUG_DIR` / disables dump flags on `runtime` so production boot is not blocked (`ALLOW_PROD_DEBUG_CAPTURE` gate in `env.ts`).

## Remaining risks

| Risk | Mitigation |
|------|------------|
| `/etc/veralux/voice-runtime.env` still contains `CHANGE_ME_*` | Replace with strong secrets; use `VERALUX_STRICT_SECRETS=1 ./scripts/start-production.sh` to hard-fail on placeholders. |
| **Empty `HF_TOKEN`** | Chatterbox may fail model download; set token on HF and accept model license. |
| **Two Cloudflare tunnels** | Audit Cloudflare Zero Trust routes; only one process should own `voice.veralux.ai`. |
| **Runtime image pin** | Rebuild/push `veralux-voice-runtime` when releasing so managed hosts pick up `/health/voice`. |
| **Brain + vLLM** | `brain` service still declares `depends_on: vllm-qwen`; hosts running `brain` without vLLM may be manually overridden—reconcile in a follow-up (out of scope). |

## Verification commands (no secrets)

```bash
curl -sS http://127.0.0.1:4001/health/voice -w '\nHTTP %{http_code}\n'
docker exec veralux-runtime getent hosts whisper chatterbox 2>/dev/null
./scripts/validate-voice-topology.sh "$VERALUX_COMPOSE_ENV_FILE"
```
