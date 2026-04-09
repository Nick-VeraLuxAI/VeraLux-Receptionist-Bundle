# Client deploy checklist

Use this in order. **Official orchestration:** `./up` or `./deploy.sh up` from the repo root (same as **`./deploy.sh`** contract in **`DEPLOYMENT_CONTRACT.md`**).

---

## A. Host

- [ ] Docker + **`docker compose`** available (`docker compose version`).
- [ ] Ports free: **`CONTROL_PORT`** (default 4000), **`RUNTIME_PORT`** (default 4001), **`WHISPER_PORT`** (default 9000) unless you changed them in `.env`.
- [ ] For GPU voice: **`nvidia-smi`** works; NVIDIA Container Toolkit installed.
- [ ] Disk: several GB for images; GPU models need more RAM/VRAM per service (see compose `deploy.resources`).

---

## B. Configuration files

- [ ] **`cp .env.example .env`** and fill required keys (see **`QUICKSTART.md`** table).
- [ ] **`TTS_MODE`** is one of: `coqui_xtts`, `kokoro_http`, `chatterbox_http`, `qwen3_tts_http` (voice deployments).
- [ ] If **`TTS_MODE=chatterbox_http`**: host must use **GPU** profile (no `chatterbox-cpu` in this repo — **`DEPLOYMENT_CONTRACT.md`**).
- [ ] Optional: **`.env.internal`** for overrides; **`deploy.sh`** merges it when present.
- [ ] **`VERSION`** / **`REGISTRY`** pinned (avoid **`latest`** for fleets — **`RELEASE_CHANNELS.md`**).

---

## C. Start stack

- [ ] From repo root:

```bash
./up
```

- [ ] Preflight passed (script runs automatically; on failure, fix errors/warnings per **`PRECHECKS.md`**).

**Automated here:** container create/start, profile selection (`gpu`/`cpu`), optional Cloudflare tunnel if **`CLOUDFLARE_TUNNEL_TOKEN`** is set in merged env (**`deploy.sh`** behavior).

**Not automated:** Telnyx webhook URLs, DNS records, TLS on your own reverse proxy, Stripe/SMTP unless you configured env.

---

## D. First-boot wait (do not panic early)

- [ ] Postgres + Redis show **healthy** in Docker within ~1–2 minutes typically.
- [ ] Control plane: migrations run in container entrypoint; **`/ready`** may take up to ~1 minute after DB is up.
- [ ] Runtime **`/health/ready`**: may wait on **Whisper + TTS HTTP health**, not just Redis — **minutes** on first GPU/CPU model load (**`FIRST_BOOT_EXPECTATIONS.md`**).
- [ ] Run when things look stuck:

```bash
./deploy.sh status
docker inspect --format '{{.State.Health.Status}}' veralux-runtime 2>/dev/null || true
docker logs veralux-whisper 2>&1 | tail -80   # STT container name is fixed; service in compose is whisper-gpu or whisper-cpu
```

---

## E. Verification (host)

- [ ] 

```bash
./scripts/healthcheck.sh
```

- [ ] If **`BRAIN_USE_LOCAL=true`**, script also checks brain **`/health`** (see **`HEALTH_MODEL.md`**).

---

## F. Telephony (manual — required for PSTN)

- [ ] In **Telnyx** (or your carrier): webhook / connection URLs match **`PUBLIC_BASE_URL`** (runtime) and signing keys match **`.env`**.
- [ ] **`AUDIO_PUBLIC_BASE_URL`** matches how callers reach **`/audio`** on the runtime (tunnel or public URL).
- [ ] Place a **test call**; log path: `./deploy.sh logs runtime`.

---

## G. Ongoing operations

- [ ] Backups: `./deploy.sh backup` (Postgres; see **`BACKUP_RESTORE.md`**).
- [ ] Upgrades: `./deploy.sh update` after bumping **`VERSION`** (**`UPGRADE_RUNBOOK.md`**).
- [ ] Never use **`docker compose down -v`** on production unless you intend to wipe volumes (**`PERSISTENCE_CONTRACT.md`**).

---

## H. Optional tunnels

**Cloudflare (token in `.env`):** after `./up`, tunnel is started if token is configured (**`deploy.sh`**).  
**Explicit tunnel command:**

```bash
./deploy.sh tunnel cloudflare
```

**ngrok:**

```bash
./deploy.sh tunnel ngrok
```

Requires **`NGROK_AUTHTOKEN`** in env.
