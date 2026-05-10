# Local GPU deployment profile (`local-gpu`)

This profile matches the **primary** documented stack: **Docker Compose** on a host with **optional NVIDIA GPUs**, local **Whisper** HTTP, local **TTS** (Kokoro, XTTS, Chatterbox, or Qwen3-TTS), and optional **vLLM + brain** for OpenAI-compatible local LLM.

---

## Goals

- **Local Whisper** (GPU or CPU image selected by `./deploy.sh`).
- **Local Chatterbox** when `TTS_MODE=chatterbox_http` (Compose service **`chatterbox-gpu`** only today — requires GPU profile).
- **Optional local brain** (`--profile llm`: `vllm-qwen`, `brain`); runtime `BRAIN_URL` → `http://brain:3001` (path `/reply` as documented).
- **Docker Compose GPU profile** via `deploy.sh` → `--profile gpu` when `nvidia-smi` / Docker reports NVIDIA.

---

## What is already wired

| Piece | Location / behavior |
|--------|----------------------|
| GPU services | `docker-compose.yml` services `whisper-gpu`, `kokoro-gpu`, `xtts-gpu`, `chatterbox-gpu`, `qwen3-tts-gpu` under **`profiles: [gpu]`** |
| CPU fallback | `whisper-cpu`, `kokoro-cpu`, `xtts-cpu`, `qwen3-tts-cpu` under **`profiles: [cpu]`** — **no Chatterbox-CPU** |
| Runtime defaults | `WHISPER_URL`, `KOKORO_URL`, `COQUI_XTTS_URL`, `CHATTERBOX_URL`, `QWEN3_TTS_URL` default to **Docker DNS** service names (`whisper:9000`, etc.) |
| LLM stack | `vllm-qwen` + `brain` under **`profiles: [llm]`**; brain `OPENAI_BASE_URL=http://vllm-qwen:8000/v1` |
| Production paths | `VERALUX_PROD_ROOT`, `/etc/veralux/voice-runtime.env`, `scripts/start-production.sh` — **optional**; not required for generic GPU workstation |

---

## Environment essentials

Set in `.env` (and optionally `.env.internal`):

- **Images:** `REGISTRY`, `VERSION`
- **Core:** `POSTGRES_*`, `JWT_SECRET`, `ADMIN_API_KEY`, `SECRET_ENCRYPTION_KEY`, `MEDIA_STREAM_TOKEN`
- **Public URLs:** `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `BASE_URL` (use real HTTPS hostnames for Telnyx; localhost only for pure local media tests)
- **Telnyx:** `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_PHONE_NUMBER`, `TELNYX_VERIFY_SIGNATURES`
- **Voice:** `TTS_MODE`, `WHISPER_URL` (if not using compose defaults), `HF_TOKEN` for gated models (Chatterbox, Qwen3)
- **Optional LLM profile:** `BRAIN_URL`, `BRAIN_USE_LOCAL=false`, `VLLM_*` as in compose comments

**GPU device selection:** `WHISPER_GPU_IDS`, `KOKORO_GPU_IDS`, `XTTS_GPU_IDS`, `CHATTERBOX_GPU_IDS`, `QWEN3_TTS_GPU_IDS`, `VLLM_GPU_IDS` (see `docker-compose.yml`).

---

## Health and readiness

- Runtime **`GET /health/voice`** and **`GET /health/ready`** (when `HEALTH_VOICE_DEPENDENCIES=true`) probe **Whisper** and **active TTS** HTTP **`/health`** endpoints derived from env (`veralux-voice-runtime/src/routes/health.ts`).
- **Brain** HTTP is **optional** for readiness unless **`BRAIN_HEALTH_REQUIRED=true`** (default false). With the optional **`llm`** profile off, leave **`BRAIN_HEALTH_REQUIRED=false`** so a template **`BRAIN_URL`** does not block **`/health/voice`**.

---

## Known limitations (this profile)

1. **Chatterbox** requires **GPU compose** path; no symmetric `chatterbox-cpu` in root compose.
2. **Plain `docker compose up`** without profile **does not** start audio services — use **`./deploy.sh up`** or pass **`--profile gpu`** explicitly.
3. **Forensics / debug** default paths use **`/data/...`** in container examples — mount volumes explicitly if you rely on persistence.

---

## Commands (Sprint 2A)

```bash
./scripts/preflight-profile.sh --profile local-gpu
./scripts/preflight-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env
# Optional: merge a second file after --env-file (e.g. only REDIS_URL=redis://redis:6379/0)
./scripts/preflight-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env --fragment-env ./path/to/extra.env
./scripts/deploy-profile.sh --profile local-gpu
./scripts/deploy-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env [--fragment-env ./path/to/extra.env]
./scripts/validate-profile.sh --profile local-gpu
docker compose -f docker-compose.yml -f docker-compose.local-gpu.yml -p veralux --profile gpu config
```

### Redis and split env files

Production often keeps **secrets and URLs** in `/etc/veralux/voice-runtime.env` while **`docker-compose.yml`** still injects **`REDIS_URL=redis://redis:6379`** on **`control`** and **`runtime`**. In that model **`REDIS_URL` may be absent** from the voice env file alone.

**`scripts/preflight-profile.sh`** accepts that layout when the repo’s **`docker-compose.yml`** includes the bundled **`redis`** service: it prints **`Redis source: bundled compose service "redis"`** and does **not** require `REDIS_URL` in `--env-file` for structural preflight. If you maintain Redis only in a separate operator file, pass it with **`--fragment-env`** (merged after all **`--env-file`** arguments). Values are **never** echoed.

The default workstation path **`./deploy.sh up`** is unchanged when `DEPLOYMENT_PROFILE` is unset.

---

## Compose overlay

`docker-compose.local-gpu.yml` is an **empty merge overlay** (marker file) so `deploy-profile.sh` can select a stable `-f` list; GPU services remain defined only in `docker-compose.yml` with **`--profile gpu`**.
