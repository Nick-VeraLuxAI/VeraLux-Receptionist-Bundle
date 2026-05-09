# Panel Sprint 1 — Client / operator readiness

**Date:** 2026-05-09  
**Scope:** Operator dashboard, client portal, tenant-scoped APIs, runtime sync visibility, manual test-call workflow. No audio/STT/TTS pipeline changes. No exposure of secrets or raw provider URLs.

## Readiness score (directional)

| Area | Sprint 0 (baseline) | Sprint 1 |
|------|----------------------|----------|
| Prompts → reference brain | Partial | **Improved** (reference brain merges `prompts`; tests in `brain-gpt4o`) |
| Business hours | None | **Added** (DB + runtime LLM context + admin/portal editors) |
| Portal call visibility | None | **Added** (masked list + missed filter + detail drawer) |
| Runtime sync timestamp | Coarse (Redis hint only) | **Added** (`lastRuntimePublishedAt` on publish + admin/portal display) |
| Test call workflow | LocalStorage-only hint | **Server-backed** (`operator_state.testCall` + checklist + manual buttons) |

**Overall:** suitable for a **vendor-operated SMB pilot** when Postgres/Redis and migrations are applied; client self-serve still needs hardened auth stories, billing edge cases, and optional automated PSTN test hooks.

## Files changed (high level)

- **Shared:** `businessHours.ts`, `runtimeContract.ts`, `index.ts`; tests `shared/tests/businessHours.test.cjs`.
- **Control plane:** `server.ts` (owner/admin routes), `db.ts`, `tenants.ts`, `runtimePublisher.ts`, `buildTenantRuntimeConfig.ts`, `callSanitizer.ts`, migration `0013_business_hours_operator_state.sql`, `public/admin.html`, `public/portal.html`, tests under `control-plane/tests/`.
- **Voice runtime / brain:** Prior sprint work for `prompts` and `brainAssistantContext` remains; this sprint did not modify STT/TTS/audio paths.
- **Docs:** this report.

## Features added

1. **Brain prompt consumption (Phase 1)**  
   Reference `brain-gpt4o` builds the system prompt from incoming `prompts` + context (see `veralux-voice-runtime/brain-gpt4o`). Voice runtime sanitizes prompts including `greetingText`.

2. **Business hours (Phase 2)**  
   Weekly model with timezone, closed days, optional after-hours message; persisted on `tenant_configs`; included in published runtime LLM context; admin overview card + portal accordion; open/closed line from API evaluation.

3. **Portal calls (Phase 3)**  
   `GET /api/owner/calls`, `GET /api/owner/calls/:callId` with tenant isolation; masked caller display and transcript **summary** only (`callSanitizer`).

4. **Runtime sync timestamp (Phase 4)**  
   `publishTenantConfig` stamps `lastRuntimePublishedAt`; admin overview shows formatted time from Redis config; portal shows “Voice runtime last synced” via `GET /api/owner/voice-runtime-sync`.

5. **Test call workflow (Phase 5)**  
   `POST` mark-complete for admin and owner; checklist uses server `operator_state`; automated “Test call” remains disabled with “coming soon” copy; “Mark test call completed” for operators.

## Tests run

From repo root (after `npm install` if needed):

```bash
npm run build:shared -w @veralux/shared 2>/dev/null || npm run build -w @veralux/shared
npm test -w @veralux/shared
npm run build -w control-plane
npm test -w control-plane
```

**Note:** `sprint1ClientReadiness.test.js` and `tenantLimitsDb.test.js` require Postgres test URL (default `postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test`). Skip is automatic when DB is down.

Optional:

```bash
npm run test:production-readiness
```

(requires test infra / Redis per project scripts)

## UI / layout (description)

- **Admin overview:** Existing “Voice runtime status” card gains **Last voice runtime sync** next to Redis hint. New **Business hours** card (timezone, after-hours message, Mon–Sun grid, save). **Mark test call completed** beside disabled **Test call (coming soon)**. Handoff checklist “Test call completed” reflects `operator_state` with timestamp and actor when present.
- **Client portal:** Overview adds runtime sync line, **Recent calls** (All / Missed / Refresh), row opens a **right-hand drawer** with summary fields only. **Business hours** accordion mirrors admin behavior. **Go-live checklist** accordion + mark test call.

## What remains before client self-serve

- Automated PSTN or controlled test-call trigger (optional product decision).
- Richer call analytics and export without widening the PII surface.
- Optional: owner-only runtime publish guardrails and stricter JWT vs admin-key separation in non-prod.

## Acceptance checklist

- [x] Tenant prompts affect reference brain behavior (see brain-gpt4o tests / prior Phase 1).
- [x] Business hours stored, edited, included in runtime / LLM context path.
- [x] Portal can list recent/missed calls and summaries with masking.
- [x] Admin shows real `lastRuntimePublishedAt` when config exists in Redis.
- [x] Handoff / portal can mark test call complete with persistence and isolation tests for calls DB layer.
