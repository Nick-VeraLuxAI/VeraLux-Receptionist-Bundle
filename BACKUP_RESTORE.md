# Backup and restore

This document defines **supported** and **optional extended** procedures for the Veralux receptionist bundle. The persistence inventory and classifications are in **`PERSISTENCE_CONTRACT.md`**.

---

## 1. Supported in-contract: PostgreSQL

### Backup

```bash
./deploy.sh backup
# or
./scripts/backup.sh [directory] [--s3 s3://bucket/prefix] [--retention DAYS]
```

- **Output:** `veralux_<timestamp>.sql.gz` (custom-format SQL with `--clean --if-exists` for safer re-apply).
- **Credentials:** read from `.env` then `.env.internal` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).
- **When:** cron on the host; **`deploy.sh update`** runs a best-effort backup before rolling update.

### Restore (destructive to current DB contents)

```bash
./deploy.sh restore ./backups/veralux_2026-04-06_120000.sql.gz
# Non-interactive (automation only):
./scripts/restore.sh ./backups/veralux_2026-04-06_120000.sql.gz --yes
```

- Confirms by typing **`RESTORE`** unless `--yes`.
- Does **not** modify Redis, audio, or control-upload volumes.
- After restore, **restart** control and runtime so Redis-backed runtime config realigns with DB:

```bash
./deploy.sh restart control
./deploy.sh restart runtime
```

- Re-verify tenants and place a **test call** if signatures or URLs changed between backup and restore.

### Manual one-liner (same as restore script)

```bash
gunzip -c ./backups/veralux_<timestamp>.sql.gz | docker exec -i veralux-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

---

## 2. Optional extended (not run by repo automation)

Operators with stricter RPO/RTO may add their own jobs for:

### Redis (`veralux-redis-data`)

- **Nature:** AOF file under `/data` in the `redis` container.
- **Classification:** **Critical** for in-flight state; **rebuildable** for tenant publish payloads after a known-good Postgres restore + control restart.
- **Example** (point-in-time copy while Redis is stopped or use `redis-cli SAVE` — consult Redis docs for consistency):

```bash
docker exec veralux-redis redis-cli SAVE
docker cp veralux-redis:/data/dump.rdb ./backups/redis-dump-$(date +%Y%m%d).rdb
```

Restore requires stopping Redis, replacing the RDB/AOF data with care — **easy to corrupt**; test on a clone first.

### Audio volume (`veralux-audio-storage`)

- **Nature:** Files under runtime `AUDIO_STORAGE_DIR` (default `/app/audio`).
- **Classification:** **Critical** for stable URLs to existing files; **rebuildable** for regeneratable content (e.g. greeting).

```bash
docker run --rm -v veralux-audio-storage:/data -v "$(pwd)/backups:/out" alpine \
  tar czf /out/veralux-audio-$(date +%Y%m%d).tgz -C /data .
```

Restore: extract into a **new** volume or same volume with stack stopped — match ownership/UID used by runtime (see runtime image user).

### Control uploads (`veralux-control-uploads`)

- **Nature:** Voice-clone WAVs for admin features.

```bash
docker run --rm -v veralux-control-uploads:/data -v "$(pwd)/backups:/out" alpine \
  tar czf /out/veralux-control-uploads-$(date +%Y%m%d).tgz -C /data .
```

### vLLM cache (`veralux-vllm-hf-cache`)

- Optional tarball for faster disaster recovery; safe to omit (**re-download**).

---

## 3. What backups do **not** include

- **Docker json-file logs** (ephemeral rotation).
- **Telnyx / DNS / TLS** configuration outside this repo.
- **Secrets** except as stored **inside Postgres** (encrypted fields) — still protect **`.env`** separately (secret manager, not git).
- **Model weights** inside audio GPU/CPU containers unless you add custom volume mounts.

---

## 4. Recovery scenarios (short)

| Scenario | Steps |
|----------|--------|
| **Accidental `down -v`** | Restore Postgres from latest `.sql.gz` if you have it; audio/redis/uploads are gone unless you have extended backups; redeploy stack; republish tenants from UI. |
| **Corrupt Postgres** | Restore from backup; restart control + runtime. |
| **Upgrade gone wrong** | Roll back `VERSION` / images; volumes unchanged; if DB migrations ran forward-only, restore DB from pre-upgrade backup. |
| **Redis only lost** | Restart `control` and `runtime`; verify each tenant still calls correctly; re-save tenant in UI if runtime config stale. |

---

## 5. Testing restores

- Use a **staging** host or duplicate volumes.
- After any restore, run **`./scripts/healthcheck.sh`** and **`./scripts/preflight.sh`**.
- Document your RPO (max acceptable data age) from backup cadence.

---

## 6. Related

- **`scripts/backup.sh`** / **`scripts/restore.sh`**
- **`PERSISTENCE_CONTRACT.md`**
- **`DEPLOYMENT_CONTRACT.md`** §7
