# Portable deployment architecture — audit and design

**Status:** Sprint 2A adds profile scripts, compose overlays, health modes, and portal-safe TTS payloads (see `docs/PORTABLE_DEPLOYMENT_SPRINT_2A_REPORT.md`).  
**Date:** 2026-05-09 (updated Sprint 2A)  
**Scope:** VeraLux Receptionist — Docker Compose stack, control plane, voice runtime, audio stack, deploy scripts.

---

## 1. Executive summary

The system is **already partially portable**: a single `docker-compose.yml` runs **control**, **runtime**, **Postgres**, and **Redis** everywhere; **STT/TTS** are selected via **Compose profiles** (`gpu` vs `cpu`) by `./deploy.sh` from `TTS_MODE` and NVIDIA detection. **LLM** can be **OpenAI** (`LLM_PROVIDER=openai`) or **local** (control-plane `local` + `LOCAL_LLM_URL`, runtime **HTTP brain** + optional **vLLM** profile).

**Gaps** for clean **local-gpu / cloud-api / hybrid** profiles: no first-class **`DEPLOYMENT_PROFILE`**, **STT is always “Whisper over HTTP”** (URL + contract), **health checks assume `/health` derivations** from Whisper/TTS URLs, **Chatterbox is GPU-only in Compose** (no CPU service), **scripts and docs anchor on `/opt/veralux` and systemd Cloudflare**, and **tenant/admin APIs still surface raw TTS (and some LLM) URLs** where not redacted.

---

## 2. Current topology (as implemented)

| Layer | Components | Notes |
|--------|--------------|--------|
| Core (always in root compose) | `control`, `runtime`, `postgres`, `redis` | Runtime `CONTROL_URL=http://control:4000`; optional `CONTROL_PLANE_URL` on runtime for callbacks |
| Audio (profiles `gpu` or `cpu`) | Whisper, Kokoro, XTTS, Qwen3-TTS (GPU+CPU variants) | **Chatterbox: `chatterbox-gpu` only** under profile `gpu` |
| Optional | `llm` profile: `vllm-qwen`, `brain` | Brain uses OpenAI-compatible API against vLLM |
| Tunnels (optional) | `docker-cloudflared-legacy`, `ngrok` | Production docs prefer **host** `cloudflared`, not Docker |

**Primary entrypoints:** `./deploy.sh up` (runs `scripts/preflight.sh`), `docker compose -f docker-compose.yml -p veralux --profile gpu|cpu up`.

---

## 3. Deployment profiles (recommended mapping)

### 3.1 `local-gpu`

| Service | Required | Notes |
|---------|----------|--------|
| Postgres, Redis | Yes | Same as today |
| Control + Runtime | Yes | |
| Whisper | Yes | `whisper-gpu` (or CPU if no GPU) |
| TTS | Yes | GPU: Kokoro / XTTS / Chatterbox / Qwen3 per `TTS_MODE` |
| vLLM + brain | Optional | `--profile llm`; `BRAIN_URL` → brain container |
| Cloudflare/ngrok | Optional | Dev/public URL for Telnyx |

### 3.2 `cloud-api`

| Service | Required | Notes |
|---------|----------|--------|
| Postgres, Redis | Yes | Managed DB/Redis acceptable if URLs injected |
| Control + Runtime | Yes | **Runtime must reach** external STT/TTS (and brain if used) over HTTPS |
| Local Whisper/Kokoro images | **No** | Set `WHISPER_URL`, `KOKORO_URL` / `COQUI_XTTS_URL` / etc. to **vendor or self-hosted HTTP** endpoints |
| GPU nodes | **No** | Unless you still host custom GPU endpoints elsewhere |

**Blockers today:** health pipeline assumes Whisper health at `WHISPER_URL` with path rewrite to `/health` (see `veralux-voice-runtime/src/routes/health.ts`). Many cloud STT APIs **do not** expose that shape. `TTS_MODE=chatterbox_http` **implies** a Chatterbox-compatible server; none is defined in `cpu` profile.

### 3.3 `hybrid`

| Location | Typical services |
|----------|------------------|
| Cloud | Control plane, Postgres, Redis (or Redis near runtime), public ingress, Telnyx webhooks → **runtime public URL** |
| GPU host | Whisper + TTS (and/or vLLM+brain) reachable only via **private network**, **mTLS**, or **signed edge** — not ad hoc public URLs without hardening |

**Blockers today:** runtime↔control is `CONTROL_URL` / `CONTROL_PLANE_URL` env; **split regions** need stable **TLS**, **DNS**, and **firewall** rules. Redis is **assumed** reachable from runtime for tenant config and capacity; **cross-cloud Redis** is operationally sensitive (latency, split-brain). No built-in “GPU worker registration” or queue abstraction—**operational** pattern only.

---

## 4. Hardcoded or environment-anchored assumptions (audit)

### 4.1 `localhost` / `127.0.0.1`

- **Docker Compose healthchecks** probe `http://localhost:…` inside containers (control, runtime, audio services) — **normal** for in-container checks.
- **Defaults** in `control-plane/src/config.ts`: `DEFAULT_LOCAL_URL`, `DEFAULT_WHISPER_URL`, `DEFAULT_TTS_URL` use loopback when env unset.
- **Scripts:** `scripts/healthcheck.sh`, `scripts/start-production.sh`, `scripts/test-infra.sh`, control-plane helper scripts use `127.0.0.1` for local smoke checks.
- **Runtime** `env.ts` does not default `PUBLIC_BASE_URL` to loopback in production-safe way; operators must set public URLs for Telnyx.

### 4.2 `/opt` paths

- `docker-compose.yml` header, `scripts/start-production.sh`, `scripts/stop-production.sh`, `PRODUCTION_TOPOLOGY.md`, `DEPLOYMENT_CHECKLIST.md` reference **`VERALUX_PROD_ROOT` / `/opt/veralux/veralux-voice-runtime`**. Logical default for VeraTitan installs, **not** enforced in code paths inside Node beyond scripts.

### 4.3 `/data` paths

- **`AUDIO_FORENSICS_DIR`** default in runtime `env.ts`: `/data/veralux/voice/forensics`.
- **Redis** AOF volume mount pattern in ops docs (`/data/dump.rdb` examples).
- Forensics scripts default **`/data/veralux/voice/forensics`** when querying the container.

**Portable approach:** always set explicit volumes / env for writable dirs on Render/Railway (ephemeral disk) or bind mounts on VPS.

### 4.4 GPU-only assumptions

- **Compose:** NVIDIA `deploy.reservations.devices` on `whisper-gpu`, `kokoro-gpu`, `xtts-gpu`, `chatterbox-gpu`, `qwen3-tts-gpu`, `vllm-qwen`.
- **`deploy.sh`:** if NVIDIA present, selects `--profile gpu`; else `cpu`. **Chatterbox has no `chatterbox-cpu` service** — selecting `TTS_MODE=chatterbox_http` on a non-GPU host is a **configuration trap** unless `CHATTERBOX_URL` points to a **remote** GPU server.
- **brain-gpt4o / vLLM** assume CUDA images.

### 4.5 Whisper / Chatterbox assumptions

- **STT:** `WHISPER_URL` required; implementation is **`WhisperHttpProvider`** (PCM/WAV contract toward your HTTP server — see `veralux-voice-runtime/src/stt/providers/whisperHttp.ts`). Not a pluggable “OpenAI STT enum”; **URL + HTTP behavior** is the abstraction.
- **Chatterbox:** runtime expects HTTP base + routes documented in repo; **no** second STT mode for “Telnyx native” or “Deepgram” without new provider code.

### 4.6 Cloudflare

- Optional **`cloudflared`** Docker profile + **systemd** tunnel documented as production ingress.
- Control plane **removed** mutable global env from Cloudflare token POST (returns 410) — tokens are **env-only** (good for portable secrets).

### 4.7 Telnyx webhooks

- Runtime answers **`/v1/telnyx/webhook`** (and media WS); requires **`PUBLIC_BASE_URL`**, **`AUDIO_PUBLIC_BASE_URL`**, signature verification in production (`veralux-voice-runtime/src/env.ts` enforces no skip in `NODE_ENV=production`).
- **Preflight** (`PRECHECKS.md`, `scripts/preflight.sh`) warns on localhost public URLs — **correct** for PSTN.

---

## 5. Provider abstraction gaps

| Concern | Today | Gap |
|---------|--------|-----|
| **LLM** | Control: `LLM_PROVIDER` `local` \| `openai`; Runtime: `BRAIN_USE_LOCAL`, `BRAIN_URL`, OpenAI env for paths that call OpenAI directly | No single **`LLM_PROVIDER`** enum mirrored everywhere; “OpenAI-compatible base URL” is split across **brain** (`OPENAI_BASE_URL`) and control **`LOCAL_LLM_URL`** / OpenAI. |
| **STT** | `whisper_http` (+ legacy mode names) → `WhisperHttpProvider` | No **`STT_PROVIDER`** env; no first-class **Deepgram / Telnyx / cloud OpenAI** provider without new module. |
| **TTS** | `TTS_MODE` + URL per backend | Works if HTTP server matches expected routes; **no** generic “OpenAI TTS” adapter in contract. |
| **Health** | **`HEALTH_VOICE_DEPENDENCIES`**: `strict` (default) \| `configured` \| `disabled`; optional **`STT_HEALTH_URL`**, **`TTS_HEALTH_URL`**, **`LLM_HEALTH_URL`**; strict brain gating via **`BRAIN_HEALTH_REQUIRED`** (default false) | **`configured`** skips mandatory provider `/health` probes unless explicit health URLs are set. **`BRAIN_HEALTH_REQUIRED=false`** keeps Redis/STT/TTS strict while brain HTTP stays non-blocking. |
| **Fallback** | STT retries / unclear reprompt in runtime; TTS/cache | No automatic **fallback chain** (e.g. local Whisper → cloud) without product change. |

---

## 6. Client portal and raw URLs (security / portability)

**Sprint 2A (implemented):**

- **`GET /api/tts/config`**: **non–super-admin** responses use **`SafeTtsPublicConfig`** (endpoint flags, tuning fields, **no** raw `kokoroUrl` / `chatterboxUrl` / etc.). **Superadmin** still receives the **full** legacy payload for the operator console. Optional **`?diagnostics=1`** (superadmin) adds **redacted** host previews only.
- **`GET /api/admin/health`**: default JSON uses **flags** (`whisperEndpointConfigured`, `*EndpointConfigured`) instead of raw URLs; **`?diagnostics=1`** (superadmin) adds a **`diagnostics`** block with **redacted** placeholders.
- **`redactRuntimeConfig`** (runtime publish read path) delegates to **`redactPublishedRuntimeConfig`** in `@veralux/shared` — strips **`webhookSecret`**, redacts **STT/TTS URLs**, transfer/call-forwarding audio URLs, and masks **`webhookSecretRef`**.

---

## 7. Proposed environment schema (additive)

Introduce a **top-level** profile flag (read by scripts and docs; optional validation in preflight later):

```bash
# local-gpu | cloud-api | hybrid
DEPLOYMENT_PROFILE=local-gpu
```

**Provider enums (conceptual — map to existing vars first):**

| Variable | Suggested values | Maps to today |
|----------|------------------|---------------|
| `LLM_PROVIDER` | `openai` \| `local` \| `openai_compatible` | Control already uses `openai` / `local`; runtime uses brain + OpenAI keys in branches |
| `STT_PROVIDER` | `whisper_http` \| (future: `telnyx`, `deepgram`, …) | Today effectively always **`whisper_http`** via `WHISPER_URL` |
| `TTS_PROVIDER` or keep | `TTS_MODE` | `kokoro_http`, `coqui_xtts`, `chatterbox_http`, `qwen3_tts_http` |

**URLs / keys / models (existing — document per profile):**

- **STT:** `WHISPER_URL`, `STT_LANGUAGE`, optional `STT_WHISPER_PROMPT`
- **TTS:** `TTS_MODE`, `KOKORO_URL`, `COQUI_XTTS_URL`, `CHATTERBOX_URL`, `QWEN3_TTS_URL`, `CHATTERBOX_VARIANT`, voice/lang/rate knobs
- **LLM / brain:** `BRAIN_USE_LOCAL`, `BRAIN_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `LOCAL_LLM_URL`, control `LLM_PROVIDER`
- **Ingress:** `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `BASE_URL`, `MEDIA_STREAM_TOKEN`
- **Telnyx:** `TELNYX_*` as today
- **Infra:** `DATABASE_URL` / compose `POSTGRES_*`, `REDIS_URL`, `CONTROL_URL`, `CONTROL_PLANE_URL`, `CONTROL_PLANE_API_KEY` / `VOICE_CONTROL_API_KEY`
- **Health:** `HEALTH_VOICE_DEPENDENCIES=strict|configured|disabled` (legacy `true`/`false` accepted)

**Hybrid additions (operational):**

- `GPU_RUNTIME_STT_URL`, `GPU_RUNTIME_TTS_BASE_URL` (documentation aliases only until code supports split) — or document **single** `WHISPER_URL` pointing to GPU host VPN IP.

---

## 8. Proposed Compose layout (files — not implemented)

| File | Role |
|------|------|
| `docker-compose.yml` | **Shared base:** `control`, `runtime`, `postgres`, `redis`, networks, volumes |
| `docker-compose.local-gpu.yml` | **Merge:** `profiles: gpu`, optional `llm`, device reservations, published ports for local dev |
| `docker-compose.cloud-api.yml` | **Merge:** **no** whisper/kokoro/xtts services; **no** GPU; optional `HEALTH_VOICE_DEPENDENCIES` documented; depends_on trimmed |
| `docker-compose.hybrid.yml` | **Merge:** control+db in cloud fragment OR document two stacks: **cloud** compose + **gpu** compose with overlapping env |

**Implementation pattern:** `docker compose -f docker-compose.yml -f docker-compose.<profile>.yml up -d` (explicit merge). Keeps one source of truth and avoids duplicating 800+ lines.

---

## 9. Proposed scripts (design — not implemented)

| Script | Purpose |
|--------|---------|
| `scripts/deploy-profile.sh` | Resolve `DEPLOYMENT_PROFILE` → compose file list + profiles (`gpu`, `llm`, tunnels); call `deploy.sh` or `docker compose` with merged files |
| `scripts/preflight-profile.sh` | Profile-specific checks: e.g. `cloud-api` forbids localhost `PUBLIC_BASE_URL`; `local-gpu` checks `nvidia-smi` when `TTS_MODE` needs GPU; `hybrid` checks reachability from runtime VPC to GPU URLs |
| `scripts/validate-profile.sh` | Non-destructive: `compose config`, curl `/ready` endpoints, optional `telnyx` signature test mode |

---

## 10. Current blockers (for “any platform” launch)

**Sprint 2A addressed:** merge overlays (`docker-compose.*.yml`), **`deploy-profile.sh` / `preflight-profile.sh` / `validate-profile.sh`** (preflight: **`--fragment-env`**, bundled **Compose `redis`** when `REDIS_URL` omitted from split env files), **`HEALTH_VOICE_DEPENDENCIES`** modes + optional `*_HEALTH_URL`, and **portal/admin URL redaction** for non–super-admin (see §6).

**Still open:**

1. **Single monolithic `docker-compose.yml`** remains the source of truth; overlays are **additive** markers, not a full service split.
2. **Legacy `deploy.sh`** is unchanged; operators should prefer **`deploy-profile.sh`** for explicit profiles.
3. **Chatterbox** not available on **cpu** profile — **hybrid or GPU** only for `TTS_MODE=chatterbox_http` against local containers.
4. **Redis + runtime colocation** assumed for low latency; **split-region hybrid** needs explicit architecture (not code).

---

## 11. Required file changes (when implementing — ordered)

1. **Docs + examples only:** extend `.env.example` with `DEPLOYMENT_PROFILE` and profile-specific comments (no secret values).
2. **Compose:** add `docker-compose.*.yml` merge fragments; adjust `deploy.sh` to accept merged `-f` list from profile.
3. **Preflight:** `scripts/preflight-profile.sh` or extend `preflight.sh` with profile branches.
4. **Health:** optional `STT_HEALTH_URL` / `TTS_HEALTH_URL` or provider-specific health module (product change, small surface).
5. **Portal:** redact URLs in `GET /api/tts/config` (and related) for non–super-admin; align `getSafeTtsConfig` with real “safe” semantics.
6. **Optional STT providers:** only if cloud-api must not use Whisper HTTP at all.

---

## 12. Safest implementation order

1. **Documentation + env matrix** (this doc family + `.env.example` sections) — zero runtime risk.  
2. **Compose merge files + `deploy-profile.sh` wrapper** — infra only; no business logic.  
3. **Preflight / validate by profile** — fail fast before bad deploys.  
4. **Health URL overrides** — unblocks cloud-api on Render without disabling all voice checks.  
5. **Portal URL redaction** — security / customer trust.  
6. **New STT/TTS provider implementations** — only where revenue or compliance requires non-Whisper HTTP.

---

## 13. What runs where (quick reference)

| Target | Typical workload | Compose | GPU |
|--------|------------------|---------|-----|
| **Render / Railway** | Control + runtime + worker; **external** managed Postgres/Redis | **Possible** with persistent disk for audio; **no** NVIDIA | **No** — use cloud APIs or remote GPU URLs |
| **Generic VPS** | Full stack like today | **Yes** | Optional if instance has GPU + drivers |
| **Managed container (ECS/K8s)** | Split services | Compose **or** Helm — translate same services | GPU node pool for audio/brain only |
| **Local workstation** | Dev / pilot | **Yes** | Optional — `deploy.sh` picks gpu/cpu |

**Requires Docker Compose today:** multi-container **local** story (Postgres, Redis, audio sidecars) is **documented and scripted** around Compose. **Single-container** or **split microservices** would be a **new** packaging effort.

**Requires GPU:** `TTS_MODE` in {`chatterbox_http`, high-throughput local Whisper/XTTS/Kokoro/Qwen as you choose on GPU images}, and **`llm`** profile (vLLM).

**Not portable yet without work:** **Chatterbox on CPU compose**, **split hybrid networking** beyond the skeleton overlay.

---

## 14. Sprint 2A — operator commands (implemented)

| Step | Command |
|------|---------|
| Preflight (profile) | `./scripts/preflight-profile.sh --profile local-gpu` (or `cloud-api` / `hybrid`) |
| Deploy | `./scripts/deploy-profile.sh --profile local-gpu` |
| Optional env file | `./scripts/deploy-profile.sh --profile cloud-api --env-file /etc/veralux/voice-runtime.env` |
| Validate | `./scripts/validate-profile.sh --profile cloud-api` |
| Compose config (cloud) | `docker compose -f docker-compose.yml -f docker-compose.cloud-api.yml -p veralux config` |
| Compose config (local GPU) | `docker compose -f docker-compose.yml -f docker-compose.local-gpu.yml -p veralux --profile gpu config` |
| Production merge (host) | `VERALUX_COMPOSE_ENV_FILE=/path/to.env docker compose -f docker-compose.yml -f docker-compose.production.yml -p veralux --profile gpu config --services` |

**`DEPLOYMENT_PROFILE`** and **`HEALTH_VOICE_DEPENDENCIES`** (`strict` \| `configured` \| `disabled`) are documented in root `.env.example` and profile env templates (`.env.*.example`).

---

## 15. Related documents

- [LOCAL_GPU_DEPLOYMENT.md](./LOCAL_GPU_DEPLOYMENT.md)
- [CLOUD_API_DEPLOYMENT.md](./CLOUD_API_DEPLOYMENT.md)
- [HYBRID_DEPLOYMENT.md](./HYBRID_DEPLOYMENT.md)
- Existing: `PRODUCTION_TOPOLOGY.md`, `HEALTH_MODEL.md`, `PRECHECKS.md`, `PERSISTENCE_CONTRACT.md`
