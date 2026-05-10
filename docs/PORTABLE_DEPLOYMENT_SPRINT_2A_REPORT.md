# Portable deployment — Sprint 2A report

**Branch:** `sprint-2a-portable-deployment`  
**Date:** 2026-05-09

---

## 1. Safety checkpoint (before / during work)

| Check | Result |
|-------|--------|
| `git status` | **Mixed:** Sprint 2A files **plus** pre-existing local modifications on the same branch (from earlier work on `main` before branch creation): `.github/workflows/production-readiness.yml`, `PRECHECKS.md`, `TEST_INFRASTRUCTURE.md`, `package-lock.json`, `package.json`, `scripts/preflight.sh`, `veralux-voice-runtime` package/tests, etc. **Review the full diff before merging.** |
| `git diff --stat` (tracked only) | ~21 files, net +496 LOC in tracked diff at report time (includes unrelated dependency/doc edits). |
| `scripts/start-production.sh` | **Not modified** — VeraTitan `/opt/...` path unchanged. |
| `docker-compose.production.yml` | **Not modified.** |
| Core GPU service **names** in `docker-compose.yml` | **Unchanged** (`postgres`, `redis`, `control`, `runtime`, `whisper-gpu`, `chatterbox-gpu`, …). |

**Production compose validation (with dummy env file + GPU profile):**

```bash
touch /tmp/veralux-compose-dummy.env
VERALUX_COMPOSE_ENV_FILE=/tmp/veralux-compose-dummy.env \
  docker compose -f docker-compose.yml -f docker-compose.production.yml -p veralux --profile gpu config --services
```

Observed services include **`postgres`**, **`redis`**, **`control`**, **`runtime`**, **`whisper-gpu`**, **`chatterbox-gpu`** (plus other GPU profile services such as `kokoro-gpu`, `xtts-gpu`, `qwen3-tts-gpu` depending on the graph).

**Note:** `docker compose ... config --services` **without** `--profile gpu` lists only the always-on core (4 services) — that is expected Compose profile behavior, not a regression.

**Host validation not run in CI:** `sudo -E VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env ./scripts/start-production.sh` and `curl http://localhost:4001/health/voice` must be run on a real workstation/VeraTitan host before declaring production green.

---

## 2. Profiles implemented

| Profile | Meaning |
|---------|---------|
| **`local-gpu`** | Same as today: `deploy-profile.sh` passes **`--profile gpu`** when NVIDIA is present, else **`--profile cpu`**. Merges `docker-compose.local-gpu.yml` (marker overlay). |
| **`cloud-api`** | Merges `docker-compose.cloud-api.yml`; **does not** pass `gpu`/`cpu` profiles — only core services start; STT/TTS must be **external** URLs in env. |
| **`hybrid`** | Merges `docker-compose.hybrid.yml` (**skeleton** + docs only). |

**`DEPLOYMENT_PROFILE`** is optional in runtime `env.ts` (observability); **unset preserves prior default behavior** (`HEALTH_VOICE_DEPENDENCIES` defaults to **`strict`** via legacy `true` interpolation).

---

## 3. Env vars added / extended

| Variable | Where | Purpose |
|----------|--------|---------|
| `DEPLOYMENT_PROFILE` | Runtime (`env.ts`), examples | `local-gpu` \| `cloud-api` \| `hybrid` (optional) |
| `HEALTH_VOICE_DEPENDENCIES` | Runtime, compose | `strict` \| `configured` \| `disabled` (legacy `true`/`false` strings accepted) |
| `STT_HEALTH_URL` | Runtime, compose | Optional explicit STT health GET target in **strict** mode |
| `TTS_HEALTH_URL` | Runtime, compose | Optional explicit TTS health GET target in **strict** mode |
| `LLM_HEALTH_URL` | Runtime, compose | Optional explicit brain/LLM health GET target in **strict** mode |

Root **`.env.example`** documents these; **`.env.cloud-api.example`**, **`.env.local-gpu.example`**, **`.env.hybrid.example`** provide profile-scoped templates (no real secrets).

---

## 4. Compose files added

- `docker-compose.cloud-api.yml` — documentation / merge anchor (empty `services` merge).
- `docker-compose.local-gpu.yml` — merge anchor for local GPU workflow.
- `docker-compose.hybrid.yml` — skeleton merge overlay.

**`docker-compose.yml`:** additive `runtime` environment entries for `DEPLOYMENT_PROFILE`, `STT_HEALTH_URL`, `TTS_HEALTH_URL`, `LLM_HEALTH_URL`, and clarified `HEALTH_VOICE_DEPENDENCIES` comment.

---

## 5. Scripts added

| Script | Role |
|--------|------|
| `scripts/deploy-profile.sh` | Preflight → `docker compose config` → `up -d` → validate; **does not print secrets or raw URLs**. |
| `scripts/preflight-profile.sh` | Profile-aware structural checks (DB/Redis/public URLs/secrets length/cloud-api URL sanity). |
| `scripts/validate-profile.sh` | HTTP checks against control/runtime health endpoints; cloud-api hints for `configured` / `disabled` modes. |

**Redis / split-env (merge-readiness):** If `REDIS_URL` is **not** present in `/etc/veralux/voice-runtime.env` (or other `--env-file` inputs) but the **standard** `docker-compose.yml` defines the **`redis`** service, preflight treats Redis as satisfied via the **bundled Compose service** (matches VeraTitan production: Compose sets `REDIS_URL` on `control` / `runtime`). Operators may also pass **`--fragment-env PATH`** to merge extra key/value files **after** `--env-file` (e.g. a small bridge file containing only `REDIS_URL`). **No secret values are printed.**

`bash -n` was run successfully on all three scripts.

---

## 6. Provider health behavior

- **`strict`:** Same as legacy **`HEALTH_VOICE_DEPENDENCIES=true`** — probes derived `/health` (or explicit `*_HEALTH_URL` when set); optional brain probe from `BRAIN_URL` / `LLM_HEALTH_URL`.
- **`configured`:** Requires Redis + non-empty STT/TTS env contract; **does not** require provider `/health` unless `STT_HEALTH_URL` / `TTS_HEALTH_URL` / `LLM_HEALTH_URL` are set (then probes them).
- **`disabled`:** Redis-only for `/health/voice`, `/health/ready`, and aggregate `/health` voice gating (legacy **`false`**).

---

## 7. Redaction / safe API changes

- **`LLMConfigStore.getSafeTtsConfig()`** → **`SafeTtsPublicConfig`** (no raw infra URLs).
- **`LLMConfigStore.getSafeConfig()`** → omits **`localUrl`**; adds **`localLlmEndpointConfigured`**.
- **`GET /api/tts/config`**: safe payload for **non–super-admin**; full legacy payload for **superadmin** (admin console).
- **`POST /api/tts/config`**: same split on response JSON.
- **`GET /api/admin/health`**: safe by default; **`?diagnostics=1`** (superadmin) adds redacted diagnostics.
- **`@veralux/shared`**: **`redactPublishedRuntimeConfig`**, **`redactHttpUrlToPlaceholder`**.

---

## 8. Tests and commands run

| Command | Result |
|---------|--------|
| `npm run build:shared` && `npm run build -w control-plane` && `npm run build -w veralux-voice-runtime` | **Pass** |
| `npm test -w control-plane` | **Pass** (includes new `tests/sprint2aSafeApi.test.js`) |
| `npm test -w veralux-voice-runtime` | **Pass** (includes `tests/healthVoiceDependencyMode.test.ts`) |
| `npm run test:production-readiness` (root) | **Pass** (requires local test infra as before) |
| `bash -n` on profile scripts | **Pass** |
| `docker compose -f docker-compose.yml -f docker-compose.cloud-api.yml -p veralux config` | **Pass** |
| `docker compose -f docker-compose.yml -f docker-compose.local-gpu.yml -p veralux --profile gpu config` | **Pass** |

---

## 9. Pass / fail summary

| Criterion | Status |
|-----------|--------|
| Existing local-gpu default when `DEPLOYMENT_PROFILE` unset | **Pass** (no required new env) |
| `start-production.sh` untouched | **Pass** |
| Production compose still includes required GPU services when using `--profile gpu` + `VERALUX_COMPOSE_ENV_FILE` | **Pass** |
| Cloud-api profile validates without starting GPU profile | **Pass** (`config --services` shows core only without `--profile gpu`) |
| External-provider health supported | **Pass** (`configured` + optional `*_HEALTH_URL`) |
| Raw URLs not in normal tenant/portal JSON | **Pass** (superadmin retains full URLs for operator UI) |
| No secrets printed by new scripts | **Pass** |
| Preflight accepts VeraTitan split env without `REDIS_URL` in voice file when bundled `redis` exists | **Pass** (merge-readiness cleanup) |

---

## 10. Remaining portability gaps

- **Hybrid:** still **operator-defined** (no automated split-stack wiring).
- **Chatterbox** still **GPU-only** in compose (no `chatterbox-cpu` service).
- **STT** remains **Whisper HTTP contract** — no new third-party STT adapters in this sprint.
- **Merge branch:** resolve **unrelated** modified files before shipping Sprint 2A alone.

---

## 11. Cloud-api readiness for a real API-key test

**Ready for config / compose validation** without live keys. A full end-to-end call test still requires:

- Valid **Telnyx** credentials and public URLs  
- Working **external** STT/TTS HTTP endpoints matching the runtime’s expected contracts  
- Optional: set **`HEALTH_VOICE_DEPENDENCIES=configured`** until provider health URLs are known  

Use **`.env.cloud-api.example`** as the checklist.
