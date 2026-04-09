# Supported operations

This document lists **only** operations that are part of the official deployment contract. All commands assume the **repository root** as the current working directory unless noted.

Canonical contract: **`DEPLOYMENT_CONTRACT.md`**.

---

## Lifecycle

| Operation | Command | Notes |
|-----------|---------|--------|
| **Start stack** | `./up` | Same as `./deploy.sh up` and `./scripts/start.sh`. Runs **`scripts/preflight.sh`** first (fail-fast); includes voice/GPU checks via `validate-voice-deploy.sh`. Applies audio profile from `TTS_MODE` + GPU detection; may start `cloudflared` if `CLOUDFLARE_TUNNEL_TOKEN` is set. |
| **Preflight only** | `./scripts/preflight.sh` | Full go-live gate without starting containers. See **`PRECHECKS.md`**. |
| **Stop stack** | `./deploy.sh down` | `docker compose -p veralux down` with any extra args you pass through. |
| **Restart** | `./deploy.sh restart [service...]` | Restarts one or more Compose services by name. |
| **Upgrade** | `./deploy.sh update` | Pull + ordered restart; runs `scripts/backup.sh` if executable (failure warns and continues). |

---

## Observability

| Operation | Command | Notes |
|-----------|---------|--------|
| **Process list** | `./deploy.sh status` | `docker compose -p veralux ps`. |
| **Logs (follow)** | `./deploy.sh logs [service]` | All services if no argument; else filter by Compose service name (`control`, `runtime`, `postgres`, `redis`, `whisper-gpu`, etc.). |
| **Host health smoke test** | `./scripts/healthcheck.sh` | Uses `curl`; reads `CONTROL_PORT`, `RUNTIME_PORT`, `WHISPER_PORT` from `.env` if present. Exit `0` = core HTTP checks passed and no `veralux-*` container is Docker-`unhealthy`. |

---

## Tunnels (optional)

| Operation | Command | Preconditions |
|-----------|---------|----------------|
| **Cloudflare Tunnel** | `./deploy.sh tunnel cloudflare` | `CLOUDFLARE_TUNNEL_TOKEN` in `.env` (non-empty). Image tag: set `CLOUDFLARED_TAG` in `.env` or rely on compose default. |
| **ngrok** | `./deploy.sh tunnel ngrok` | `NGROK_AUTHTOKEN` in `.env`. Set `NGROK_TAG` in `.env` or rely on compose default. |

---

## Backup and restore

| Operation | Command | Notes |
|-----------|---------|--------|
| **Backup database** | `./deploy.sh backup` | Delegates to `./scripts/backup.sh`. |
| **Backup to custom dir** | `./scripts/backup.sh /path/to/dir` | Creates `veralux_<timestamp>.sql.gz`. |
| **Backup + S3** | `./scripts/backup.sh --s3 s3://bucket/prefix` | Requires AWS CLI. |
| **Restore database** | See `scripts/backup.sh` footer | `gunzip -c … \| docker exec -i veralux-postgres psql -U … -d …` |

---

## Build (from source on host)

| Operation | Command | Notes |
|-----------|---------|--------|
| **Build images** | `./deploy.sh build [service...]` | Uses `docker compose -p veralux build` with audio profile from `TTS_MODE` + GPU detection. Sets `ADMIN_UI_BUILD_STAMP` from `git rev-parse --short HEAD` when git is available (unless `ADMIN_UI_BUILD_STAMP_NO_GIT=1`). |

---

## Environment bootstrap

| Operation | Command | Notes |
|-----------|---------|--------|
| **Create `.env` from template** | `cp .env.example .env` then edit | Supported. |
| **Optional advanced overrides** | `cp .env.internal.example .env.internal` then edit | Merged by `deploy.sh` / Compose after `.env`. |
| **First run without `.env`** | `./deploy.sh up` | `deploy.sh` copies `.env.example` → `.env` and **exits 0**; edit `.env` then run `./deploy.sh up` again. |
| **Interactive installer** | `./install.sh` | **Bootstrap only**; not the supported ongoing orchestrator. May download `gum`, load `images.tar.zst`, write `.env`. |

---

## Offline image load

| Operation | Command | Notes |
|-----------|---------|--------|
| **Load bundled images** | `./load-images.sh` | Requires `zstd`; expects `images.tar.zst` in repo root. Used before `./deploy.sh up` when images are not pulled from a registry. |

---

## Helper scripts (supported when used as documented)

| Script | Purpose |
|--------|---------|
| `scripts/start.sh` | Alias for `./deploy.sh up`. |
| `./up` (repo root) | Short alias for `./deploy.sh up`. |
| `scripts/validate-voice-deploy.sh` | Validates `.env` for voice (e.g. `chatterbox_http` + GPU); invoked automatically by `deploy.sh` for `up`, `update`, `tunnel`. |
| `scripts/healthcheck.sh` | Post-deploy HTTP + Docker health inspection. |
| `scripts/backup.sh` | PostgreSQL backup from `veralux-postgres`. |
| `scripts/logs.sh` | Optional log helper (see script header for `COMPOSE_FILE` / service names). |

---

## Compose project identity

All `./deploy.sh` Compose invocations use:

- **File:** `docker-compose.yml`
- **Project:** `-p veralux`

Do not change the project name for in-contract automation without updating this document and `deploy.sh`.
