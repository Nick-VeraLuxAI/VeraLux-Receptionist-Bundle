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

When **`HEALTH_VOICE_DEPENDENCIES=true`** (default in production images / compose):

- **Redis** — `PING`.
- **Whisper** — HTTP `GET` on the health URL derived from **`WHISPER_URL`** (same rules as `GET /health`).
- **TTS** — HTTP `GET` on the **`/health`** URL for the backend selected by **`TTS_MODE`** (`KOKORO_URL` → host `/health`, Coqui/Chatterbox/Qwen3 → base + `/health`).

All must return HTTP “ok” (fetch `response.ok`) within the server timeout (5s per dependency, parallel).

When **`HEALTH_VOICE_DEPENDENCIES=false`** (used in CI / redis-only test stacks):

- Only **Redis** is checked; JSON includes `voice_dependencies_checked: false`. **`GET /health`** behaves the same way (no Whisper/TTS probes).

### Kokoro health URL

`KOKORO_URL` like `http://kokoro:7001/tts` is normalized to **`http://kokoro:7001/health`** for probes (fixed path on the Kokoro container).

**Compose `runtime` healthcheck** uses **`GET /health/ready`**, with a long **`start_period`** so GPU/CPU model load can finish before failures count.

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

## 5. Optional LLM (local brain)

- **Inside Compose:** **`brain`** healthcheck + **`depends_on`** on **`vllm-qwen`** cover gateway readiness vs vLLM.
- **Host verification:** If **`BRAIN_USE_LOCAL=true`**, **`scripts/healthcheck.sh`** also requests **`http://127.0.0.1:${BRAIN_PORT}/health`** (default port **3001**). It does **not** probe vLLM on the host unless you add your own check (vLLM may only be reachable on **`VLLM_PORT`**).

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
