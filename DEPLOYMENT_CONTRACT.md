# Official deployment contract

**Product:** Veralux Receptionist (this repository, root bundle).  
**Authority:** This file + `docker-compose.yml` + `deploy.sh` + `.env.example`.  
**Version:** Tied to the git commit or release tarball that contains these files.  
**Related:** [`SUPPORTED_OPERATIONS.md`](SUPPORTED_OPERATIONS.md) (command reference), [`UNSUPPORTED_PATTERNS.md`](UNSUPPORTED_PATTERNS.md) (explicit exclusions).

If operational reality diverges from this contract, the contract is wrong for that environment until the repo is updated.

---

## 1. Supported deployment models

### 1A. On-prem Compose (primary)

**One Docker Compose project on one Linux (or macOS Docker Desktop) host, using the repository root as the working directory.**

| Field | Value |
|-------|--------|
| Compose file | **`docker-compose.yml`** at the repository root (only this file is in-contract). |
| Project name | **`veralux`** (set by `./deploy.sh` via `docker compose -p veralux`). |
| Configuration | **One `.env` file** at the repository root (`ENV_FILE=.env` in `deploy.sh`). |
| Orchestration | **`./deploy.sh`** is the only supported way to start, stop, upgrade, and inspect the in-contract stack. |

**Host density:** At most **one** in-contract stack per Docker engine. This repository uses fixed Docker **`container_name`** values (`veralux-control`, `veralux-runtime`, `veralux-postgres`, `veralux-redis`, etc.); a second stack on the same engine will conflict.

**Optional merge file:** Docker Compose may auto-load **`docker-compose.override.yml`** if present beside `docker-compose.yml`. That file is **not** shipped as part of the product contract; if operators add it on a host, they own the diff.

### 1B. Cloud-hosted (second official track)

Per-customer **control + runtime + managed Postgres + Redis** on Render, Railway, or AWS, using frontier STT/LLM/TTS APIs. Orchestrated from the hub admin **Pipeline** page (`/admin/pipeline`). See **`docs/CLOUD_HOSTED_PIPELINE.md`** and **`docs/CLOUD_API_DEPLOYMENT.md`**. This track does **not** replace Compose-on-one-host. Kubernetes/Swarm remain unsupported.

---

## 2. Required services (in-contract runtime)

These **Compose service names** from root `docker-compose.yml` are **always** part of a running deployment:

| Service | Container name | Role |
|---------|----------------|------|
| `postgres` | `veralux-postgres` | PostgreSQL 16 application data |
| `redis` | `veralux-redis` | Redis 7 (state, pub/sub, capacity) |
| `control` | `veralux-control` | Control plane API + admin UI (port 4000 in container) |
| `runtime` | `veralux-runtime` | Voice runtime / Telnyx (port 4001 in container) |

### Audio profile (required for voice)

`./deploy.sh` enables **exactly one** of `--profile gpu` or `--profile cpu` when `TTS_MODE` in `.env` is one of:

- `coqui_xtts`
- `kokoro_http`
- `qwen3_tts_http`
- `chatterbox_http`

**Selection rule (implemented in `deploy.sh` `detect_audio_profile`):**

- If NVIDIA is visible to Docker or `nvidia-smi` exists → **`--profile gpu`**
- Else → **`--profile cpu`**

**Services brought up by profile (Compose service names):**

| Profile | STT | TTS-related (see note) |
|---------|-----|-------------------------|
| `gpu` | `whisper-gpu` | `kokoro-gpu`, `xtts-gpu`, `chatterbox-gpu`, `qwen3-tts-gpu`, `miso-tts-gpu` (all defined; only those matching `TTS_MODE` and URLs must be healthy for calls) |
| `cpu` | `whisper-cpu` | `kokoro-cpu`, `xtts-cpu`, `qwen3-tts-cpu`, `miso-tts-cpu` |

**Note:** `chatterbox-gpu` exists in `docker-compose.yml`; there is **no** `chatterbox-cpu` service. Therefore **`TTS_MODE=chatterbox_http` is only valid when the deployment uses the `gpu` profile** (NVIDIA present per `deploy.sh` detection). A CPU-only host with `chatterbox_http` is **out of contract** (see `UNSUPPORTED_PATTERNS.md`).

If `TTS_MODE` is **not** one of the four values above, `./deploy.sh` passes **no** audio profile; Whisper/XTTS/Kokoro/Qwen containers **do not** start. That state is **not** a supported voice deployment.

### Optional services (explicitly in `docker-compose.yml`, not default)

| Usage | Compose mechanism |
|-------|-------------------|
| Cloudflare Tunnel (Docker, legacy) | `.env` contains non-empty `CLOUDFLARE_TUNNEL_TOKEN`; `./deploy.sh up` may run **`--profile docker-cloudflared-legacy`**. **Managed production** prefers **systemd** `cloudflared` (`/etc/cloudflared/config.yml`) — avoid duplicating tunnels. |
| ngrok | `./deploy.sh tunnel ngrok` (profile `ngrok`, service `ngrok`). |
| Local LLM (vLLM + brain) | `docker compose --profile llm` **in addition** to normal flow—**not** wired into `./deploy.sh up` by default; operators must start `vllm-qwen` and `brain` per `.env.example` and set `BRAIN_URL` on the runtime. |

---

## 3. Required external dependencies

### Host / engine

- **Docker Engine** with **Docker Compose V2** (`docker compose`). Legacy `docker-compose` is tolerated by `deploy.sh` but not the preferred contract path.
- **Internet** (unless using pre-loaded images and offline bundle workflow) for image pull and some model downloads inside audio/LLM images.

### Customer / operator-supplied integrations

| Dependency | Purpose | Where configured |
|-------------|---------|------------------|
| **Telnyx** | PSTN, webhooks, media | `TELNYX_*` in `.env`; portal configuration must point to your public runtime URL. |
| **Public URLs** | Webhooks and audio URLs | `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `BASE_URL`, `ADMIN_ALLOWED_ORIGINS` in `.env` (and tunnel if used). |
| **LLM** | Default cloud path | `OPENAI_API_KEY`, `LLM_PROVIDER`, `OPENAI_MODEL` when using OpenAI (control + runtime). |
| **Container images** | Runnable bits | `REGISTRY`, `VERSION` in `.env` (defaults in compose point at `ghcr.io/nick-veraluxai` and `0.1.0`). |

### Optional external dependencies

| Dependency | When required |
|------------|----------------|
| **NVIDIA GPU + NVIDIA Container Toolkit** | For `--profile gpu`. |
| **Hugging Face token** | For `chatterbox-gpu` / `qwen3-tts-*` image behavior when models require auth (`HF_TOKEN` in compose env). |
| **Stripe** | Only if billing features are used (`STRIPE_*`). Webhook: `POST {CONTROL_PLANE_PUBLIC_URL}/api/stripe/webhook`. See `docs/STRIPE_BILLING.md`. |
| **SMTP** | Only if workflow email actions are used (`SMTP_*`). |
| **AWS CLI** | Only if `./scripts/backup.sh --s3` is used. |

---

## 4. Supported startup command

From the **repository root**:

```bash
./up
```

**Equivalence:** `./deploy.sh up` and `./scripts/start.sh` (both invoke the same startup path). Each run **`scripts/preflight.sh`** first; failure aborts before containers start (see **`PRECHECKS.md`**).

** Preconditions:**

- `.env` exists (if missing, `deploy.sh` copies `.env.example` to `.env` and **exits 0** after printing required edits—no stack started).
- Docker daemon reachable.

**Post-start (legacy Docker tunnel):** If `CLOUDFLARE_TUNNEL_TOKEN` is non-empty in `.env`, `deploy.sh up` attempts `cloudflared` under **`--profile docker-cloudflared-legacy`**. Omit the token when using systemd-only ingress (see PRODUCTION_TOPOLOGY.md).

**Not supported as the primary startup path:** `docker compose up` without `./deploy.sh`, because audio profiles will not match this contract unless the operator manually passes the same `--profile` flags `deploy.sh` would pass.

---

## 5. Supported upgrade command

From the repository root:

```bash
./deploy.sh update
```

**Runbooks:** **`UPGRADE_RUNBOOK.md`** (pre/post checks), **`ROLLBACK_RUNBOOK.md`** (revert), **`RELEASE_CHANNELS.md`** (tagging policy).

This command:

1. Runs **`scripts/preflight.sh`** (or **`validate-voice-deploy.sh`**).
2. Writes **`backups/veralux-images_pre-update_*.txt`** (disable with **`UPDATE_SNAPSHOT_PRE=0`**).
3. Pulls images for the active **`gpu`** or **`cpu`** profile (**strict** by default — fails if a registry pull fails). Airgap: **`UPDATE_IGNORE_PULL_FAILURES=1`**.
4. If **`vllm-qwen`**, **`brain`**, **`cloudflared`**, or **`ngrok`** containers are running, pulls those images with the matching Compose profile (avoids partial updates on optional services).
5. Runs **`./scripts/backup.sh`** before restarts unless **`UPDATE_SKIP_BACKUP=1`**.
6. Restarts **`redis`** and **`postgres`**, waits for Docker health **`healthy`**.
7. Restarts **`control`** (migrations run in the control-plane entrypoint before **`/ready`** succeeds), waits for **`healthy`**.
8. Restarts **`runtime`**, then each running audio container (**whisper**, **kokoro**, **xtts**, **chatterbox**, **qwen3-tts**) using the correct **gpu/cpu** Compose service name, then **`vllm-qwen`** / **`brain`** if running.
9. Restarts **`cloudflared`** and/or **`ngrok`** if they were running.
10. Writes **`backups/veralux-images_post-update_*.txt`** (disable with **`UPDATE_SNAPSHOT_POST=0`**).

Verify after upgrade: **`./deploy.sh versions`** and **`./scripts/healthcheck.sh`**.

---

## 6. Supported healthcheck command

**Preflight (before or without `up`):**

```bash
./scripts/preflight.sh
```

**Host-level smoke test (after `up`):**

```bash
./scripts/healthcheck.sh
```

Run from the repository root. **Default mode is readiness** (aligned with Compose healthchecks). See **`HEALTH_MODEL.md`**.

- HTTP GETs `http://127.0.0.1:${CONTROL_PORT}/ready` (control: DB + Redis per **`GET /ready`**).
- HTTP GETs `http://127.0.0.1:${RUNTIME_PORT}/health/ready` (runtime: Redis + Whisper + TTS HTTP health when **`HEALTH_VOICE_DEPENDENCIES`** is enabled).
- **`./scripts/healthcheck.sh --liveness`** uses **`GET /health`** (control) and **`GET /health/live`** (runtime) only.
- Optionally probes Whisper on `${WHISPER_PORT}` (default **9000**); failure is **warning-only** (script still passes if core checks pass).
- If **`BRAIN_USE_LOCAL=true`**, probes **`http://127.0.0.1:${BRAIN_PORT:-3001}/health`** (failure fails the script).
- If Docker is available, fails if any `veralux-*` container reports Docker health status **`unhealthy`**.

**Operational status (human or automation):**

```bash
./deploy.sh status
```

Maps to `docker compose -p veralux ps`.

**Container-defined healthchecks** (authoritative for Docker) are declared in `docker-compose.yml` for `postgres`, `redis`, `control`, `runtime`, and audio / LLM / tunnel services as applicable. Semantics: **`HEALTH_MODEL.md`**.

---

## 7. Supported backup and restore strategy

**Persistence model:** **`PERSISTENCE_CONTRACT.md`** (what lives where, critical vs cache). **Operational detail:** **`BACKUP_RESTORE.md`**.

**Supported backup command:**

```bash
./deploy.sh backup
```

**Equivalence:** `./scripts/backup.sh` from the repository root (with optional args documented in `scripts/backup.sh`).

**What is backed up (in-contract automation):** PostgreSQL only — container **`veralux-postgres`**, using credentials from `.env` / `.env.internal` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).

**Output:** Compressed SQL at `./backups/veralux_<timestamp>.sql.gz` unless a directory argument is passed.

**Optional:** `--s3 s3://…` when AWS CLI is installed.

**Retention:** `BACKUP_RETENTION_DAYS` or `--retention` (see `scripts/backup.sh`).

**Supported restore command (destructive to current DB):**

```bash
./deploy.sh restore ./backups/veralux_<timestamp>.sql.gz
```

**Equivalence:** `./scripts/restore.sh` (requires typing `RESTORE` to confirm, or pass `--yes` for automation).

**Not in-contract as automated backup targets:** Redis (`veralux-redis-data`), audio (`veralux-audio-storage`), control uploads (`veralux-control-uploads`), optional `veralux-vllm-hf-cache`. **`BACKUP_RESTORE.md`** documents optional operator procedures (e.g. `tar` / `redis-cli SAVE`).

---

## 8. Supported customer config surface

All of the following are **in-contract** ways to vary behavior **without** forking application source:

1. **Root `.env`** — operator surface. Canonical template: **`.env.example`**.
2. **Root `.env.internal`** (optional) — advanced overrides. Template: **`.env.internal.example`**. When present, **`deploy.sh`** passes **`--env-file .env.internal`** to Docker Compose so variables in this file override **`.env`** for duplicate keys. See **`CONFIG_MATRIX.md`**.
3. **Control plane database** — tenant settings, prompts, automation configuration (mutated via the product UI/API after install).
4. **Redis-published runtime config** — produced by the control plane for the voice runtime (internal mechanism; operators do not edit Redis by hand for normal operation). Schema: **`shared/src/runtimeContract.ts`** (`RuntimeTenantConfig`).
5. **Optional `docker-compose.override.yml`** on the host — for extra volumes, env, or resource limits; operators maintain this file; it is not part of the released golden bundle contract.

**Runtime validation:** The voice runtime loads and validates environment with Zod (`veralux-voice-runtime/src/env.ts`); invalid `.env` combinations fail at process start.

---

## 9. Unsupported deployment patterns

See **`UNSUPPORTED_PATTERNS.md`** for the explicit list. In summary: other Compose files as the production stack, multiple stacks on one engine, raw `docker compose up` as the operational standard, and voice deployments without the correct audio profile/`TTS_MODE` combination.

---

## 10. Operator responsibilities vs application responsibilities

### Operator responsibilities

- Provision a suitable host (CPU/RAM/GPU per offering) with Docker and Compose V2.
- Create and protect **`.env`** (secrets, URLs, `REGISTRY`/`VERSION`, Telnyx keys, optional tunnel tokens).
- Run **only** `./deploy.sh` / `./scripts/healthcheck.sh` / `./deploy.sh backup` (or equivalent `scripts/*.sh` documented here) for lifecycle operations.
- Configure **Telnyx** (and DNS/TLS/tunnel) so public traffic reaches the runtime and audio URLs resolve.
- Run **backups** on a schedule appropriate to the customer.
- Pin **image tags** (`VERSION`) for reproducible deployments.
- If using GPU: install NVIDIA driver and **NVIDIA Container Toolkit** so `deploy.sh` selects `--profile gpu`.

### Application / image responsibilities

- **Migrations:** Control plane container entrypoint runs DB wait + migrations + starts server (`control-plane/scripts/docker-entrypoint.sh`).
- **Inter-service wiring:** Compose `depends_on` with `service_healthy` for `control` → postgres/redis; `runtime` → redis + control.
- **Health endpoints:** Control **`GET /ready`** for readiness and **`GET /health`** for liveness (port 4000). Runtime **`GET /health/ready`** for readiness and **`GET /health/live`** for liveness (port 4001); diagnostic aggregate **`GET /health`** (see **`HEALTH_MODEL.md`** and `veralux-voice-runtime/src/routes/health.ts`).
- **Persistence:** Named volumes `veralux-postgres-data`, `veralux-redis-data`, `veralux-audio-storage`, `veralux-control-uploads`, and `veralux-vllm-hf-cache` when profile `llm` is used — see **`PERSISTENCE_CONTRACT.md`**.

---

## 11. `install.sh` and the contract

**`install.sh`** is a **bootstrap helper** (interactive UI, optional image load). It is **not** the supported runtime orchestrator.

**In-contract lifecycle** after the host has a valid `.env` is **`./deploy.sh` only**. Operators may use `install.sh` once to generate `.env` or load offline images; that does not replace the startup command in Section 4.
