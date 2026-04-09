# Deployment audit — Veralux Receptionist Bundle

This document is based on the repository as of the audit date. It maps what actually exists in code and compose files, not generic best practices.

---

## 1. Components required to run the system

### Frontend

- **Admin / owner UI** ships inside the **control plane** Node service (`control-plane/`, image `veralux-control-plane`). Static assets are baked in the Docker image (see `control-plane/Dockerfile` and `ADMIN_UI_BUILD_STAMP` in `docker-compose.yml`).

### Backend

- **Control plane** (`control-plane`): HTTP API on port 4000, Postgres + Redis, migrations on container start (`control-plane/scripts/docker-entrypoint.sh`).
- **Voice runtime** (`veralux-voice-runtime`): HTTP on 4001, Telnyx webhooks, media, STT/TTS orchestration, Redis for capacity and control-plane sync.

### Model / runtime services (containers)

- **Whisper** (STT): `whisper-gpu` or `whisper-cpu` profile — HTTP `:9000`, path `/transcribe` (see compose + `veralux-audio-stack`).
- **XTTS / Coqui** (default TTS when `TTS_MODE=coqui_xtts`): `xtts-gpu` / `xtts-cpu` — `:7002`, `/tts` + `/health`.
- **Kokoro** (optional TTS mode): `kokoro-gpu` / `kokoro-cpu` — `:7001`.
- **Chatterbox** (optional TTS mode): `chatterbox-gpu` — `:7005` (HF token often required).
- **Qwen3 TTS** (optional TTS mode): `qwen3-tts-gpu` / `qwen3-tts-cpu` — `:7010`.
- **Optional LLM stack** (`--profile llm`): `vllm-qwen` + `brain` gateway (`veralux-voice-runtime/brain-gpt4o`).

### Databases

- **PostgreSQL 16** (`postgres` service): named volume `veralux-postgres-data`.
- **Redis 7** (`redis` service): AOF, volume `veralux-redis-data`.

### Queues

- No separate queue product (RabbitMQ, SQS, etc.). **Redis** is used for pub/sub, caching, and capacity tracking.

### File storage

- **Docker volume `veralux-audio-storage`** mounted at `/app/audio` on the runtime for TTS/STT artifacts and debug WAVs.
- Optional **vLLM HF cache** volume `veralux-vllm-hf-cache`.

### Environment variables

- **Root** `.env.example` is the canonical template for the bundle (hundreds of knobs for STT/TTS tuning, Telnyx, Stripe, SMTP, tunnels, GPU IDs).
- **Runtime** validates config with **Zod** (`veralux-voice-runtime/src/env.ts`) — fails fast on invalid env.
- **Control plane** validates critical pieces via entrypoint + runtime checks (e.g. `ADMIN_API_KEY`, DB wait, migrations); not as strict as the voice runtime schema for every variable.

### External APIs

- **Telnyx** (voice PSTN, webhooks, SMS in automations): `TELNYX_*`.
- **OpenAI** (default LLM): `OPENAI_API_KEY` on control + runtime when using cloud LLM.
- **Stripe** (optional billing): `STRIPE_*`.
- **SMTP** (optional workflow email): `SMTP_*`.
- **Hugging Face** (Chatterbox / Qwen3 image pulls): `HF_TOKEN`.
- **Installer “online” mode** calls `https://api.veralux.ai/api/v1/installer/config` (`install.sh`).

### Local binaries / host tools

- **Docker + Compose V2** (required).
- **Offline bundle**: `zstd` for `load-images.sh`.
- **Installer**: downloads **gum** to `.bin/gum` or uses system `gum`; needs `curl` or `wget`, `openssl` or `/dev/urandom` for secrets.
- **GPU**: NVIDIA driver + **NVIDIA Container Toolkit** for GPU profiles.

### Background workers

- No separate worker container. Work is **in-process** in control plane and runtime; Redis coordinates state.

### Build steps

- **Images**: pre-built from `${REGISTRY}` / `${VERSION}` or `docker compose build` (monorepo `npm` workspaces in Dockerfiles).
- **CI** (`.github/workflows/ci.yml`): `npm ci`, workspace builds/tests, `docker compose build` for selected services, `docker compose config` validation.

---

## 2. Deployment readiness score (one-click deploy)

**Score: 6 / 10**

**Why not higher**

- A **working voice stack** depends on **Compose profiles** (`gpu` or `cpu`) for Whisper + chosen TTS. That is automated in `./deploy.sh up` but **not** in a naive `docker compose up`, which is easy to misread from comments in `docker-compose.yml`.
- **Telnyx + public HTTPS URLs** still require **external configuration** (webhooks, numbers, tunnel DNS). The product cannot infer that from env alone.
- **First boot** of GPU images (model download / load) is slow and resource-heavy; health checks use long `start_period` values — operators may think the deploy “hung.”
- **Installer** paths (online API, admin auth URL, grep-based JSON parsing) are **brittle** and partially **vendor-specific**.
- **Per-client branding** beyond env is largely **data/tenant config** in the app (good), but **operational** multi-tenant SaaS boundaries (one cluster vs many) are not spelled out as a product contract.

**Why not lower**

- There is a **real** `docker-compose.yml` with **healthchecks**, **depends_on** conditions, **named volumes**, and **documented** `.env.example`.
- `./deploy.sh` implements **profile detection** from `TTS_MODE` and GPU presence, **pull**, and **ordered update** logic.
- `./install.sh` provides a **guided** flow for offline bundles and credential capture.
- Voice runtime **fails fast** on bad configuration (Zod).

---

## 3. Recommended deployment model for this repo today

**Primary: Docker Compose** (with `./deploy.sh` as the supported entrypoint).

- Optional **Cloudflare Tunnel** or **ngrok** profiles for exposing runtime/control without manual reverse proxy setup.
- **Not** a good fit as-is for: Electron/desktop installer, or pure “cloud SaaS” without you hosting the control plane and bundling secrets distribution.

**Hybrid note:** The installer’s “online setup” assumes a **Veralux-hosted control API** — that is already a **local + cloud control plane** pattern for provisioning, even though the runtime runs on the customer’s Docker host.

---

## 4. Fastest path to a client-deployable system

1. **Pin** `VERSION` and `REGISTRY` to tags you actually publish (avoid `latest` unless you guarantee that tag).
2. **Copy** `.env.example` → `.env`, set Telnyx, OpenAI (if used), secrets, `PUBLIC_BASE_URL` / `AUDIO_PUBLIC_BASE_URL` to the **real** HTTPS base URLs your tunnel serves.
3. Run **`./deploy.sh up`** (or `./scripts/start.sh`). Wait for GPU/CPU audio containers to become healthy (can take many minutes on first pull).
4. Configure **Telnyx** webhooks to hit your public runtime URL (documented in your runbook / Telnyx portal).
5. Run **`./scripts/healthcheck.sh`** from the host to verify control + runtime HTTP endpoints.

---

## 5. Deliverables added in this audit

| Artifact | Purpose |
|----------|---------|
| `ONE_CLICK_GAP_REPORT.md` | Blockers, severity, remediation plan |
| `scripts/start.sh` | Thin wrapper → `./deploy.sh up` |
| `scripts/healthcheck.sh` | Host-side HTTP + Docker health spot-checks |
| `docker-compose.yml` | Default image tags for optional `cloudflared` / `ngrok` (avoids empty-tag compose failures) |
| `deploy.sh` | Fix: rolling **update** now passes `--profile cloudflare` when restarting `cloudflared` |
| `install.sh` | Align generated `.env` with compose defaults (`BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `KOKORO_URL`, `WHISPER_URL`, `VERSION`, `CLOUDFLARED_TAG` when token set) |

See **`docs/CLIENT_DEPLOY_QUICKSTART.md`** for copy-paste install/run steps.

---

## 6. Honest limitations

- **One-click** here means **one command after `.env` and Telnyx/tunnel are correct**, not “zero external cloud accounts.”
- **Chatterbox / Qwen3** may require **HF licenses + tokens**; failures show up at **container runtime**, not at `docker compose up` parse time.
- **`API_KEY`** is passed into the control container from `docker-compose.yml` but **is not referenced** in `control-plane` TypeScript — confusing for operators auditing env usage.
