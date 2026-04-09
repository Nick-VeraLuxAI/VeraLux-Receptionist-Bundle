# Rollback runbook

Rolling back means **returning customer traffic to a known-good combination of **images** and, if necessary, **database state**. This stack does not ship a one-command “rollback”; use the steps below.

---

## 1. When to use

- Upgrade introduced **regression** (calls, UI, migrations).
- **Bad `VERSION` pin** pulled incompatible images.
- Need to **revert** after a failed or partial upgrade.

---

## 2. Image rollback (most common)

**Assumption:** Postgres schema is **backward compatible** with the older app (patch/minor releases) **or** no migration ran yet.

1. Edit **`.env`** / **`.env.internal`** and set **`VERSION`** (and **`REGISTRY`**) to the **previous** release tag.
2. Optional: compare with **`backups/veralux-images_pre-update_*.txt`** from the last successful **`./deploy.sh update`**.
3. Pull and recreate:

```bash
./deploy.sh update
```

With **`UPDATE_SKIP_BACKUP=1`** you may skip another dump if you are only moving backward and already have backups — otherwise let **`backup.sh`** run.

4. Verify: **`./deploy.sh versions`**, **`./scripts/healthcheck.sh`**, test call.

**Strict airgap:** set **`UPDATE_IGNORE_PULL_FAILURES=1`** only if older images are **already** on disk; otherwise pulls must succeed.

---

## 3. Database rollback (migrations already advanced)

**Assumption:** New control plane ran **forward** migrations; old binaries **cannot** run safely against new schema without vendor guidance.

1. **Stop** traffic (maintenance): scale tunnels or block ingress as appropriate.
2. **Restore** Postgres from a dump taken **before** the bad upgrade:

```bash
./deploy.sh restore ./backups/veralux_<timestamp_before_bad_upgrade>.sql.gz
```

3. Pin **`VERSION`** to the **old** release that matches that schema.
4. **`./deploy.sh update`** (or **`./deploy.sh up`**) to recreate containers on the old tag.
5. **Restart** **`control`** and **`runtime`** after restore if not already recycled (see **`BACKUP_RESTORE.md`**).
6. Verify UI + test call.

**Warning:** Restoring the DB **drops** data written after the backup timestamp.

---

## 4. Redis / runtime cache

- **Redis** is **not** restored by **`restore.sh`**. After DB restore, **restart `control` and `runtime`** so published tenant config realigns.
- **TTS caches** repopulate automatically (more latency until warm).

---

## 5. No good backup

- **Image-only rollback** (§2) if schema unchanged.
- If schema **and** data are wrong and there is **no** dump: recovery is **vendor/support** territory — avoid **`down -v`**.

---

## 6. Prevention

- Scheduled **`./deploy.sh backup`**.
- Keep **`veralux-images_*_*.txt`** from updates in **`backups/`** or ship to central logging.
- **Stage** the same **`VERSION`** on a non-prod host before fleet rollout.

---

## 7. See also

- **`BACKUP_RESTORE.md`**
- **`RELEASE_CHANNELS.md`**
- **`UPGRADE_RUNBOOK.md`**
