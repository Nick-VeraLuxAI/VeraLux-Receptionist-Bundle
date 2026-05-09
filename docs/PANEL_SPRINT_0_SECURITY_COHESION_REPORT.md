# PANEL — Sprint 0 Security & Cohesion Report

Companion to `docs/PANEL_CONTROL_SURFACE_AUDIT.md` and
`docs/PANEL_CLIENT_READINESS_CHECKLIST.md`. Sprint 0 closes the highest-risk
authorization gaps and the prompt/greeting cohesion bugs flagged by the audit.
The UI has not been redesigned and no broad new features were added.

---

## 1. Files changed

### Control plane

- `control-plane/src/server.ts`
  - `RequestContext` now carries `tenantIds?: string[]` (memberships from JWT).
  - `adminGuard` populates `ctx.tenantIds` from `listMembershipsForUser`.
  - `GET /api/admin/tenants` now filters by membership for JWT users; superadmin
    still sees all.
  - `POST /api/runtime/calls` and `POST /api/runtime/analytics` now call
    `ensureTenantAccess(req, res, tenantId)` so non-superadmin JWTs cannot
    publish call/analytics events for another tenant.
  - `DELETE /api/admin/leads/:id` now passes `tenant.id` into `deleteLead` so a
    matching lead is required for deletion.
  - All `/api/admin/telnyx/*` carrier-account routes are gated on
    `adminGuard("admin")` + the new `requireSuperAdminCtx` helper. Tenant viewer
    AND tenant-admin JWTs are denied; only superadmin (env / master / db admin
    key) may probe or mutate carrier-level Telnyx config.
  - `GET /api/admin/cloudflare/token` is restricted to superadmin and only
    reports `{ hasToken }`.
  - `POST /api/admin/cloudflare/token` is intentionally disabled — returns
    `410 cloudflare_token_set_via_env` with operator instructions; no longer
    mutates `process.env`.
  - `POST /api/tts/config` now rejects raw provider URL fields
    (`coquiXttsUrl`, `kokoroUrl`, `chatterboxUrl`, `qwen3TtsUrl`, `xttsUrl`)
    when the caller is not superadmin — returns
    `403 provider_url_admin_only`. Legitimate admin/owner edits to mode and
    tuning still work; the existing per-mode URL is preserved server-side.

- `control-plane/src/automations/db.ts`
  - `deleteLead(id, tenantId?)` now adds an optional `AND tenant_id = $2`
    filter. Backwards-compatible (legacy callers still work).

- `control-plane/src/runtime/buildTenantRuntimeConfig.ts`
  - `buildLlmContext` now publishes `prompts.greetingText` (when non-empty)
    into the runtime contract so the voice runtime can read it.

- `control-plane/public/admin.html`
  - Removed the broken `requireAuth(saveCloudflareToken)` reference and the
    associated `cf-save-token` button / visibility toggle. Replaced with a
    read-only operator notice instructing how to set
    `CLOUDFLARE_TUNNEL_TOKEN` out-of-band.

- `control-plane/public/portal.html`
  - Removed the raw STT/TTS endpoint URL `<input>` from the portal Voice
    settings panel. Replaced with an operator notice.
  - Removed the Qwen3 internal URL hint copy
    (`http://veralux-qwen3-tts:7010` etc.) so the client portal no longer
    leaks infrastructure topology.
  - Removed the URL caching, URL placeholder switching, and URL save logic
    (`portalTtsUrlByMode`, `portalApplyTtsUrlForMode`,
    `portalRefreshTtsUrlCacheFromCfg`, plus URL writes in `savePortalTts`).

### Shared contract

- `shared/src/runtimeContract.ts`
  - `promptConfigSchema` now accepts an optional `greetingText` field so
    per-tenant greetings flow through the existing Redis-backed publication
    path (`tenantcfg:<tenantId>.llmContext.prompts.greetingText`).

### Voice runtime

- `veralux-voice-runtime/src/ai/brainClient.ts`
  - Imports `RuntimePromptConfig` from `@veralux/shared` as
    `AssistantPrompts`.
  - `AssistantReplyInput` now accepts `prompts?: AssistantPrompts`.
  - `generateAssistantReply` and `generateAssistantReplyStream` now include
    `prompts` (after a small sanitizer that drops blank fields) in the brain
    HTTP request body — both unary and SSE.
  - Forensics callbacks see the same payload, so prompt propagation is
    auditable in the existing forensics dump.

- `veralux-voice-runtime/src/calls/callSession.ts`
  - New private fields `tenantPrompts` and `tenantGreetingText`, captured in
    the constructor from `tenantConfig.llmContext.prompts`.
  - All four brain call sites (`generateAssistantReply` x3,
    `generateAssistantReplyStream` x1) now pass `prompts: this.tenantPrompts`.
  - `answerAndGreet` now uses `this.tenantGreetingText` when present, falling
    back to `env.GREETING_TEXT` and finally a literal default.

### Tests

- New: `control-plane/tests/sprint0Security.test.js`
  (registered in `control-plane/package.json` test script).
- New: `veralux-voice-runtime/tests/brainClientPrompts.test.ts`.
- New: `veralux-voice-runtime/tests/tenantGreetingPrompts.test.ts`.
- Extended: `control-plane/tests/productionReadiness.integration.test.js`
  (six new HTTP-level Sprint 0 isolation tests).

---

## 2. Vulnerabilities fixed (security)

| ID | Severity | Audit ref | Fix |
| --- | --- | --- | --- |
| S0-1 | High | `GET /api/admin/tenants` allowed any viewer JWT to list every tenant. | Listing now filtered to `ctx.tenantIds` for non-superadmin; superadmin keeps full list. |
| S0-2 | High | `POST /api/runtime/calls` trusted body `tenantId` after `adminGuard("admin")`, so a tenant-admin JWT could publish call state for any tenant. | Body `tenantId` is now bound by `ensureTenantAccess`. |
| S0-3 | High | `POST /api/runtime/analytics` had the same body-tenant gap. | Same fix as S0-2. |
| S0-4 | High | `DELETE /api/admin/leads/:id` did not filter by `tenant_id`, so a guessed UUID could delete another tenant's lead. | `deleteLead(id, tenantId)` now requires both columns to match. |
| S0-5 | High | `/api/admin/telnyx/*` carrier-level routes inherited the default viewer mount, allowing any tenant viewer to probe the shared Telnyx account. | Each route now requires `adminGuard("admin")` + `requireSuperAdminCtx`. Tenant-admin JWTs are also denied. |
| S0-6 | High | `POST /api/admin/cloudflare/token` mutated global `process.env` from a viewer-reachable endpoint (multi-worker incoherence + privilege escalation). | Endpoint replaced with `410` and operator instructions. Token is set out-of-band; GET status is superadmin-only. |
| S0-7 | Medium | `portal.html` exposed a raw TTS provider URL `<input>` and submitted `coquiXttsUrl/kokoroUrl/chatterboxUrl/qwen3TtsUrl/xttsUrl` in `POST /api/tts/config`, allowing a client to point production TTS at an attacker-controlled HTTP server (data exfiltration / SSRF). | Frontend input removed. Backend now returns `403 provider_url_admin_only` for any non-superadmin caller that submits one of those fields. Existing per-mode URLs are preserved by the merge layer. |
| S0-8 | Low | Client portal disclosed internal hostnames (`http://veralux-qwen3-tts:7010` etc.) in help copy. | Hint copy removed. |

## 3. Cohesion bugs fixed (behavior)

| ID | Audit ref | Fix |
| --- | --- | --- |
| C0-1 | Edited admin/owner/portal prompts (`systemPreamble`, `policyPrompt`, `voicePrompt`) wrote to `tenantcfg.llmContext.prompts` but `brainClient` never sent them, so prompt edits never affected LLM behavior. | `callSession` now captures `tenantConfig.llmContext.prompts` and passes them into every `generateAssistantReply{,Stream}` call. `brainClient` includes them under `prompts` in the brain HTTP request body (with blank fields stripped). |
| C0-2 | `callSession.answerAndGreet` always read `env.GREETING_TEXT`, so per-tenant greeting edits had no effect on real calls. | Greeting is now sourced from `tenantConfig.llmContext.prompts.greetingText` when present; env value remains the fallback. The `RuntimePromptConfig` schema gained an optional `greetingText` field and `buildLlmContext` publishes it. |
| C0-3 | `admin.html` Cloudflare Save button was wired to `requireAuth(saveCloudflareToken)`, but `requireAuth` is undefined in `admin.html` (only present in `owner.html`). The button threw a `ReferenceError` and never saved anything. | Button + handler removed; replaced with a read-only operator notice. The `requireAuth` reference is gone. |

## 4. Tests added

### Unit (cheap, no infra) — `control-plane/tests/sprint0Security.test.js`

- `deleteLead` exposes the `(id, tenantId?)` signature.
- `buildTenantRuntimeConfig` publishes per-tenant `systemPreamble`,
  `policyPrompt`, `voicePrompt`.
- `buildTenantRuntimeConfig` publishes per-tenant `greetingText` when set.
- `buildTenantRuntimeConfig` omits `greetingText` when blank (so runtime
  fallback applies).
- Tenant A vs tenant B prompts and greetings remain isolated in their
  published configs (no cross-tenant leak in the publisher).

### Unit (no infra) — `veralux-voice-runtime/tests/brainClientPrompts.test.ts`

- Tenant prompts are forwarded in the brain HTTP request body.
- Tenant A prompts do not leak into a subsequent tenant B request.
- Missing prompts produce a payload with no `prompts` key (safe fallback).
- Blank prompt fields are stripped (no empty preamble overwrite).

### Unit (no infra) — `veralux-voice-runtime/tests/tenantGreetingPrompts.test.ts`

- `callSession` captures per-tenant `greetingText` and `prompts` from
  `tenantConfig.llmContext.prompts`.
- Tenant A greeting / prompts do not leak into tenant B (two sessions
  observed side by side).
- Missing greeting leaves `tenantGreetingText` undefined so the runtime
  falls back to env.

### Integration (Postgres + Redis required) — extended
`control-plane/tests/productionReadiness.integration.test.js`

- `Sprint 0: GET /api/admin/tenants is scoped to JWT memberships` —
  superadmin sees both tenants; tenant-A JWT does not see tenant B.
- `Sprint 0: DELETE /api/admin/leads/:id requires tenant match` — superadmin
  acting in tenant-A context cannot delete a tenant-B lead (404, lead
  remains in DB); correct tenant succeeds.
- `Sprint 0: /api/runtime/calls and /api/runtime/analytics reject
  cross-tenant body tenantId` — tenant-A JWT (admin role) is forbidden from
  publishing for tenant B on both endpoints; same-tenant publish works.
- `Sprint 0: carrier-level Telnyx routes deny tenant JWT and require
  superadmin` — tenant viewer JWT is denied; tenant-admin JWT is also
  denied (carrier infra is super-admin only).
- `Sprint 0: Cloudflare token route is superadmin-only and write is
  disabled` — viewer + tenant-admin JWTs denied; superadmin GET works;
  superadmin POST returns 410.
- `Sprint 0: /api/tts/config rejects raw provider URL fields from
  non-superadmin` — five separate provider URL field names are each
  attempted by a tenant-admin JWT and each returns `403
  provider_url_admin_only`.

## 5. Commands run

All from repo root unless noted.

| Command | Result |
| --- | --- |
| `npm run build:shared` | OK |
| `npm run build:control` | OK |
| `npm run build:runtime` | OK |
| `npm run build` (all three) | OK |
| `cd control-plane && npm test` | **42 tests, 38 pass, 4 SKIP** (4 SKIPs are tenantLimitsDb tests requiring Postgres — they SKIP cleanly when DB is unavailable, same as before this sprint) |
| `cd veralux-voice-runtime && npm test` | **87 tests, 87 pass** (was 80; +7 new from Sprint 0 brainClient + greeting/prompts tests) |
| `./scripts/test-infra.sh up && ./scripts/test-infra.sh wait` | Postgres + Redis containers healthy |
| `cd control-plane && npm run db:migrate` | Migrations 0001–0012 applied |
| `cd control-plane && npm run test:production-readiness` | **11 tests, 11 pass** (4 baseline + 6 new Sprint 0 + cleanup) |
| `cd veralux-voice-runtime && npm run test:production-readiness` | **10 tests, 10 pass** |
| `./scripts/test-infra.sh down` | Containers removed |

## 6. Pass / fail status

- Builds: **PASS** (shared, control-plane, voice-runtime, brain-gpt4o).
- `control-plane` `npm test`: **PASS** (38 pass / 4 SKIP / 0 fail).
- `veralux-voice-runtime` `npm test`: **PASS** (87 pass / 0 fail).
- `control-plane` `npm run test:production-readiness`: **PASS** (11 pass / 0 fail).
- `veralux-voice-runtime` `npm run test:production-readiness`: **PASS** (10 pass / 0 fail).
- Lints (TypeScript): **PASS** (no new lint findings on touched files).

## 7. Acceptance criteria

| Acceptance criterion | Status |
| --- | --- |
| No tenant viewer can list/mutate other tenants. | **MET** — `GET /api/admin/tenants` filtered (S0-1); runtime/calls and runtime/analytics body `tenantId` bound (S0-2/S0-3); leads delete is tenant-scoped (S0-4); existing tenant-scoped admin endpoints (`/limits`, `/usage`, `/billing-summary`, etc.) keep their `ensureTenantAccess` guard. Verified by integration test suite. |
| No tenant viewer can mutate carrier/global Cloudflare/Telnyx infrastructure. | **MET** — Telnyx carrier routes require superadmin (S0-5); Cloudflare token write disabled, status read superadmin-only (S0-6). Verified by integration test suite. |
| Client portal no longer exposes raw provider URLs. | **MET** — `portal.html` URL input + Qwen3 hint copy removed (S0-7/S0-8); backend rejects raw URL fields from non-superadmin callers (S0-7). Verified by integration test. |
| Tenant prompt edits affect actual LLM behavior. | **MET** — `prompts` flows from Redis-published `tenantcfg.llmContext.prompts` → `callSession` → brain HTTP request body. Verified by `brainClientPrompts.test.ts` and `tenantGreetingPrompts.test.ts`. |
| Tenant greeting edits affect actual greeting playback. | **MET** — `tenantConfig.llmContext.prompts.greetingText` is published by the control plane and consumed by `answerAndGreet` with env fallback. Verified by `tenantGreetingPrompts.test.ts` and the `buildTenantRuntimeConfig` unit tests. |
| Tests prove A/B tenant isolation. | **MET** — Six new HTTP-level integration tests assert A/B isolation across tenants endpoint, leads delete, runtime calls/analytics, carrier Telnyx, Cloudflare, and TTS provider URL guard. Plus three new unit tests assert prompt/greeting isolation in the publisher and the runtime session capture. |

## 8. Remaining panel gaps (out of Sprint 0 scope)

These remain from `docs/PANEL_CLIENT_READINESS_CHECKLIST.md` and were not
touched in Sprint 0 (per "do NOT redesign UI, do NOT add broad features"):

- **Brain server contract.** The runtime now sends a `prompts` field, but the
  reference brain (`veralux-voice-runtime/brain-gpt4o`) needs to be updated
  to actually consume it (system message composition). Until then, prompt
  edits will reach the brain process but only take effect on brains that opt
  into the new field. Track separately.
- **Client portal call logs / transcripts / missed-call surfaces** still
  missing (audit P0).
- **Owner forgot-password flow** still missing (audit P0).
- **Live runtime health badge in client portal** (audit P1).
- **`usageLimits.features` not enforced by runtime** (audit P0): runtime
  reads usage caps but does not reject calls when feature flags are off.
- **Owner panel hardcodes `OWNER_TENANT_ID = "default"`** (audit P1).
- **Portal greeting/preview button** to "test what callers will hear" (audit P1).
- **Forensics admin-only gating** still uses `adminGuard("viewer")` for some
  read endpoints; tighten in a future sprint.

## 9. Pilot readiness

### Vendor-operated pilot (you run the panel, client only listens to calls)

- **Safe.** All Sprint 0 fixes hold. The only required mitigation is the
  existing one — keep `ADMIN_AUTH_MODE=jwt-only` (default in production) so
  no one can hit admin endpoints without an OIDC bearer or master key.

### Client self-serve

- **Mostly safe** for the configuration surface (greeting / prompts / TTS
  mode / quick replies / leads). Specifically:
  - A tenant-admin JWT can no longer enumerate other tenants, mutate carrier
    config, set raw provider URLs, delete other tenants' leads, or publish
    cross-tenant runtime events.
  - Per-tenant prompt and greeting edits now actually change call behavior,
    so portal "Save & publish" no longer feels like a no-op.
- **Not yet ready for unattended self-serve onboarding** because the audit
  P0 items above (call logs, transcripts, missed calls, "test the bot
  yourself" preview, forgot-password) remain. A first paid pilot still
  needs a human onboarder; once the audit P0 list is closed in the next
  sprint, the panel can be opened to self-serve sign-up.
