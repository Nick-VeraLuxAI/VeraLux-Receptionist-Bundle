# Sprint 2A — commit plan (release hardening + portable deployment)

**Branch:** `sprint-2a-portable-deployment`  
**Date:** 2026-05-09

This document supports a **clean merge** when the working tree mixes **release hardening** with **Sprint 2A portable deployment**. **No destructive git operations** are prescribed here.

---

## Why a naive three-commit split can be unsafe

1. **`package-lock.json`** is a **single workspace graph**. Bumps in `control-plane/package.json` / `veralux-voice-runtime/package.json` / root **`package.json`** (overrides, scripts) are reflected together in the lockfile. Committing **lockfile without** matching **`package.json`** (or vice versa) leaves **`npm ci`** in a broken intermediate state.
2. **`control-plane/package.json`** combines **Sprint 2A** (`tests/sprint2aSafeApi.test.js` in the `test` script) with **dependency version** changes. Splitting that file across commits requires **`git add -p`** or a manual edit sequence.
3. **`HEALTH_MODEL.md`** is both **operator documentation** and **Sprint 2A health semantics** — assign to **Commit 2** or **Commit 3** by team preference.

If reviewers are uncomfortable with interactive patches, use **one atomic commit** (see §4).

---

## Commit 1 — Release hardening (target file set)

| Path |
|------|
| `.github/workflows/production-readiness.yml` |
| `PRECHECKS.md` |
| `TEST_INFRASTRUCTURE.md` |
| `scripts/preflight.sh` |
| `veralux-voice-runtime/tests/callFlow.integration.test.ts` |
| `veralux-voice-runtime/tests/testEnv.ts` |
| `veralux-voice-runtime/brain-gpt4o/package.json` |
| `docs/RELEASE_HARDENING_AUDIT_FIX_REPORT.md` |

**Suggested message:**

`chore(ci): harden production readiness gate and test infra`

**Also include** if and only if you are splitting with care in the same commit:

- `package.json` (root) — **`test:production-readiness`** script change, **`overrides`**, **`dependencies`**
- `package-lock.json` — **must** match the above and any dependency bumps you include in Commit 1 or 2

---

## Commit 2 — Sprint 2A portable deployment (target file set)

| Path |
|------|
| `docker-compose.yml` |
| `docker-compose.cloud-api.yml` |
| `docker-compose.local-gpu.yml` |
| `docker-compose.hybrid.yml` |
| `scripts/deploy-profile.sh` |
| `scripts/preflight-profile.sh` |
| `scripts/validate-profile.sh` |
| `veralux-voice-runtime/src/env.ts` |
| `veralux-voice-runtime/src/routes/health.ts` |
| `veralux-voice-runtime/tests/healthVoiceDependencyMode.test.ts` |
| `veralux-voice-runtime/package.json` *(if changes are only Sprint 2A scripts/deps — often overlaps Commit 1)* |
| `shared/src/runtimeConfigRedaction.ts` |
| `shared/src/index.ts` |
| `control-plane/src/config.ts` |
| `control-plane/src/server.ts` |
| `control-plane/public/portal.html` |
| `control-plane/public/owner.html` |
| `control-plane/tests/sprint2aSafeApi.test.js` |
| `control-plane/package.json` *(requires `-p` if Commit 1 already touched deps)* |
| `.env.example` |
| `.env.cloud-api.example` |
| `.env.local-gpu.example` |
| `.env.hybrid.example` |
| `HEALTH_MODEL.md` *(optional: move to Commit 3)* |

**Suggested message:**

`feat(deploy): portable profiles, health modes, and admin URL redaction (Sprint 2A)`

---

## Commit 3 — Documentation and reports

| Path |
|------|
| `docs/PORTABLE_DEPLOYMENT_ARCHITECTURE.md` |
| `docs/PORTABLE_DEPLOYMENT_SPRINT_2A_REPORT.md` |
| `docs/CLOUD_API_DEPLOYMENT.md` |
| `docs/LOCAL_GPU_DEPLOYMENT.md` |
| `docs/HYBRID_DEPLOYMENT.md` |
| `docs/SPRINT_2A_MERGE_REVIEW.md` |
| `docs/SPRINT_2A_FINALIZATION_REPORT.md` |
| `docs/SPRINT_2A_COMMIT_PLAN.md` |
| `docs/POST_MERGE_VALIDATION.md` |
| `docs/FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST.md` |

**Suggested message:**

`docs: Sprint 2A portable deployment and pilot evidence runbooks`

---

## Recommended default for this repo state (atomic)

**One commit** with a **dual-scope body** (hardening + Sprint 2A) and the same file set as `git status` today, **or** follow §1–§3 using `git add -p` for `control-plane/package.json` and coordinated lockfile commits.

See **`docs/SPRINT_2A_FINALIZATION_REPORT.md`** for what was actually executed in the automation session (if any).
