# Health model (liveness vs readiness)

This document defines what **healthy** means for the Veralux receptionist stack, how that maps to HTTP endpoints, Docker healthchecks, and the host **`scripts/healthcheck.sh`** helper.

---

## 1. Summary

| Layer | Purpose | When it passes |
|--------|---------|----------------|
| **Liveness** | Process is up (restart if wedged) | HTTP server responds; **no** dependency checks. |
| **Readiness** | Safe to receive traffic that needs that service | **Dependencies** required for that role are reachable. |
| **Deep diagnostic** | Operator / SRE visibility | Full JSON with per-check latency; may return HTTP 200 while **degraded**. |

Docker Compose only exposes **one** healthcheck per service. For **`control`** and **`runtime`**, that probe is **readiness**, not liveness, so `depends_on: condition: service_healthy` and tunnel services do not start before the stack can actually serve.

---

## 2. Control plane (port 4000 inside the container)

| Endpoint | HTTP | Meaning |
|----------|------|---------|
| **`GET /health`** | Always **200** if the Node process is listening | **Liveness** only. Does **not** prove Postgres or Redis. |
| **`GET /ready`** | **200** if DB ping succeeds and (when enabled) Redis checks pass; else **503** | **Readiness** for admin UI, APIs, and runtime publishing. |

**Compose `control` healthcheck** uses **`GET /ready`** (not `/health`).

`ENABLE_RUNTIME_ADMIN` gates whether runtime-publisher Redis is required on `/ready` (see `control-plane/src/server.ts`).

---

## 3. Voice runtime (port 4001 inside the container)

| Endpoint | HTTP | Meaning |
|----------|------|---------|
| **`GET /health/live`** | **200** | **Liveness** — process only. |
| **`GET /health/ready`** | **200** if checks pass; **503** if not | **Readiness** — see below. |
| **`GET /health`** | **503** only if Redis is down; **200** with `status: degraded` if Whisper/TTS fail | **Diagnostic** aggregate; includes `voice_ready` and `voice_dependencies_checked` when voice checks run. |

### Readiness (`GET /health/ready`)

**`HEALTH_VOICE_DEPENDENCIES`** accepts **`strict`**, **`configured`**, or **`disabled`**, and still accepts legacy boolean strings **`true`** / **`false`** (mapped to `strict` / `disabled`).

When **`strict`** (default; legacy `true`):

- **Redis** — `PING`.
- **Whisper** — HTTP `GET` on **`STT_HEALTH_URL`** if set, otherwise the health URL derived from **`WHISPER_URL`** (same rules as `GET /health`).
- **TTS** — HTTP `GET` on **`TTS_HEALTH_URL`** if set, otherwise the **`/health`** URL for the backend selected by **`TTS_MODE`** (`KOKORO_URL` → host `/health`, Coqui/Chatterbox/Qwen3 → base + `/health`).
- **Brain (optional by default)** — strict mode only performs an HTTP brain probe when **`BRAIN_HEALTH_REQUIRED=true`**. The probe URL is **`LLM_HEALTH_URL`** if set, otherwise **`BRAIN_URL`** normalized to **`/health`** (same origin rules as before; strips trailing **`/reply`** / **`/reply/stream`**). When **`BRAIN_HEALTH_REQUIRED=false`** (default), JSON reports **`checks.brain.status`** as **`skipped_optional`**, **`not_configured`**, or **`skipped_local`** without failing overall readiness. When **`BRAIN_USE_LOCAL=true`**, no HTTP brain probe runs (**`skipped_local`**).

All probed URLs (those that run) must return HTTP “ok” (fetch `response.ok`) within the server timeout (5s per dependency, parallel).

When **`configured`**:

- **Redis** must pass; **STT/TTS env contract** must be present (same URL requirements as runtime `env.ts`).
- Optional HTTP probes run **only** when **`STT_HEALTH_URL`**, **`TTS_HEALTH_URL`**, or **`LLM_HEALTH_URL`** are set (for providers without VeraLux-style derived `/health`).

When **`disabled`** (legacy `false`):

- Only **Redis** is checked for `/health/ready`, `/health/voice`, and `/health` aggregate voice gates; JSON includes `voice_dependencies_checked: false`.

### Kokoro health URL

`KOKORO_URL` like `http://kokoro:7001/tts` is normalized to **`http://kokoro:7001/health`** for probes (fixed path on the Kokoro container).

**Compose `runtime` healthcheck** uses **`GET /health/voice`**, with a long **`start_period`** so GPU/CPU model load can finish before failures count.

---

## 4. Infrastructure and profile-gated services

| Service | Docker healthcheck | Notes |
|---------|-------------------|--------|
| **postgres** | `pg_isready` | Readiness for SQL connections. |
| **redis** | `redis-cli ping` | Readiness for Redis protocol. |
| **whisper-*** / **kokoro-*** / **xtts-*** / **chatterbox-*** / **qwen3-tts-*** | `curl` → container **`/health`** | Profile **`gpu`** or **`cpu`**; long **`start_period`** where models are heavy. |
| **vllm-qwen** (profile **`llm`**) | HTTP `GET /health` on :8000 | Model load can take many minutes (`start_period` large). |
| **brain** (profile **`llm`**) | `wget` → **`/health`** | **`depends_on: vllm-qwen` `service_healthy`** — brain starts after vLLM reports healthy. |
| **cloudflared** / **ngrok** | (image defaults or none) | **`depends_on`** **`runtime`** + **`control`** with **`service_healthy`** so tunnels attach after readiness probes pass. |

**Gap (by design):** **`runtime`** does not `depends_on` Whisper/TTS containers, because those services live under **profiles** and duplicate service names (`whisper-gpu` / `whisper-cpu`). Ordering is enforced indirectly: runtime readiness fails until Whisper/TTS HTTP health succeeds, and audio containers have their own healthchecks.

---

## 5. Optional LLM (vLLM + brain-gpt4o)

- **Compose:** Services **`vllm-qwen`** and **`brain`** use profile **`llm`**, attach to **`veralux-network`**, and are started by **`scripts/start-production.sh`** when **`VERALUX_ENABLE_LOCAL_LLM`**, **`VERALUX_EXTRA_COMPOSE_PROFILES`**, or a non-local **`BRAIN_URL`** targeting **`http://brain…`** is set (see **`deploy/production-env-fragment.env`**). **`brain`** `depends_on` **`vllm-qwen`** `service_healthy`; **`OPENAI_BASE_URL`** inside the brain container points at **`http://vllm-qwen:8000/v1`**.
- **`GET /health/voice` (runtime):** When **`BRAIN_HEALTH_REQUIRED=true`**, **`BRAIN_USE_LOCAL=false`**, and a brain health target exists (**`LLM_HEALTH_URL`** or derived from **`BRAIN_URL`**), the runtime probes **`GET /health`** on that URL. When **`BRAIN_HEALTH_REQUIRED=false`** (default), the brain HTTP check does not gate readiness (see §3 **`strict`**). When **`BRAIN_USE_LOCAL=true`**, the HTTP brain probe is skipped (in-process keyword brain only).
- **Host verification:** If **`BRAIN_USE_LOCAL=true`** and you run a brain container on the host, **`scripts/healthcheck.sh`** may request **`http://127.0.0.1:${BRAIN_PORT}/health`**. It does **not** probe vLLM on the host unless you add your own check (vLLM may only be reachable on **`VLLM_PORT`**).

**OpenAI / remote LLM:** No container healthcheck; readiness of external APIs is **not** part of Docker or **`GET /health/ready`**.

---

## 6. Operator verification

**Readiness (recommended after `deploy.sh up`):**

```bash
./scripts/healthcheck.sh
```

**Liveness only** (emergency “is anything listening?”):

```bash
./scripts/healthcheck.sh --liveness
```

**Container state:**

```bash
./deploy.sh status
docker inspect --format '{{.State.Health.Status}}' veralux-runtime
```

**Deep JSON (runtime):**

```bash
curl -sS "http://127.0.0.1:${RUNTIME_PORT:-4001}/health" | jq .
```

---

## 7. Unavoidable async behavior

- **Model load:** Whisper, XTTS, Chatterbox, Qwen3-TTS, and vLLM can take **minutes** after the container starts before **`/health`** returns success. Docker **`start_period`** and probe **`retries`** absorb that; until then, **`runtime`** may stay **starting** or **unhealthy** — that is **expected**, not a false positive.
- **First request / cold GPU:** Even after `/health` is OK, the first real STT/TTS call may be slower (CUDA kernels, caches). That is **not** fully represented by HTTP health endpoints.
- **Tenant / Telnyx:** No health endpoint proves **Telnyx** reachability, **DNS**, **TLS**, or **per-tenant** Redis config; use **`PRECHECKS.md`**, **`scripts/preflight.sh`**, and a test call.
- **Single probe per container:** Compose cannot combine separate liveness and readiness probes. We prioritize **readiness** for **`control`** and **`runtime`** so dependents and tunnels do not go live early. Process crashes still surface as **exited** / restart, not as **unhealthy**.

---

## 8. Related files

- `docker-compose.yml` — healthcheck definitions and `depends_on`.
- `veralux-voice-runtime/src/routes/health.ts` — runtime liveness / readiness / diagnostic.
- `control-plane/src/server.ts` — `GET /health`, `GET /ready`.
- `scripts/healthcheck.sh` — host-side readiness (and optional liveness).
- `deploy.sh` — waits on **postgres** / **redis** / **control** Docker health before runtime update paths.
