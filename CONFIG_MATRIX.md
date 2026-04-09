# Configuration matrix (repo-specific)

This document classifies **customer-relevant** settings: where they live, whether they are secrets, and whether they belong in **`.env`**, **`.env.internal`**, or **tenant DB** (control plane → Redis → runtime).

Templates: **`.env.example`** (operators), **`.env.internal.example`** (advanced).

**Preflight:** **`./scripts/preflight.sh`** (also run automatically before **`./up`**) — see **`PRECHECKS.md`**.

---

## 1. Legend

| Class | Meaning |
|-------|---------|
| **S** | Required secret — treat like a password; never log; store in **`.env`** or secret manager. |
| **C** | Required non-secret config — URLs, modes, ports (still sensitive in aggregate). |
| **F** | Optional feature flag / integration (off until set). |
| **T** | Dangerous internal tuning — can break calls, latency, or stability; prefer **`.env.internal`**. |
| **DB** | Per-tenant in Postgres / UI; published in **`RuntimeTenantConfig`** (`shared/src/runtimeContract.ts`). |
| **IMG** | Baked into container image or static HTML — changing it today needs a **rebuild** or **file edit** (see §5). |

---

## 2. Operator `.env` (required / common)

| Variable | Class | Notes |
|----------|-------|--------|
| `VERSION`, `REGISTRY` | C | Pin releases. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | S / C | DB bootstrap; password is secret. |
| `JWT_SECRET` | S | Owner/admin JWT (see also `ADMIN_JWT_SECRET` in advanced docs). |
| `ADMIN_API_KEY` | S | Admin UI + `CONTROL_PLANE_API_KEY` on runtime (compose). |
| `SECRET_ENCRYPTION_KEY` | S | Tenant secrets at rest when `SECRET_MANAGER=db`. |
| `SECRET_MANAGER` | C | Usually `db`. |
| `MEDIA_STREAM_TOKEN` | S | Media WebSocket auth. |
| `BASE_URL` | C | Control plane public base URL. |
| `PUBLIC_BASE_URL` | C | Runtime base for Telnyx webhooks. |
| `AUDIO_PUBLIC_BASE_URL` | C | Must expose `/audio` path the runtime serves. |
| `ADMIN_ALLOWED_ORIGINS` | C | CORS for admin UI. |
| `CONTROL_PORT`, `RUNTIME_PORT` | C | Host port mapping. |
| `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` | S | Telephony. |
| `TELNYX_PHONE_NUMBER` | C | Primary DID (tenant DIDs also in DB). |
| `TELNYX_VERIFY_SIGNATURES` | C | Must stay `true` in production. |
| `LLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL` | S/C | Cloud LLM default. |
| `TTS_MODE` | C | `coqui_xtts` \| `kokoro_http` \| `qwen3_tts_http` \| `chatterbox_http`. |
| `HF_TOKEN` | S | HF gated models (Chatterbox/Qwen containers). |
| `STRIPE_*` | S/F | Billing when used. |
| `SMTP_*` | S/F | Workflow email when used. |
| `CLOUDFLARE_TUNNEL_TOKEN`, `NGROK_AUTHTOKEN` | S/F | Tunnels. |
| `CLOUDFLARED_TAG`, `NGROK_TAG` | C | Pin tunnel images. |
| `INSTALLER_USERNAME`, `INSTALLER_PASSWORD` | C/S | `install.sh` admin-auth; password unset → **`ADMIN_API_KEY`** (see `control-plane/src/server.ts`). |
| `LOG_LEVEL` | C | Typical `info`. |

`API_KEY` appears in **`docker-compose.yml`** for `control` but is **unused** in control-plane TypeScript — ignore or remove in a future cleanup.

---

## 3. `.env.internal` (advanced / tuning)

Prefer this file for anything that is **not** customer identity or billing:

| Area | Examples | Class |
|------|-----------|--------|
| **STT pipeline** | `STT_CHUNK_MS`, `STT_SILENCE_MS`, `STT_*_GRACE_*`, `STT_AEC_*`, `STT_UNCLEAR_*`, `STT_TRANSCRIPT_DEDUPE_*`, `STT_PIPELINE_DIAG_*`, `WHISPER_URL`, `WHISPER_HTTP_*` | T |
| **STT debug** | `STT_DEBUG_*`, `STT_PREWHISPER_*` | T |
| **Capacity** | `GLOBAL_CONCURRENCY_CAP`, `TENANT_*_CAP_*`, `CAPACITY_HOLD_*` | T |
| **TTS URLs / variants** | `KOKORO_URL`, `COQUI_XTTS_URL`, `CHATTERBOX_*`, `QWEN3_TTS_*` | C/T |
| **Readiness** | `HEALTH_VOICE_DEPENDENCIES` (default true; see **`HEALTH_MODEL.md`**) | T |
| **GPU mapping** | `WHISPER_GPU_IDS`, `XTTS_GPU_IDS`, `CHATTERBOX_GPU_IDS`, … | T |
| **Whisper model** | `WHISPER_MODEL`, `WHISPER_MODEL_SIZE`, `WHISPER_DEVICE` | T |
| **vLLM + brain** | `VLLM_*`, `BRAIN_URL`, `BRAIN_USE_LOCAL` | F/T |
| **Control plane ops** | `ENABLE_RUNTIME_ADMIN`, `ALLOW_RUNTIME_SECRET_READ`, `ADMIN_AUTH_MODE`, `DATABASE_POOL_*`, `TTS_PREVIEW_FETCH_TIMEOUT_MS` | T |
| **Telnyx fine-tuning** | `TELNYX_ACCEPT_CODECS`, `PLAYBACK_PSTN_SAMPLE_RATE`, `TELNYX_CONNECTION_ID` | T |
| **Build** | `ADMIN_UI_BUILD_STAMP` | T |

Compose already supplies sane defaults for many runtime variables; **`.env.internal`** overrides them without bloating operator **`.env`**.

---

## 4. DB-driven tenant settings (per customer, no redeploy)

Stored in the control plane and published to Redis (`tenantcfg:*`). Schema: **`shared/src/runtimeContract.ts`**.

Includes (non-exhaustive):

- **DIDs** (`dids`), per-tenant **capacity** caps (`caps`).
- **STT**: `stt.mode`, `stt.whisperUrl`, `stt.chunkMs`, `stt.language`, etc.
- **TTS**: mode-specific blocks (`kokoro_http`, `coqui_xtts`, `chatterbox_http`, `qwen3_tts_http`) — URLs, voice, cloning refs.
- **LLM context**: `llmContext.prompts`, forwarding profiles, pricing text.
- **Assistant**: `assistantContext`, `quickReplies`.
- **Call forwarding**: `callForwarding`, `transferProfiles`.
- **Webhook**: `webhookSecret` / `webhookSecretRef`.

Use the **admin / owner UI** to change these — not env — for per-tenant behavior.

---

## 5. Today: still requires code or image changes

| Item | Location | Practical workaround |
|------|----------|------------------------|
| **Admin / portal / owner branding** (titles, logo, tagline, portal footer) | **`BRAND_*`** env → **`GET /api/branding`** (see **`CUSTOMER_CONFIG_SURFACE.md`**). Deep CSS/layout still via **`public/*.html`** / **`admin-neural.css`** or volume mount. |
| **SMTP_FROM default domain** | `.env.example` default `noreply@veralux.ai` | Set `SMTP_FROM` in **`.env`**. |
| **Docker Compose service structure** | `docker-compose.yml` | Use **`docker-compose.override.yml`** on the host for resources/volumes; do not fork for small URL changes (use env). |

**Fixed in this pass:** `INSTALLER_PASSWORD` no longer falls back to a hardcoded string; it aligns with **`ADMIN_API_KEY`** when unset (see `control-plane/src/server.ts`).

---

## 6. File storage / assets

| Path | Config |
|------|--------|
| Postgres / Redis data | Named Docker volumes (`veralux-postgres-data`, `veralux-redis-data`). |
| Runtime audio WAVs | Volume `veralux-audio-storage` → `/app/audio`; `AUDIO_STORAGE_DIR` default `/app/audio`. |
| Control plane voice recordings upload | Named volume **`veralux-control-uploads`** → `/app/control-plane/public/voice-recordings` in Compose; override with `VOICE_RECORDINGS_DIR` only if you know ownership/backup implications (see **`PERSISTENCE_CONTRACT.md`**). |
| STT debug WAVs | `STT_DEBUG_DIR` + flags — **`.env.internal`**, disable in prod. |

---

## 7. Optional features (env-gated)

| Feature | Env |
|---------|-----|
| Stripe | `STRIPE_*` |
| SMTP automations | `SMTP_HOST`, … |
| Cloudflare / ngrok | Tunnel vars |
| Local LLM stack | `docker-compose` profile `llm` + `VLLM_*`, `BRAIN_URL` |
| Runtime admin secret read | `ALLOW_RUNTIME_SECRET_READ` (control plane) |

---

## 8. Dangerous knobs (support should own)

- Any **`STT_DEBUG_DUMP_*=true`** in production (disk, latency, privacy).
- **`STT_PREWHISPER_GATE=true`** without tuning (can garble PSTN audio).
- **`GLOBAL_CONCURRENCY_CAP`** / **`TENANT_*`** far above GPU STT/TTS capacity.
- **`CHATTERBOX_GUNICORN_WORKERS`** > 1 on a single GPU without VRAM headroom.
- **`TELNYX_VERIFY_SIGNATURES=false`**.
