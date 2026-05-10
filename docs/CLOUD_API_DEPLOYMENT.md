# Cloud API deployment profile (`cloud-api`)

**Intent:** Run **control plane + voice runtime** (and Postgres/Redis) on **VPS, Render, Railway, ECS, etc.** with **no GPU containers**. STT, TTS, and (usually) LLM are provided by **external HTTP APIs** compatible with what the runtime already implements.

---

## What fits this profile today

| Capability | Mechanism | Notes |
|------------|-----------|--------|
| **LLM** | `LLM_PROVIDER=openai` + `OPENAI_API_KEY` / model; or **HTTP brain** `BRAIN_URL` pointing to **any OpenAI-compatible** server (hosted GPT proxy, OpenRouter, etc.) | Runtime `brain-gpt4o` contract: `/reply`, `/reply/stream`, `/health` |
| **TTS** | `TTS_MODE=kokoro_http` or `coqui_xtts` (or `qwen3_tts_http` if you host Qwen3 HTTP elsewhere) | Requires HTTP server with the **same route shapes** the runtime calls (see `veralux-voice-runtime` TTS clients) |
| **STT** | **`WHISPER_URL`** must point to an HTTP endpoint implementing the **WhisperHttp** contract (PCM/WAV pipeline) | **Not** “drop in OpenAI `/v1/audio/transcriptions`” without an adapter service in front |

---

## What does **not** fit without new work

- **Native OpenAI STT/TTS** as first-class env switches (`STT_PROVIDER=openai`) — **not present**; only **`WhisperHttpProvider`** + mode-based TTS.
- **Strict voice health** on providers that **lack** `GET /health` at the URL derived from `WHISPER_URL` / TTS base — you must set **`HEALTH_VOICE_DEPENDENCIES=false`** (weakens readiness) **or** add small **adapter sidecars** that expose `/health`.
- **`TTS_MODE=chatterbox_http`** without a **remote** Chatterbox-compatible server — there is **no** CPU Chatterbox service in root `docker-compose.yml`.

---

## Compose footprint

**Minimal services:** `postgres`, `redis`, `control`, `runtime`.

**Do not start:** `gpu` / `cpu` audio profiles **if** every URL points outside the compose network.

**Example env pattern (illustrative — no secrets):**

```bash
DEPLOYMENT_PROFILE=cloud-api
TTS_MODE=kokoro_http
WHISPER_URL=https://stt.example.com/transcribe
KOKORO_URL=https://tts.example.com/tts
BRAIN_USE_LOCAL=false
BRAIN_URL=https://llm.example.com
PUBLIC_BASE_URL=https://voice.example.com
AUDIO_PUBLIC_BASE_URL=https://voice.example.com/audio
```

Ensure **`CONTROL_URL`** / runtime-to-control and **`REDIS_URL`** match your orchestrator when you use **external** Redis (Compose service name vs managed hostname). The **default** `docker-compose.yml` **cloud-api** stack still includes a bundled **`redis`** service and sets **`REDIS_URL=redis://redis:6379`** on **`control`** / **`runtime`** — **`scripts/preflight-profile.sh`** accepts that model when `REDIS_URL` is absent from your `--env-file` alone (same as local-gpu). Use **`--fragment-env`** to merge an extra file after **`--env-file`** if you split variables.

---

## Render / Railway / small VPS

| Concern | Guidance |
|---------|----------|
| **Webhook + media** | Telnyx needs **stable public HTTPS** and WebSocket-capable ingress to runtime **port 4001** (or mapped port). |
| **Disk** | `AUDIO_STORAGE_DIR` and optional forensics need **writable persistent disk** if you keep greetings and WAVs on volume. |
| **Redis** | Runtime uses Redis for tenant map, capacity, TTS cache — **latency** to Redis matters for call setup. |
| **Health checks** | Platform HTTP health should hit **`/health/live`** (liveness) and optionally **`/health/ready`** with understanding of external STT/TTS deps. |
| **Secrets** | Use platform secret stores; never bake into images. |

---

## Portal note

Non–super-admin **`GET /api/tts/config`** returns **`SafeTtsPublicConfig`** (endpoint flags, no raw infra URLs). **Superadmin** operator console still receives full URLs for editing. Optional **`?diagnostics=1`** (superadmin) adds **redacted** host previews.

---

## Commands (Sprint 2A)

```bash
./scripts/preflight-profile.sh --profile cloud-api [--env-file /path/to.env] [--fragment-env /path/to.bridge.env]
./scripts/deploy-profile.sh --profile cloud-api [--env-file …] [--fragment-env …]
./scripts/validate-profile.sh --profile cloud-api [--env-file …] [--fragment-env …]
docker compose -f docker-compose.yml -f docker-compose.cloud-api.yml -p veralux config
```

Copy `.env.cloud-api.example` into your real env file and replace placeholders (no secrets in the example).

---

## Preflight rules (`scripts/preflight-profile.sh`)

- Fail if `PUBLIC_BASE_URL` or `AUDIO_PUBLIC_BASE_URL` contains `localhost` / `127.0.0.1` when `TELNYX_VERIFY_SIGNATURES=true` and non-dev.
- Warn if `WHISPER_URL` / TTS URLs are still Docker internal hostnames (`http://whisper:…`) while `DEPLOYMENT_PROFILE=cloud-api`.
