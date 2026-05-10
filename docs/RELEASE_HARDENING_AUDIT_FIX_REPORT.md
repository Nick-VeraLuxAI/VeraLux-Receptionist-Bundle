# Release hardening audit fix report

This document records fixes applied after the Codex/Cursor audit of the production-readiness gate, preflight vs control-plane boot, dependency advisories, and call-flow integration semantics.

## 1. Root production-readiness gate (npm workspaces)

| Item | Result |
|------|--------|
| **Finding valid?** | Yes. `npm run test:production-readiness -w veralux-voice-runtime` also ran the nested workspace `brain-gpt4o`, which had no `test:production-readiness` script, so npm exited non-zero after the runtime suite passed. |
| **Root cause** | npm workspaces treat `veralux-voice-runtime/brain-gpt4o` as a sibling workspace under the runtime tree; `-w veralux-voice-runtime` still triggered lifecycle propagation to `brain-gpt4o`. |
| **Fix** | Root `package.json` now runs runtime readiness with a subshell: `(cd veralux-voice-runtime && npm run test:production-readiness:full)`. `.github/workflows/production-readiness.yml` uses `working-directory: veralux-voice-runtime` and `npm run test:production-readiness:full`. |
| **Files** | `package.json`, `.github/workflows/production-readiness.yml` |

## 2. Preflight vs `SECRET_ENCRYPTION_KEY` / `SECRET_MANAGER=db`

| Item | Result |
|------|--------|
| **Finding valid?** | Yes. Preflight used a 16-character minimum while `control-plane/src/secretStore.ts` requires 32 UTF-8 bytes for `SECRET_MANAGER=db`. |
| **Root cause** | Mismatched contract between shell preflight and TypeScript boot validation. |
| **Fix** | `scripts/preflight.sh` now measures UTF-8 byte length (`wc -c`) when `SECRET_MANAGER` is empty or `db`, and fails below 32 bytes with remediation `openssl rand -hex 32`. The check runs in CI mode whenever the key is non-empty (no longer tied to `PREFLIGHT_CI != 1`). Header comment for `--ci` updated. `.env.example` uses a 32-byte placeholder (`aaaaaaaa...` × 32) plus an inline comment. `PRECHECKS.md` table row updated. |
| **Files** | `scripts/preflight.sh`, `.env.example`, `PRECHECKS.md` |

## 3. Production dependency audit (`npm audit --omit=dev --audit-level=high`)

| Item | Result |
|------|--------|
| **Finding valid?** | Yes (pre-fix). High issues included `fast-xml-parser` / `@aws-sdk/xml-builder`, `path-to-regexp` via Express, and moderate `nodemailer`. |
| **Root cause** | Transitive versions pulled by `@aws-sdk/client-secrets-manager`, Express, and direct `nodemailer`. |
| **Fix** | Bumped `control-plane`: `@aws-sdk/client-secrets-manager` to `^3.1045.0`, `nodemailer` to `^8.0.7`, `express` to `^4.22.1`. Bumped `veralux-voice-runtime` and `brain-gpt4o` `express` to `^4.22.1`. Root `package.json` adds `overrides` for `fast-xml-parser` and a root `dependencies` entry `path-to-regexp@0.1.13` so the hoisted tree resolves the patched release. No `docs/DEPENDENCY_SECURITY_REVIEW.md` was added because **production-scoped** high advisories are cleared. |
| **Files** | `package.json`, `package-lock.json`, `control-plane/package.json`, `veralux-voice-runtime/package.json`, `veralux-voice-runtime/brain-gpt4o/package.json` |
| **Residual** | Full `npm audit` (including devDependencies) may still report highs (e.g. `picomatch` via tooling). Those are outside the stated production-only acceptance gate. |

## 4. Call-flow integration coverage semantics

| Item | Result |
|------|--------|
| **Finding valid?** | Yes. `test:production-readiness` listed `callFlow.integration.test.ts` but the suite was skipped unless `CI=true` or `RUN_CALL_FLOW_INTEGRATION=1`. |
| **Root cause** | Env gate in the test file plus misleading script naming. |
| **Fix** | **Scripts** (`veralux-voice-runtime/package.json`): `test:production-readiness` runs the deterministic files **without** call-flow integration. `test:production-readiness:full` runs the same set **with** `RUN_CALL_FLOW_INTEGRATION=1` and includes `callFlow.integration.test.ts`. `test:call-flow-integration` runs only that file with the flag set. `test:integration` delegates to `test:call-flow-integration`. Root and CI use `:full`. **Docs:** `TEST_INFRASTRUCTURE.md` describes the three commands. **Tests/fixtures:** `callFlow.integration.test.ts` tenant Redis payload aligned with `RuntimeTenantConfigSchema`; `postWebhook` uses unique `telnyx-timestamp` / `telnyx-signature` per request to avoid signature-replay key collisions across subtests. **Host + Telnyx test env:** `VERALUX_TEST_HOST_PATHS=1` is set on readiness scripts; `src/env.ts` rewrites `/app/...` debug/audio paths to `/tmp/veralux-runtime-test/...` when `VERALUX_TEST_HOST_PATHS=1` or `NODE_ENV=test`. `tests/testEnv.ts` forces Telnyx verify-off + skip only when `VERALUX_TEST_HOST_PATHS=1`; default `npm test` forces verify-on + skip-off so `telnyxVerify` tests stay strict. |
| **Files** | `veralux-voice-runtime/package.json`, `veralux-voice-runtime/tests/callFlow.integration.test.ts`, `veralux-voice-runtime/tests/testEnv.ts`, `veralux-voice-runtime/src/env.ts`, `TEST_INFRASTRUCTURE.md`, `.github/workflows/production-readiness.yml` (`VERALUX_TEST_HOST_PATHS`, `NODE_ENV`) |

## 5. Commands run and results

| Command | Result |
|---------|--------|
| `bash scripts/preflight.sh --ci .env.example` | Pass |
| `npm run build` | Pass |
| `npm test -w control-plane` | Pass |
| `npm test -w veralux-voice-runtime` | Pass |
| `npm run test:production-readiness` (with test infra already up) | Pass |
| `npm audit --omit=dev --audit-level=high` | **0** vulnerabilities |
| `npm audit` (full tree) | 3 issues (dev/transitive tooling; not in production acceptance scope) |

## 6. Updated readiness verdict

| Mode | Verdict |
|------|---------|
| **White-glove pilot** | **Improved.** The root readiness command and GitHub workflow now complete successfully when infra is healthy; call-flow integration is part of the explicit `:full` gate rather than implied by a skipped file. |
| **Turnkey / self-serve production** | **Improved, not fully turnkey.** Operators must still bring Postgres/Redis/test infra for the full gate, manage secrets to the 32-byte rule, and understand `test:production-readiness` vs `:full` vs `test:call-flow-integration`. Dependency hygiene for **production** installs is in good shape; dev-tooling advisories may remain until upstream bumps. |
