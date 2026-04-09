# Upgrade runbook (managed deployments)

Use this checklist for **customer hosts** running the official stack (**`./deploy.sh up`**). Schema and behavior details: **`DEPLOYMENT_CONTRACT.md`**, **`HEALTH_MODEL.md`**, **`PERSISTENCE_CONTRACT.md`**.

---

## 1. Risks this runbook mitigates

| Risk | Mitigation |
|------|------------|
| **`latest` tag drift** | Pin **`VERSION`** (see **`RELEASE_CHANNELS.md`**). `deploy.sh` warns on `latest` / empty pin. |
| **Mismatched images** | After upgrade: **`./deploy.sh versions`**; compare to intended **`REGISTRY`/`VERSION`**. |
| **Partial updates** | **`./deploy.sh update`** pulls **gpu/cpu** profile **and**, if running, **llm**, **cloudflare**, **ngrok** images. Audio services include **Chatterbox** when present. |
| **Schema migration timing** | **Control** container runs migrations **before** the server listens; **`/ready`** stays unhealthy until DB + migrations succeed. Order: Postgres → control → runtime. |
| **Tunnel gaps** | **Cloudflare** and **ngrok** are both restarted when their containers were running (fixed path in `deploy.sh update`). |
| **Rollback weakness** | Pre-update **`backup.sh`** + **`veralux-images_pre-update_*.txt`**; see **`ROLLBACK_RUNBOOK.md`**. |

---

## 2. Pre-upgrade (per host or cohort)

- [ ] Confirm **`REGISTRY`** and **`VERSION`** in **`.env`** / **`.env.internal`** match the **release ticket** (no accidental `latest`).
- [ ] **Maintenance window** (or accept brief control/runtime recycle).
- [ ] **Disk**: enough space for new image layers + **`./backups/`** dump.
- [ ] **Registry auth**: `docker login …` if images are private.
- [ ] Optional: notify customer of **Telnyx / URL** unchanged unless documented in release notes.

---

## 3. Upgrade command

```bash
cd /path/to/VeraLux-Receptionist-Bundle
./deploy.sh update
```

### Environment toggles (automation / special cases)

| Variable | Effect |
|----------|--------|
| **`UPDATE_IGNORE_PULL_FAILURES=1`** | Pull is best-effort (airgap / flaky registry). **Not** for strict fleet parity. |
| **`UPDATE_SKIP_BACKUP=1`** | Skips pre-update Postgres dump (only if another backup path exists). |
| **`UPDATE_SNAPSHOT_PRE=0`** | Skip `veralux-images_pre-update_*.txt`. |
| **`UPDATE_SNAPSHOT_POST=0`** | Skip `veralux-images_post-update_*.txt`. |
| **`VERALUX_SKIP_VERSION_WARN=1`** | Suppress pinning warnings in CI. |

---

## 4. Post-upgrade verification

1. **`./deploy.sh versions`** — every running app container should show **`…:${VERSION}`** (or your digest).
2. **`./scripts/healthcheck.sh`** — readiness for control + runtime.
3. **`./deploy.sh logs control`** — no migration errors; server started.
4. **Smoke**: open admin UI, place **test call** if voice release.

---

## 5. Async behavior (normal)

- **GPU/CPU audio** containers can take **minutes** after recreate to pass **`/health`** (model load).
- **First calls** after upgrade may see **cold** TTS/STT latency.

---

## 6. If upgrade fails mid-way

- Fix root cause (pull auth, disk, bad tag).
- Re-run **`./deploy.sh update`** after correcting **`.env`**.
- If **database migrated** and app is broken, use **`ROLLBACK_RUNBOOK.md`** (restore DB + pin previous **VERSION**).

---

## 7. Fleet automation hint

For many hosts: same repo path, same **`.env`** template, config management sets **`VERSION`**, run **`deploy.sh update`** via scheduler/SSH; aggregate exit codes and **`versions`** output.
