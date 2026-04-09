# Persistence contract (managed customer deployments)

This document is the **official contract** for what data exists on disk, how it is stored, how important it is, and what must survive upgrades. Operational backup/restore steps are in **`BACKUP_RESTORE.md`**.

---

## 1. Named Docker volumes (golden path)

| Volume name (Compose key) | Docker volume name | Mounted in | Classification |
|---------------------------|--------------------|------------|------------------|
| `postgres-data` | `veralux-postgres-data` | `postgres` → `/var/lib/postgresql/data` | **Critical persistent** — source of truth for product data. |
| `redis-data` | `veralux-redis-data` | `redis` → `/data` (AOF enabled) | **Critical persistent** for hot operational state; **partially rebuildable** from Postgres via control plane republication (see §4). |
| `audio-storage` | `veralux-audio-storage` | `runtime` → `/app/audio` (via `AUDIO_STORAGE_DIR`) | **Critical persistent** for served audio and generated assets on that volume; **partially rebuildable** (regenerate greeting, TTS re-synthesis). |
| `control-uploads` | `veralux-control-uploads` | `control` → `/app/control-plane/public/voice-recordings` | **Critical persistent** if voice-clone uploads are used; empty until first upload. If you set **`VOICE_RECORDINGS_DIR`** to another path, add a matching volume bind in **`docker-compose.override.yml`** — the default named volume only covers the default path. |
| `vllm-hf-cache` | `veralux-vllm-hf-cache` | `vllm-qwen` (profile **`llm`**) → `/root/.cache/huggingface` | **Cache / rebuildable** — faster restarts; re-download possible with `HF_TOKEN` and bandwidth. |

**Not named volumes (default compose):**

- **GPU/CPU audio images** (Whisper, Kokoro, XTTS, Chatterbox, Qwen3-TTS): model weights are **in the image** or downloaded into the **container writable layer** on first start (unless you add custom bind mounts in `docker-compose.override.yml`). Treat as **cache/rebuildable** unless you mount explicit host paths.
- **Chatterbox speaker cache** (`CHATTERBOX_SPEAKER_CACHE_DIR`, default `/tmp/...` in container): **cache/rebuildable**.
- **Control plane** static UI assets: **in image** (rebuild to change).

---

## 2. Data inventory by subsystem

### PostgreSQL

| Content | Classification |
|---------|------------------|
| Tenants, users, billing hooks, workflows, prompts, UI-owned settings | **Critical persistent** |
| Encrypted secret metadata when `SECRET_MANAGER=db` | **Critical persistent** |
| Migrations history | **Critical persistent** |

### Redis (`appendonly yes`)

| Content | Classification |
|---------|------------------|
| Published `tenantcfg:*`, `tenantmap:*`, capacity keys, runtime health keys | **Critical** for continuity; **rebuildable** after DB restore by restarting control + republishing (automation may republish on save; see **`BACKUP_RESTORE.md`**) |
| TTS audio bytes cache (Redis layer) | **Cache/rebuildable** |
| In-flight call / rate-limit state | **Ephemeral** — acceptable loss on flush |

### Runtime audio volume (`veralux-audio-storage`)

| Content | Classification |
|---------|------------------|
| `greeting.wav` and other generated/served WAVs under `AUDIO_STORAGE_DIR` | **Critical** for consistent URLs until regenerated; **rebuildable** via TTS |
| `STT_DEBUG_*` dumps under `stt-debug/` (and bind-mounted overrides) | **Optional debug** — safe to delete in production |

### Control uploads volume (`veralux-control-uploads`)

| Content | Classification |
|---------|------------------|
| Admin-uploaded voice-clone files (`voice-clone-*.wav`) | **Critical persistent** if features depend on them |

### Optional vLLM cache volume

| Content | Classification |
|---------|------------------|
| Hugging Face / downloaded weights cache | **Cache/rebuildable** |

### Logs

| Mechanism | Classification |
|-----------|----------------|
| Docker `json-file` logging (`max-size` / `max-file` in compose) | **Ephemeral** on host — rotate/discard; not a backup target in-contract |
| Application structured logs to stdout/stderr | Same |

### Bind mounts (`docker-compose.override.yml`)

| Typical use | Classification |
|-------------|----------------|
| STT debug WAV output to host dir | **Optional debug** |
| Custom branding / extra dirs | Operator-defined — document per host |

---

## 3. Official volume strategy

1. **Use the five named volumes** in root **`docker-compose.yml`** for any managed deployment. Do not store customer data only in anonymous volumes or container layers.
2. **Never run `docker compose down -v`** on production unless you intend to destroy named volumes (see **`README.md`** warnings).
3. **Pin** `VERSION` / `REGISTRY` for reproducible images; volumes survive image upgrades.
4. **Optional profile `llm`:** create `veralux-vllm-hf-cache` on first `up` with profile; safe to delete for disk recovery (cost = re-download).
5. **Overrides:** extra bind mounts are allowed for debug or compliance (e.g. read-only config), but the operator owns lifecycle and backup of those paths — not automated by repo scripts.

### First deploy after adding `veralux-control-uploads`

If you upgrade from a Compose file **without** the control uploads volume, Docker creates an **empty** named volume at `/app/control-plane/public/voice-recordings`. Any recordings that previously lived only in the **container writable layer** are **not** copied automatically. Before upgrading, copy them out (`docker cp`) or accept re-upload from the admin UI.

---

## 4. Redis vs Postgres (source of truth)

- **Postgres** is the **authoritative** store for configuration the UI/API writes.
- **Redis** holds **published** runtime view + caches + ephemeral keys. After a **DB-only** restore, Redis may still hold old tenant payloads: restart **`control`** and **`runtime`** and verify tenant settings in the UI; republish or re-save tenants if calls misbehave.
- For **point-in-time** continuity of Redis itself, use optional procedures in **`BACKUP_RESTORE.md`** (not the same as `./scripts/backup.sh`).

---

## 5. Upgrades: what must survive vs can be discarded

| Survive standard image upgrade | Safe to discard (with consequences) |
|-------------------------------|-------------------------------------|
| All **named volumes** above | **Redis** — lose live calls and caches; republish from DB |
| Host **`.env`** / **`.env.internal`** | **vLLM HF cache** — longer next start |
| | **TTS disk/Redis cache** — more TTS load until warm |
| | **STT debug files** |
| | **Container layer** (non-volume) model downloads — re-pull on new container |

Replacing **`POSTGRES_PASSWORD`** or wiping **`veralux-postgres-data`** without a restore **invalidates** the old database files — treat as **new install**.

---

## 6. Related documents

- **`BACKUP_RESTORE.md`** — backup scope, restore, optional Redis/audio archive.
- **`DEPLOYMENT_CONTRACT.md`** — supported `./deploy.sh backup` / `restore`.
- **`docker-compose.yml`** — volume definitions and inline comments.
- **`CONFIG_MATRIX.md`** — env vars affecting paths and features.
