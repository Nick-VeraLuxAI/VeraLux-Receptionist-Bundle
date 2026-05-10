# Sprint 2A — finalization report

**Branch:** `sprint-2a-portable-deployment`  
**Date:** 2026-05-09

---

## 1. Hardware validation summary

| Item | Result |
|------|--------|
| **`./scripts/start-production.sh`** on VeraTitan (`/opt`, `VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env`) | **PASS** |
| **Runtime image build** | **PASS** |
| **postgres / redis / control / runtime / whisper / chatterbox** | **Healthy** |
| **`validate-voice-topology`** | **PASS** |
| **`GET /health`** | **PASS** (`status` ok; Redis / Whisper / TTS checks ok) |
| **`GET /health/voice`** | **PASS** (same) |
| **Local GPU + `TTS_MODE=chatterbox_http`** | **Intact** |
| **Cloud-api compose** (no GPU services in service list) | **PASS** (see merge review) |
| **Existing local-gpu production path** | **PASS** |

No secrets or env dumps are stored in this report.

---

## 2. Git categorization (at finalization)

| Category | Paths (summary) |
|----------|-----------------|
| **A — Release hardening** | `.github/workflows/production-readiness.yml`, `PRECHECKS.md`, `TEST_INFRASTRUCTURE.md`, `scripts/preflight.sh`, `veralux-voice-runtime/tests/callFlow.integration.test.ts`, `veralux-voice-runtime/tests/testEnv.ts`, `veralux-voice-runtime/brain-gpt4o/package.json`, `docs/RELEASE_HARDENING_AUDIT_FIX_REPORT.md`, root **`package.json`** / **`package-lock.json`** (overrides + readiness script), **`control-plane/package.json`** dependency bumps |
| **B — Sprint 2A portable deployment** | Compose overlays, profile scripts, `docker-compose.yml`, voice **env/health**, `shared` redaction, **control-plane** server/config/UI + **sprint2aSafeApi** test wiring, `.env*` examples |
| **C — Docs / reports** | Portable deployment doc set, **`SPRINT_2A_MERGE_REVIEW`**, **`SPRINT_2A_COMMIT_PLAN`**, **`POST_MERGE_VALIDATION`**, **`FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST`**, **`HEALTH_MODEL.md`** |
| **D — Lockfile churn** | **`package-lock.json`** (monorepo-wide) |
| **E — Suspicious** | **None** — mixed scope is explained; see **`docs/SPRINT_2A_COMMIT_PLAN.md`** |

---

## 3. Commit plan vs commits created

**Plan:** Prefer **three commits** (hardening → Sprint 2A → docs) **or** one **atomic** commit when `package-lock.json` + mixed `control-plane/package.json` make a clean split risky.

**Executed in repo (automation session):** **One atomic commit** was created (lockfile + mixed `package.json` coupling):

- **`979af98`** — `chore(release): readiness gate and deps; feat(deploy): Sprint 2A portable profiles`

For a **three-commit** history, use **`docs/SPRINT_2A_COMMIT_PLAN.md`** and interactive staging (`git add -p`) on a branch reset or follow-up refactor **before** pushing shared branches.

---

## 4. Validations run (non-secret)

| Command | Result |
|---------|--------|
| `bash -n` on `deploy-profile.sh`, `preflight-profile.sh`, `validate-profile.sh` | **Pass** |
| `docker compose … production.yml --profile gpu config --services` | Includes **postgres, redis, control, runtime, whisper-gpu, chatterbox-gpu** (+ other GPU-profile services) |
| `docker compose … cloud-api.yml config --services` | **postgres, redis, control, runtime** only |
| `npm run build` | **Pass** |
| `npm test -w control-plane` | **Pass** |
| `npm test -w veralux-voice-runtime` | **Pass** |
| `npm run test:production-readiness` | **Pass** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |

---

## 5. Pass / fail

| Gate | Status |
|------|--------|
| Merge review doc updated with **PASS** hardware | **Pass** |
| Compose GPU + cloud-api graphs | **Pass** |
| Build / tests / readiness / audit | **Pass** |
| Post-merge instructions | **`docs/POST_MERGE_VALIDATION.md`** |
| Pilot evidence checklist | **`docs/FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST.md`** |

---

## 6. Post-merge instructions

Use **`docs/POST_MERGE_VALIDATION.md`** after every sync of the merged revision to **`/opt/veralux/veralux-voice-runtime`**.

---

## 7. Remaining manual pilot evidence

Automated validation **does not** replace **`docs/FINAL_WHITE_GLOVE_PILOT_EVIDENCE_CHECKLIST.md`**. **White-glove pilot** and **client self-serve** verdicts stay **pending** until evidence rows are filled without secrets.

---

## 8. Final recommendation

| Question | Answer |
|----------|--------|
| **Sprint 2A merge-ready?** | **Yes** — subject to normal code review; hardware and automated gates **passed** per §1 and §4. |
| **White-glove pilot ready?** | **Pending** — requires live PSTN evidence (checklist). |
| **Client self-serve ready?** | **No** unless proven otherwise after pilot and onboarding review. |
