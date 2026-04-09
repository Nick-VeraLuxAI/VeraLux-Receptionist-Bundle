# Quickstart (operators)

**Official start path:** repository root, **`./up`** or **`./deploy.sh up`** (equivalent). Do **not** use plain `docker compose up -d` as your normal start — audio services need the **`gpu`** or **`cpu`** profile that `deploy.sh` adds from **`TTS_MODE`** and hardware detection.

---

## 0. Prerequisites

- Docker Engine 20.10+ and **Compose V2** (`docker compose version`).
- Voice on GPU: NVIDIA driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).
- Offline bundle: `zstd` for `load-images.sh` (see `README.md`).

---

## 1. Configure

```bash
cd /path/to/VeraLux-Receptionist-Bundle   # directory that contains docker-compose.yml
cp .env.example .env
# optional:
# cp .env.internal.example .env.internal
```

Edit **`.env`** at minimum (see comments in **`.env.example`**):

| Variable | Purpose |
|----------|---------|
| `VERSION`, `REGISTRY` | Image tag and registry you can pull |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `SECRET_ENCRYPTION_KEY`, `ADMIN_API_KEY`, `MEDIA_STREAM_TOKEN` | Strong random values |
| `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_PHONE_NUMBER` | Telephony |
| `OPENAI_API_KEY` | If `LLM_PROVIDER=openai` (default) |
| `BASE_URL` | Control plane URL (browser + API) |
| `PUBLIC_BASE_URL` | **HTTPS** base Telnyx uses for **runtime** webhooks |
| `AUDIO_PUBLIC_BASE_URL` | Public base for served audio (typically `…/audio`) |
| `ADMIN_ALLOWED_ORIGINS` | Origins allowed for admin UI (often same host as `BASE_URL`) |

---

## 2. Start

```bash
./up
```

or:

```bash
./deploy.sh up
```

**What runs automatically before containers start:** **`scripts/preflight.sh`** (env sanity, Docker/Compose, optional voice checks). If preflight fails, nothing starts.

**What does *not* run automatically:** Telnyx portal configuration (webhooks, connection, DIDs), public DNS, TLS certificates (unless you use a tunnel token and Cloudflare as documented).

---

## 3. Verify (host)

```bash
./deploy.sh status
./scripts/healthcheck.sh
```

Readiness (default): control **`/ready`**, runtime **`/health/ready`**. See **`HEALTH_MODEL.md`** if a service stays **starting** for many minutes (often model load).

---

## 4. After boot (manual)

1. **Telnyx:** Point webhooks / application / media URLs at your **public** runtime (`PUBLIC_BASE_URL` and paths your setup uses). This is **not** done by `deploy.sh`.
2. **Admin UI:** Open `BASE_URL`, complete install/onboarding as your build documents.
3. **Backup:** `./deploy.sh backup` (Postgres only; see **`BACKUP_RESTORE.md`**).

---

## 5. Common commands

```bash
./deploy.sh status
./deploy.sh logs control
./deploy.sh logs runtime
./deploy.sh restart runtime
./deploy.sh down
./deploy.sh update          # pin VERSION first; see UPGRADE_RUNBOOK.md
./scripts/preflight.sh      # run without starting
./scripts/healthcheck.sh --liveness   # process-only emergency check
```

---

## 6. Where to read next

| Topic | Doc |
|-------|-----|
| Ordered checklist | **`CLIENT_DEPLOY_CHECKLIST.md`** |
| First boot timing / “healthy” | **`FIRST_BOOT_EXPECTATIONS.md`** |
| When something fails | **`TROUBLESHOOTING_DEPLOY.md`** |
| Full contract | **`DEPLOYMENT_CONTRACT.md`** |
| Preflight rules | **`PRECHECKS.md`** |
| Health semantics | **`HEALTH_MODEL.md`** |
