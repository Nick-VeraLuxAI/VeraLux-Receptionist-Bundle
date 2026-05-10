# Brain health dependency fix report

**Date:** 2026-05-09  
**Scope:** VeraLux voice runtime `GET /health/voice` and `GET /health/ready` in **`HEALTH_VOICE_DEPENDENCIES=strict`** mode.

## Root cause

- **Primary (D):** Strict readiness treated any configured brain HTTP target (`LLM_HEALTH_URL` or `BRAIN_URL` → derived `/health`) as **blocking**, whenever `BRAIN_USE_LOCAL=false` and a URL existed.
- **Secondary (B):** Example and compose-friendly values such as `BRAIN_URL=http://brain:3001` point at a service that exists **only** when Compose profile **`llm`** is started. Default production GPU stacks often omit that profile, so `fetch` failed with **`fetch failed`** and `/health/voice` returned **`not_ready`** even though Redis, Whisper, and TTS were healthy.

Telnyx signature verification, STT/TTS/audio paths, and local GPU wiring were not changed.

## Is the brain required or optional?

- **Runtime LLM / brain for calls:** Still driven by **`BRAIN_USE_LOCAL`**, **`BRAIN_URL`**, and the optional **`llm`** Compose profile (unchanged).
- **Readiness gate for strict `/health/voice` and strict `/health/ready`:** The HTTP brain check is **optional by default**. It becomes **required for readiness** only when **`BRAIN_HEALTH_REQUIRED=true`** and a brain health URL exists (and `BRAIN_USE_LOCAL` is false).

## Files changed

| Area | Path |
|------|------|
| Brain gate logic | `veralux-voice-runtime/src/healthBrainGate.ts` |
| Env schema | `veralux-voice-runtime/src/env.ts` |
| HTTP routes | `veralux-voice-runtime/src/routes/health.ts` |
| Tests | `veralux-voice-runtime/tests/healthBrainGate.test.ts` |
| Compose (runtime env passthrough) | `docker-compose.yml` |
| Examples / docs | `veralux-voice-runtime/.env.example`, root `.env.example`, `.env.local-gpu.example`, `.env.production.example`, `HEALTH_MODEL.md`, `docs/LOCAL_GPU_DEPLOYMENT.md`, `docs/PORTABLE_DEPLOYMENT_ARCHITECTURE.md` |

## Env vars

| Variable | Default | Role |
|----------|---------|------|
| **`BRAIN_HEALTH_REQUIRED`** | **`false`** | When **`true`**, strict `/health/voice` and strict `/health/ready` **fail** if the brain HTTP probe fails. When **`false`**, brain is reported but does **not** flip overall status to `not_ready`. |
| **`BRAIN_USE_LOCAL`** | `false` | When **`true`**, no HTTP brain probe; `checks.brain.status` is **`skipped_local`**. |
| **`BRAIN_URL`** | optional | Used to derive **`…/health`** when **`LLM_HEALTH_URL`** is unset (only matters for probing when **`BRAIN_HEALTH_REQUIRED=true`**). |
| **`LLM_HEALTH_URL`** | optional | When set, strict brain probe uses this URL first (same as before for “which URL to hit” when required). |
| **`HEALTH_VOICE_DEPENDENCIES`** | `strict` (legacy `true`) | Unchanged: Redis + STT + TTS remain strict in **`strict`** mode. |

## `checks.brain` shape (strict mode)

- **`ok`**, **`status`**: `ok` \| `failed` \| `skipped_optional` \| `not_configured` \| `skipped_local`
- **`reason`**: present on skip / not-configured paths (no secrets)
- **`latency_ms`**, **`error`**: present when an HTTP probe ran (`ok` / `failed`)

Response field **`brain_checked`**: **`true`** only when an HTTP GET was performed.

## Exact production commands (optional LLM stack)

When you **do** want the brain container and vLLM up (profile **`llm`**), from the repo root (project name may vary):

```bash
docker compose -p veralux --profile llm up -d vllm-qwen brain
```

Align runtime env with **`BRAIN_URL=http://brain:3001`** (or your service hostname) and, if brain must gate readiness:

```bash
export BRAIN_HEALTH_REQUIRED=true
```

## Validation (local)

Commands run from the repository root on 2026-05-09:

```bash
npm run build -w veralux-voice-runtime
npm test -w veralux-voice-runtime
npm run test:production-readiness
```

**Result:** all completed with **exit code 0**.

## Verify on a running runtime

```bash
curl -s http://localhost:4001/health/voice
```

With **`BRAIN_HEALTH_REQUIRED=false`** (default), Redis/STT/TTS healthy, and no brain container, expect **`"status":"ok"`** and **`checks.brain.status`** of **`skipped_optional`** or **`not_configured`** (depending on whether `BRAIN_URL` / `LLM_HEALTH_URL` is set). With **`BRAIN_HEALTH_REQUIRED=true`** and brain down, expect **`"status":"not_ready"`** and **`checks.brain.status":"failed"`**.
