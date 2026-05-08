# VeraLux Receptionist — production topology

Authoritative operational layout on Ubuntu workstations / VeraTitan-style hosts:

| Artifact | Path / source |
|-----------|----------------|
| Install root | `/opt/veralux/veralux-voice-runtime` (sync from `VeraLux-Receptionist-Bundle`; do not fork ad hoc trees) |
| Voice / compose secrets + tunables | **`/etc/veralux/voice-runtime.env`** (mode `0640`, root + operator group only) |
| Dashboard (Next.js) env | **`/etc/veralux/dashboard.env`** (`veralux-dashboard.service`) |
| Public ingress | **systemd** `cloudflared` reading **`/etc/cloudflared/config.yml`** |

Repo **`.env` is development-only.** Production never relies on whichever Git checkout was used last.

## Docker topology

| Network | Purpose |
|---------|---------|
| **`veralux-network`** | `control`, `runtime`, `postgres`, `redis`, `whisper*`, chosen TTS service, optional `brain` — service DNS aliases must match URLs in voice env |

### Compose stack

- **Core:** root `docker-compose.yml` (`-p veralux`).
- **Production overlay:** `docker-compose.production.yml` adds `env_file` via `${VERALUX_COMPOSE_ENV_FILE}` (exported by `scripts/start-production.sh` or manually).
- **Interpolation:** Always pass **`docker compose --env-file "${VERALUX_COMPOSE_ENV_FILE}"`** together with `-f docker-compose.yml -f docker-compose.production.yml`.

### Topology fragment (URLs + GPU pinning)

Committed non-secret overrides: `deploy/production-env-fragment.env`.  
Merged at bring-up (`merge-voice-env.py`) over `$VERALUX_VOICE_ENV_FILE`, then exported as `VERALUX_COMPOSE_ENV_FILE`. Replace values in **`/etc/veralux/voice-runtime.env`** when you intend to deprecate fragment merging.

See `.env.production.example` for a full annotated template (without real secrets).

## STT/TTS modes

Production uses **one composable NVIDIA profile** (`--profile gpu`):

| `TTS_MODE` | Containers started by `scripts/start-production.sh` |
|------------|------------------------|
| `chatterbox_http` | `whisper-gpu`, `chatterbox-gpu` |
| `kokoro_http` | `whisper-gpu`, `kokoro-gpu` (needs images/volumes wired for models) |
| `coqui_xtts` | `whisper-gpu`, `xtts-gpu` |
| `qwen3_tts_http` | `whisper-gpu`, `qwen3-tts-gpu` |

Legacy split stack `veralux-audio-stack` is **stopped** automatically by `start-production.sh`; optional Traefik+k profiles live there only for standalone lab scenarios.

### Chatterbox

- Compose service: **`chatterbox-gpu`** (`Dockerfile.chatterbox`, port **7005**, **`GET /health`**).
- **Requires NVIDIA** and usually **`HF_TOKEN`** for gated HF downloads (`HF_TOKEN=` in `.env.production.example` — set on host, never log).
- **GPU IDs:** Fragment sets `WHISPER_GPU_IDS=0`, `CHATTERBOX_GPU_IDS=1`; adjust when sharing silicon with vLLM.

## Ingress (Cloudflare)

| Role | Prefer |
|------|--------|
| **Authoritative tunnels** | **systemd** `cloudflared` (`/etc/cloudflared/config.yml`): `voice.veralux.ai` → `localhost:4001`, admin/portal → `localhost:4000`, dashboard → `localhost:3000` |
| **Legacy / dev** | Docker `cloudflared` (**profile `docker-cloudflared-legacy`** only). **Do not** run two tunnels for the same public hostnames |

## Health endpoints (runtime `:4001`)

| Path | Behaviour |
|------|-----------|
| `GET /health/live` | Always **200** — process alive. |
| `GET /health/ready` | **503** unless Redis **and** STT/TTS probes succeed (honest readiness). |
| `GET /health/voice` | Same strict readiness; explicit label for operators and Docker healthcheck. |
| `GET /health` | Diagnostic: **200** with `status: degraded` when only voice deps fail (see `observability.md`). |

Production **Docker healthcheck** targets **`GET /health/voice`** (requires rebuilt `runtime` image that includes `/health/voice`).

## Bring-up / shutdown

Scripts under `scripts/` share **`veralux-compose-helper.sh`**: they load env with `set -a; source …` and run **`command docker compose`** (never `docker-compose` v1, never `docker compose --env-file`, which breaks some Docker Compose v5 installs).

```bash
# After copying tree to /opt and permissions on /etc/veralux:
export VERALUX_PROD_ROOT=/opt/veralux/veralux-voice-runtime
export VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env   # optional if default
sudo -E ./scripts/start-production.sh
./scripts/status-production.sh
./scripts/validate-voice-topology.sh /etc/veralux/voice-runtime.env   # or merged path
```

```bash
./scripts/stop-production.sh
```

## Manual operator steps still required

1. **Rewrite `/etc/veralux/voice-runtime.env`** with real secrets (not `CHANGE_ME_*`) — or use repo `.env` only on dev; production must converge on `/etc`.
2. **Set `HF_TOKEN`** if Chatterbox model downloads require Hugging Face auth.
3. **Stop duplicate tunnels** — keep either systemd or Docker cloudflared, not both, for the same DNS names.
4. **Rotate** any credentials that ever appeared in shell logs or tickets.
