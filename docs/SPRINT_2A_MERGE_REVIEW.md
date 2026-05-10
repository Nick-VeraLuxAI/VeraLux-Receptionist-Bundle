# Sprint 2A — merge safety and VeraTitan validation

**Branch:** `sprint-2a-portable-deployment`  
**Review date:** 2026-05-09  
**Workspace:** `/home/ndesantis/Documents/GitHub/VeraLux-Receptionist-Bundle`  
**Deployed runtime tree (this host):** `/opt/veralux/veralux-voice-runtime`

---

## 1. Git summary

Commands run:

```bash
git branch --show-current
git status --short
git diff --stat
git diff --name-only
```

**Branch:** `sprint-2a-portable-deployment`  
**Baseline (pre-Sprint-2A work):** `35ece91`  
**Tip after finalization commits:** see **`git log sprint-2a-portable-deployment`** (includes **`979af98`** main payload plus small doc-only follow-ups).

**At original review time:** 21 modified tracked files + 18 untracked paths; changes are now **committed** on the branch (see **`docs/SPRINT_2A_FINALIZATION_REPORT.md`**).

---

## 2. File categorization

### A. Sprint 2A portability (core)

| Path |
|------|
| `docker-compose.yml` (additive runtime env passthrough) |
| `docker-compose.cloud-api.yml`, `docker-compose.local-gpu.yml`, `docker-compose.hybrid.yml` |
| `scripts/deploy-profile.sh`, `scripts/preflight-profile.sh`, `scripts/validate-profile.sh` |
| `veralux-voice-runtime/src/env.ts`, `veralux-voice-runtime/src/routes/health.ts` |
| `veralux-voice-runtime/tests/healthVoiceDependencyMode.test.ts` |
| `control-plane/src/config.ts`, `control-plane/src/server.ts` |
| `control-plane/public/portal.html`, `control-plane/public/owner.html` |
| `control-plane/tests/sprint2aSafeApi.test.js` (+ `control-plane/package.json` test wiring if only for this file) |
| `shared/src/runtimeConfigRedaction.ts`, `shared/src/index.ts` |
| `.env.example` (portable / health vars) |
| `.env.cloud-api.example`, `.env.local-gpu.example`, `.env.hybrid.example` |
| `HEALTH_MODEL.md` (health contract alignment) |
| `docs/PORTABLE_DEPLOYMENT_ARCHITECTURE.md`, `docs/PORTABLE_DEPLOYMENT_SPRINT_2A_REPORT.md` |
| `docs/CLOUD_API_DEPLOYMENT.md`, `docs/LOCAL_GPU_DEPLOYMENT.md`, `docs/HYBRID_DEPLOYMENT.md` |

### B. Release-hardening / CI / infra leftovers (split from Sprint 2A)

| Path |
|------|
| `.github/workflows/production-readiness.yml` |
| `PRECHECKS.md`, `TEST_INFRASTRUCTURE.md` |
| `scripts/preflight.sh` |
| `veralux-voice-runtime/tests/callFlow.integration.test.ts`, `veralux-voice-runtime/tests/testEnv.ts` |
| `veralux-voice-runtime/package.json`, `veralux-voice-runtime/brain-gpt4o/package.json` |
| `docs/RELEASE_HARDENING_AUDIT_FIX_REPORT.md` (untracked) |

### C. Docs-only (boundary cases)

| Path | Note |
|------|------|
| `HEALTH_MODEL.md` | Overlaps A + operational doc — keep with portability or docs commit. |

### D. Dependency / lockfile churn

| Path |
|------|
| `package.json`, `package-lock.json` (root) |

### E. Unrelated or suspicious

**None identified** as accidental edits outside the two themes above. The mix is **intentional cohabitation** of two workstreams on one branch, not random noise.

---

## 3. Safety confirmations

| Check | Result |
|-------|--------|
| `scripts/start-production.sh` modified? | **No** — not in `git diff --name-only`. |
| GPU service names renamed? | **No** — `docker-compose.yml` still defines `whisper-gpu`, `chatterbox-gpu` (and related GPU services). |
| Production startup command | Still valid: `cd /opt/veralux/veralux-voice-runtime` then `sudo -E VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env ./scripts/start-production.sh`. |
| Cloud API work | **Additive** — new merge files + scripts; base `docker-compose.yml` keeps full graph; cloud overlay does not add GPU services. |

**Secrets:** No `.env` contents were printed. `/etc/veralux/voice-runtime.env` was **not** modified.

**Update (merge-readiness cleanup):** `preflight-profile.sh` now treats **bundled Compose `redis`** as satisfying the Redis contract when `REDIS_URL` is absent from merged env files (matches split-env production). Optional **`--fragment-env`** merges extra files after **`--env-file`** for operators who keep `REDIS_URL` only in a bridge file.

---

## 4. Compose validation

### Production (`/opt/veralux/veralux-voice-runtime`)

```bash
VERALUX_COMPOSE_ENV_FILE=/etc/veralux/voice-runtime.env \
  docker compose -f docker-compose.yml -f docker-compose.production.yml -p veralux --profile gpu config --services
```

**Services (order may vary):** `postgres`, `redis`, `whisper-gpu`, `chatterbox-gpu`, `control`, `kokoro-gpu`, `qwen3-tts-gpu`, `runtime`, `xtts-gpu`.

**Required set present:** `postgres`, `redis`, `control`, `runtime`, `whisper-gpu`, `chatterbox-gpu`.  
**Extra services:** `kokoro-gpu`, `qwen3-tts-gpu`, `xtts-gpu` — **harmless / optional** GPU profile services, same class as before.

### Cloud API (workspace repo)

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud-api.yml -p veralux-cloud-api config --services
```

**Result:** `postgres`, `redis`, `control`, `runtime` only.

**Absent (as required):** `whisper-gpu`, `chatterbox-gpu`. No `vllm` / `brain` services in this list. **NVIDIA** not required for this `config` invocation.

Full render check:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud-api.yml -p veralux-cloud-api config >/tmp/veralux-cloud-api-compose.yml
```

**Exit code:** 0.

---

## 5. VeraTitan hardware validation — **PASS** (final)

Operator bring-up on VeraTitan completed successfully using the **existing** production path (no changes to `scripts/start-production.sh`):

```bash
cd /opt/veralux/veralux-voice-runtime
sudo -E VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env ./scripts/start-production.sh
```

**Recorded outcomes (non-secret):**

| Check | Result |
|-------|--------|
| **Runtime image** | Built / started as expected |
| **postgres** | Healthy |
| **redis** | Healthy |
| **control** | Healthy |
| **runtime** | Healthy |
| **whisper** | Healthy |
| **chatterbox** | Healthy |
| **`validate-voice-topology`** (script phase) | **PASS** |
| **`GET /health`** | **`status` ok** — Redis / Whisper / TTS checks ok |
| **`GET /health/voice`** | **`status` ok** — Redis / Whisper / TTS checks ok |
| **Local GPU + `TTS_MODE=chatterbox_http`** | **Intact** (no regression observed) |

**Cloud-api compose (design validation):** `docker-compose.yml` + `docker-compose.cloud-api.yml` resolves to **postgres, redis, control, runtime** only — **no GPU services required** — **PASS**.

**Existing local-gpu production path:** **PASS** (same commands, same service set including `whisper-gpu` / `chatterbox-gpu` under production + GPU profile).

**Final Sprint 2A status:** **Merge-ready** after commit split / PR review (see `docs/SPRINT_2A_COMMIT_PLAN.md` and `docs/SPRINT_2A_FINALIZATION_REPORT.md`). No secrets or full env output are recorded in this document.

### 5.1 Ongoing discipline

After **merge + sync to `/opt`**, repeat **`docs/POST_MERGE_VALIDATION.md`** on the revision that is actually deployed. Automated smoke is **not** a substitute for **manual pilot evidence** — see **`docs/FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST.md`**.

---

## 6. Profile scripts

| Command | Result |
|---------|--------|
| `bash -n` on `deploy-profile.sh`, `preflight-profile.sh`, `validate-profile.sh` | **Pass** |
| `./scripts/preflight-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env` | **Pass** — Redis contract satisfied via **bundled compose service `redis`** when `REDIS_URL` is absent from that file (no secret output). |
| `./scripts/validate-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env` | **Pass** — all HTTP checks 200; `docker compose -p veralux ps` shows expected services. |
| `./scripts/preflight-profile.sh --profile cloud-api --env-file .env.cloud-api.example` | **Pass** structural checks (same bundled Redis rule). Placeholder `CHANGE_ME` values are not semantic-validated; real keys still required for live traffic. |

---

## 7. Build / tests / audit

| Command | Exit | Note |
|---------|------|------|
| `npm run build` | 0 | shared + control-plane + voice-runtime (+ brain-gpt4o) |
| `npm test -w control-plane` | 0 | |
| `npm test -w veralux-voice-runtime` | 0 | |
| `npm run test:production-readiness` | 0 | |
| `npm audit --omit=dev --audit-level=high` | 0 | **0 vulnerabilities** reported |

Test infra (`./scripts/test-infra.sh`) was **not** required for readiness on this run (readiness passed as-is).

---

## 8. Recommended commit split

Ideal **three-commit** layout and **why a single atomic commit is often safer** are documented in **`docs/SPRINT_2A_COMMIT_PLAN.md`** (root **`package-lock.json`** couples workspaces; **`control-plane/package.json`** mixes dependency bumps with the Sprint 2A test list).

---

## 9. Remaining blockers

| Item | Severity |
|------|----------|
| **Single branch mixes Sprint 2A + hardening** | **Process** — use **`docs/SPRINT_2A_COMMIT_PLAN.md`** for an ordered split or one PR with a dual-scope description. |
| **Custom compose without `redis` service** | **Low** — preflight requires **`REDIS_URL`** in env if the graph does not ship bundled `redis`. |
| **Post-merge / post-sync validation** | **Process** — repeat **`docs/POST_MERGE_VALIDATION.md`** whenever `/opt` is updated from `main`. |

---

## 10. Go / no-go for merge

| Criterion | Status |
|-----------|--------|
| VeraTitan production path (`start-production.sh`) | **PASS** (operator run; §5) |
| `/health` and `/health/voice` OK local-gpu | **PASS** (§5) |
| Production compose includes GPU services | **Yes** with `--profile gpu` + `VERALUX_COMPOSE_ENV_FILE`. |
| Cloud-api compose without GPU services | **Yes** |
| No secrets in this report | **Yes** |
| Tests / readiness / audit | **Pass** |
| Unrelated changes explained | **Yes** — hardening vs portability; split recommended. |

**Verdict:** **Merge-ready** — VeraTitan **`start-production.sh`** run **passed** (§5); compose graphs validated; profile preflight/validate aligned with split-env Redis; CI/local tests and **`npm audit`** clean at last run (see `docs/SPRINT_2A_FINALIZATION_REPORT.md`).

**Sprint 2A script note:** `preflight-profile.sh` accepts bundled Compose **`redis`** when `REDIS_URL` is omitted from `/etc/veralux/voice-runtime.env` alone, plus optional **`--fragment-env`** for split files.

**Pilot / client readiness:** **not** the same as merge — use **`docs/FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST.md`**; do not mark pilot **PASS** without captured evidence (no secrets in artifacts).

---

## 11. Operator checklist (post-merge on VeraTitan)

1. Deploy Sprint 2A bits to `/opt` (or pull branch + rebuild images as you normally ship).  
2. Run:  
   `cd /opt/veralux/veralux-voice-runtime`  
   `sudo -E VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env ./scripts/start-production.sh`  
3. `curl -s http://localhost:4001/health` and `curl -s http://localhost:4001/health/voice`  
4. `./scripts/preflight-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env` (bundled Redis accepted), or add **`--fragment-env`** if you split `REDIS_URL` into a separate file.
