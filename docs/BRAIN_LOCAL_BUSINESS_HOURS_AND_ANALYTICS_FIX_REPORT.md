# Brain-local business hours and admin analytics alignment

## 1. Executive summary

Two production misalignments were fixed in one coordinated change set:

- **Issue A (business hours):** The local default brain (`brain_local_default`) answered hours questions from generic fallbacks or from legacy `assistantContext.hours` text, while structured tenant hours were already published under `llmContext.businessHours` and merged into the brain context under the key `Business schedule`, which `defaultBrainReply` never read for short intents like “when do you close?”.
- **Issue B (analytics):** `GET /api/admin/analytics` returned `tenant.analytics.snapshot()` backed by **in-memory** counters updated only when the runtime hit `POST /api/runtime/analytics`. Persisted call rows written by `POST /api/runtime/calls` (the same source as **Admin Calls**) were never counted, so Analytics showed zero while Calls showed records.

LLM provider routing, Telnyx verification, runtime-control auth, and tenant isolation boundaries were not intentionally changed beyond the scoped fixes above.

---

## 2. Root cause A — why `brain_local_default` ignored saved business hours

1. **Publish path was already correct:** `buildTenantRuntimeConfig` validates `tenant.businessHours` and places them on `RuntimeTenantConfig.llmContext.businessHours` (see `control-plane/src/runtime/buildTenantRuntimeConfig.ts`).
2. **Runtime merge for HTTP brain was helpful but mis-keyed for the default brain:** `callSession.brainAssistantContext()` evaluates structured hours and injects a long block under the key **`Business schedule`**, not `hours`. `defaultBrainReply` only consulted `assistantContext.hours` for open/close/hours wording.
3. **Seeded `assistantContext.hours`:** Deployments using `scripts/seed-default-runtime-config.json` often still have a static `hours` string; that text could override user expectations even when structured hours differed—structured answers now take **precedence** when the caller’s utterance is hours-related and a valid weekly schedule exists.
4. **Hardcoded fallbacks** in `defaultBrainReply` remained for tenants with no structured schedule.

### Runtime config flow (before / after)

| Aspect | Before | After |
|--------|--------|-------|
| Structured `llmContext.businessHours` on tenant config | Published and loaded | Unchanged |
| `defaultBrainReply` | Ignored structured hours; used `ctx.hours` or generics | Calls `voiceReplyFromBusinessHours()` first when utterance is hours-related |
| Logging | No explicit signal | `local_brain_business_hours_used` with `timezone`, `schedule_present`, `source` (`tenant_config` / `fallback_default`) — no transcript or phone numbers |
| Deterministic tests | N/A | Optional `referenceTime` on `defaultBrainReply` / `AssistantReplyInput` for unit tests only; live calls use wall clock |

---

## 3. Root cause B — why Analytics showed zero while Calls showed rows

| Aspect | Before | After |
|--------|--------|-------|
| `GET /api/admin/analytics` data source | `AnalyticsTracker` in-memory (`tenant.analytics.snapshot()`) | Postgres `calls` table for the active tenant (`getCallAnalyticsPayloadForTenant`) |
| `totalCalls` | In-memory `call_started` events only | `COUNT` of persisted rows for that `tenant_id` (same scope as list query used for Calls) |
| `totalCallerMessages` / `topQuestions` | In-memory `caller_message` events | Derived from sanitized `history` arrays on persisted rows (`user` / `caller` roles, normalized like the legacy tracker) |
| `Cache-Control` | Not set on this route | `no-store, private` + `Pragma: no-cache` (aligned with Admin Calls) |
| Portal compatibility | Expected `callCount` / `callerMessageCount` | Response also includes `totalCalls` / `totalCallerMessages`; portal reads either shape |

`POST /api/runtime/analytics` and in-memory `recordNewCall` behavior were left in place for any other consumers; **Admin Analytics** no longer depends on them.

---

## 4. Files changed

### Issue A — business hours / local brain

| File | Change |
|------|--------|
| `shared/src/businessHours.ts` | Added `hasTenantBusinessSchedule`, `voiceReplyFromBusinessHours`, and voice formatting helpers |
| `veralux-voice-runtime/src/ai/defaultBrain.ts` | Prefer structured hours via shared helper; optional `referenceTime`; logging |
| `veralux-voice-runtime/src/ai/brainClient.ts` | Pass `llmContext.businessHours` and optional `referenceTime` into `defaultBrainReply` |
| `veralux-voice-runtime/tests/defaultBrainBusinessHours.test.ts` | New tests for precedence, isolation, and `brain_local` vs `BRAIN_URL` |

### Issue B — analytics

| File | Change |
|------|--------|
| `control-plane/src/callAnalyticsFromDb.ts` | **New:** `aggregateCallRowsToAnalytics`, `getCallAnalyticsPayloadForTenant` |
| `control-plane/src/server.ts` | `GET /api/admin/analytics` async, DB-backed payload, cache headers |
| `control-plane/package.json` | Register `tests/callAnalyticsFromDb.test.js` |
| `control-plane/tests/callAnalyticsFromDb.test.js` | **New:** aggregation unit tests |
| `control-plane/tests/productionReadiness.integration.test.js` | Assert analytics after persisted call + `Cache-Control` |
| `control-plane/public/admin.html` | Refresh Calls also refreshes Analytics |
| `control-plane/public/portal.html` | Read `totalCalls` / `totalCallerMessages` if legacy keys absent |

### Docs / control-plane tests

| File | Change |
|------|--------|
| `control-plane/tests/sprint0Security.test.js` | Prove `businessHours` publish into `llmContext` |
| `shared/tests/businessHours.test.cjs` | Tests for `voiceReplyFromBusinessHours` |
| `docs/BRAIN_LOCAL_BUSINESS_HOURS_AND_ANALYTICS_FIX_REPORT.md` | This document |

---

## 5. Tests added or updated

### Business hours / local brain

1. Shared: `voiceReplyFromBusinessHours` non-hours → `null`; close time; closed day + after-hours message.
2. Runtime: structured hours beat legacy `assistantContext.hours`; fallback without config; tenant A vs B different answers; `PLATFORM_LLM_PROVIDER=brain_local` with `BRAIN_URL` set still resolves to `brain_local`.
3. Control-plane: `buildTenantRuntimeConfig` publishes validated `businessHours` into `llmContext`.

### Analytics

1. `aggregateCallRowsToAnalytics`: counts calls, caller messages, missed vs answered, legacy `from`/`message` history.
2. Integration: after `POST /api/runtime/calls` end + `GET /api/admin/calls`, `GET /api/admin/analytics` returns `totalCalls >= 1`, `no-store`, and caller message count from history.

---

## 6. Commands run (results)

From repo root (2026-05-09 environment):

- `npm run build -w @veralux/shared` — **pass**
- `npm test -w @veralux/shared` — **pass**
- `npm run build -w veralux-voice-runtime` — **pass**
- `npm test -w veralux-voice-runtime` — **pass**
- `npm run build -w veralux-receptionist` — **pass**
- `npm test -w veralux-receptionist` — **pass**
- `npm run test:production-readiness` — **pass**

---

## 7. Manual verification checklist

### Business hours

1. In Admin or Owner UI, set weekly business hours and timezone; save.
2. Use **Sync / publish** so Redis `tenantcfg:<id>` includes `llmContext.businessHours`.
3. Place a live call; ask: “When do you close?”
4. Confirm the spoken answer matches the published schedule (or after-hours text when closed).
5. In runtime logs, find `local_brain_business_hours_used` with `source: tenant_config` when structured hours applied.
6. Confirm `llm_provider_resolution` remains `brain_local` and `assistant_reply_source` remains `brain_local_default` when platform default is local brain.

### Analytics

1. Complete a call so `POST /api/runtime/calls` persists an `end` row (same flow as before).
2. Open **Admin Calls** — row visible.
3. Open **Admin Analytics** (plan must allow `advancedAnalytics`, as before) — **Total calls** matches persisted count; **Caller messages** reflects `history` entries with user/caller content.
4. Response headers include `Cache-Control: no-store, private`.
5. Click **Refresh calls** — Analytics should refresh in the same action.

---

## 8. Rollback notes

- **Business hours:** Revert `defaultBrain.ts`, `brainClient.ts`, and `shared/src/businessHours.ts` to restore legacy behavior (risk: hours answers drift from admin again).
- **Analytics:** Revert `server.ts` analytics handler and remove `callAnalyticsFromDb.ts` to return to in-memory snapshots (risk: Analytics diverges from persisted Calls again).
- Redis / Postgres data migrations were **not** required; rollback is code-only.

---

## 9. Security / privacy notes

- No raw phone numbers, API keys, or full transcripts were added to new logs.
- Analytics aggregation uses the same `history` JSON already stored for call records; question text is normalized/truncated like the prior in-memory tracker (160-char key).
- Tenant isolation: analytics query is `WHERE tenant_id = $1` bound to the admin session tenant; aggregation helpers assume rows are pre-scoped.
