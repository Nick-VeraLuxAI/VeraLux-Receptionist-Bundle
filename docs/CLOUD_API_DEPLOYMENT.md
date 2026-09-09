# Cloud API deployment profile (`cloud-api`)

**Intent:** Run **control plane + voice runtime** (and Postgres/Redis) on **VPS, Render, Railway, ECS, etc.** with **no GPU containers**. STT, TTS, and (usually) LLM are provided by **external HTTP APIs** or first-class frontier adapters (`openai_whisper`, `deepgram`, `openai_tts`, `elevenlabs`, tenant BYOK LLMs).

Admin **Pipeline** (`/admin/pipeline`) composes those components, estimates $/min from a live rate card, and can provision an isolated stack. See [`CLOUD_HOSTED_PIPELINE.md`](CLOUD_HOSTED_PIPELINE.md).

---

## What fits this profile today

| Capability | Mechanism | Notes |
|------------|-----------|--------|
| **LLM** | `LLM_PROVIDER=openai` + `OPENAI_API_KEY` / model; or **HTTP brain** `BRAIN_URL` pointing to **any OpenAI-compatible** server (hosted GPT proxy, OpenRouter, etc.) | Runtime `brain-gpt4o` contract: `/reply`, `/reply/stream`, `/health` |
| **TTS** | `TTS_MODE=openai_tts` / `elevenlabs`, or self-hosted HTTP (`kokoro_http`, `coqui_xtts`, …) | Cloud modes need `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`. HTTP modes need the same route shapes the runtime calls. |
| **STT** | `openai_whisper` / `deepgram` (tenant pipeline) **or** `WHISPER_URL` WhisperHttp | Native OpenAI / Deepgram adapters send chunked PCM as WAV. Set `DEEPGRAM_API_KEY` / `OPENAI_API_KEY` on the runtime. |

---

## What does **not** fit without new work

- Streaming Deepgram / Telnyx-native STT (chunked cloud STT is implemented). Kubernetes remains unsupported.
- **Strict voice health** on providers that **lack** `GET /health` — use **`HEALTH_VOICE_DEPENDENCIES=configured`** so readiness checks keys/URLs without probing vendor `/health`. Strict mode still needs a probe URL or `STT_HEALTH_URL` / `TTS_HEALTH_URL`.
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
