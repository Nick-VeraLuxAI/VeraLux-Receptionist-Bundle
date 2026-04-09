# Veralux Receptionist - Deployment Bundle

This package contains everything needed to deploy Veralux Receptionist using Docker.

**Operator quick path:** **`QUICKSTART.md`** · checklist **`CLIENT_DEPLOY_CHECKLIST.md`** · first boot **`FIRST_BOOT_EXPECTATIONS.md`** · fixes **`TROUBLESHOOTING_DEPLOY.md`**.

## Start the stack (production-like)

**Use exactly one of these from the repository root** (they are equivalent):

```bash
./up
```

```bash
./deploy.sh up
```

```bash
./scripts/start.sh
```

**Do not** use plain `docker compose up -d` as your primary startup. Whisper, XTTS, Kokoro, and Qwen TTS services are behind Compose **profiles** (`gpu` or `cpu`). The commands above run `deploy.sh`, which selects profiles from `TTS_MODE` in `.env` and whether NVIDIA is available. Starting only `control` + `runtime` without those profiles leaves voice/STT/TTS broken.

After starting:

```bash
./scripts/healthcheck.sh   # readiness vs stack deps (see HEALTH_MODEL.md); add --liveness for process-only
./deploy.sh status
```

See **`DEPLOYMENT_CONTRACT.md`** for the full operational contract.

---

## Requirements

- **Docker Engine** 20.10+ with Docker Compose V2
- **Operating System**: Linux (Ubuntu 20.04+) or macOS
- **Ports**: 4000, 4001 (configurable)
- **Disk Space**:
  - Online install: ~2 GB (images pulled from registry)
  - Offline install: ~5 GB+ (includes pre-packaged images)

### Before You Start

Have these ready:
- **Telnyx API Key** and **Public Key** (from portal.telnyx.com)
- **Your domain name** (e.g., receptionist.yourcompany.com)

### GPU Services

For GPU-accelerated services (Whisper, Kokoro, XTTS):
- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

---

## Quick Start (interactive installer)

Optional bootstrap that can create `.env` and then starts the stack the same way as `./deploy.sh up`:

```bash
unzip veralux-receptionist-*.zip
cd veralux-receptionist-*/
./install.sh
```

The installer checks Docker, may load offline images, collects credentials, and ends by running **`./deploy.sh up`** (or the tunnel flow). Ongoing operations should still use **`./up`** or **`./deploy.sh`** above.

---

## Quick Start (manual)

```bash
unzip veralux-receptionist-*.zip
cd veralux-receptionist-*/

# Offline bundles only — load images first
./load-images.sh

cp .env.example .env
nano .env   # Edit with your settings

./up
./deploy.sh status
```

> **Note**: The offline bundle includes `images.tar.zst` which requires `zstd` to decompress.
> Install with: `sudo apt install zstd` (Ubuntu) or `brew install zstd` (macOS)

---

## Configuration

### Environment files

| File | Audience |
|------|----------|
| **`.env`** | Operators — copy **`.env.example`**. |
| **`.env.internal`** (optional) | Advanced tuning — copy **`.env.internal.example`**. Merged by **`deploy.sh`** after `.env` (duplicate keys: internal wins). |

Reference: **`CONFIG_MATRIX.md`**, **`ENV_VALIDATION_PLAN.md`**.

### Key variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VERSION` / `REGISTRY` | Image identity | Yes |
| `POSTGRES_*`, `JWT_SECRET`, `ADMIN_API_KEY`, `SECRET_ENCRYPTION_KEY`, `MEDIA_STREAM_TOKEN` | Core secrets | Yes |
| `BASE_URL`, `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `ADMIN_ALLOWED_ORIGINS` | URLs / CORS | Yes |
| `TELNYX_*`, `OPENAI_*`, `LLM_PROVIDER` | Voice + LLM | Yes for default stack |
| `TTS_MODE` | `coqui_xtts`, `kokoro_http`, `qwen3_tts_http`, `chatterbox_http` | Yes for voice |

Defaults for many runtime knobs are in **`docker-compose.yml`**; override via **`.env.internal`** when needed.

### Port Configuration

Default ports (change in `.env` if needed):

| Service | Port | Variable |
|---------|------|----------|
| Control Plane (API + UI) | 4000 | `CONTROL_PORT` |
| Runtime | 4001 | `RUNTIME_PORT` |
| PostgreSQL | 5432 | `POSTGRES_PORT` |

---

## Usage

### Deploy Script Commands

```bash
./up                    # Same as ./deploy.sh up (recommended shorthand)
./deploy.sh up          # Start stack (validates .env, applies audio profiles)

# Force GPU profile if auto-detect is wrong (rare):
./deploy.sh up --profile gpu

./deploy.sh down        # Stop stack
./deploy.sh restart     # Restart (optional: service name)
./deploy.sh status      # docker compose -p veralux ps
./deploy.sh logs        # Follow logs (optional: service name)
./deploy.sh update      # Pull + rolling restart (runs backup when possible)
./deploy.sh backup      # Postgres dump to ./backups/
./deploy.sh restore ./backups/veralux_<timestamp>.sql.gz  # destructive — see BACKUP_RESTORE.md
```

### Data and persistence

Named volumes and classifications: **`PERSISTENCE_CONTRACT.md`**. Backup/restore procedures (Postgres + optional Redis/audio): **`BACKUP_RESTORE.md`**.

### Upgrades and releases

Pin **`VERSION`** / **`REGISTRY`**, run **`./deploy.sh update`**, verify with **`./deploy.sh versions`**. Policy and checklists: **`RELEASE_CHANNELS.md`**, **`UPGRADE_RUNBOOK.md`**, **`ROLLBACK_RUNBOOK.md`**.

### White-label / customer-facing copy

**`BRAND_*`** and related env vars (no HTML edits for basic branding): **`CUSTOMER_CONFIG_SURFACE.md`**.

### Preflight (before go-live)

**`./deploy.sh up`**, **`./up`**, **`./deploy.sh update`**, and **`./deploy.sh tunnel`** run **`./scripts/preflight.sh`** first. If preflight fails, the stack does not start.

Run checks alone:

```bash
./scripts/preflight.sh
```

See **`PRECHECKS.md`** for the full checklist and sample output. **`PREFLIGHT_STRICT=1`** turns warnings into failures.

---

## Troubleshooting

### Check Service Status

```bash
./deploy.sh status
```

For low-level inspection (same project as `deploy.sh`):

```bash
docker compose -p veralux ps
docker ps
```

### View Logs

```bash
./deploy.sh logs
./deploy.sh logs control
docker compose -p veralux logs --tail=100 control
```

### Common Issues

#### Services won't start

1. Check Docker: `docker info`
2. Check ports: `sudo ss -tlnp | grep -E '4000|4001|5432'` (Linux)
3. Logs: `./deploy.sh logs`
4. Re-run validation: `./scripts/validate-voice-deploy.sh`

#### Database connection errors

1. `./deploy.sh logs postgres`
2. Ensure `.env` credentials match the Postgres volume (first init wins)

#### Images not found (online install)

```bash
docker pull ${REGISTRY}/veralux-control-plane:${VERSION}
docker pull ${REGISTRY}/veralux-voice-runtime:${VERSION}
docker login ghcr.io   # if private
```

#### Offline install: zstd not found

`sudo apt install zstd` (Ubuntu) or `brew install zstd` (macOS)

### Reset Everything

```bash
docker compose -p veralux down -v
docker volume rm veralux-postgres-data veralux-redis-data veralux-audio-storage veralux-control-uploads veralux-vllm-hf-cache 2>/dev/null || true
./up
```

> **Warning**: This deletes application data including the database.

---

## Architecture

```
┌───────────────────┐     ┌─────────────┐
│   Control Plane   │────▶│   Runtime   │
│  (API + UI) :4000 │     │    :4001    │
└───────────────────┘     └─────────────┘
         │                       │
         ▼                       ▼
  ┌─────────────┐         ┌─────────────┐
  │  PostgreSQL │         │    Redis    │
  │    :5432    │         │    :6379    │
  └─────────────┘         └─────────────┘

Audio (profiles gpu/cpu via ./deploy.sh up):
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Whisper   │  │   Kokoro    │  │    XTTS     │
│    :9000    │  │    :7001    │  │    :7002    │
└─────────────┘  └─────────────┘  └─────────────┘
```

---

## Support

- **`DEPLOYMENT_CONTRACT.md`** — supported model and commands
- **`SUPPORTED_OPERATIONS.md`** — operation reference
- **`UNSUPPORTED_PATTERNS.md`** — what not to do
- Logs: `./deploy.sh logs`

---

## License

See LICENSE file for details.
