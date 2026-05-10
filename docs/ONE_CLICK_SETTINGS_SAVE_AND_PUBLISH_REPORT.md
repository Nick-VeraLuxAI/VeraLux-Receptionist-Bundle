# One-click settings save and voice runtime publish

## Executive summary

Operators no longer need a separate “Sync this business to voice runtime” click after saving **business hours**, **models & prompts**, **forwarding profiles**, or **pricing** (admin), or **business hours / prompts** (owner portal). Each save persists to Postgres (existing behavior) and, when `ENABLE_RUNTIME_ADMIN` is true, **rebuilds and publishes the full `RuntimeTenantConfig` to Redis**—the same path as `POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant`.

Manual republish remains as **Advanced / recovery** (overview button and Models → Voice publish button), with clearer copy.

---

## Old vs new workflow

| Old | New |
|-----|-----|
| Save business hours → remember to “Sync this business” or publish from Models | Save business hours once → Redis updated automatically (when runtime admin enabled) |
| Save prompts → `syncLLMContextToRuntime` merged partial `llmContext` (could **drop** `businessHours` from Redis) | Save prompts → **full** `buildTenantRuntimeConfig` + publish preserves merged Redis fields |
| Overview “Sync this business” triggered the **Models** publish button (saved voice form unexpectedly) | Overview **Advanced: Republish runtime config** calls `publish-from-tenant` only |

---

## Tab / page matrix

| Tab / page | Fields | Save endpoint | Affects runtime? | Before: extra sync? | After |
|------------|--------|---------------|------------------|----------------------|--------|
| Overview → Business hours | Weekly hours, TZ, after-hours | `PATCH /api/admin/tenants/:id/business-hours` | Yes | Often manual sync | **Auto-publish** + UI suffix |
| Models & Prompts → Prompts | Greeting, preamble, policy, voice, schema | `POST /api/admin/prompts` | Yes | Implicit partial Redis merge | **Full auto-publish** |
| Forwarding & Products | Profiles | `POST /api/admin/forwarding-profiles` | Yes | Partial merge | **Full auto-publish** |
| Forwarding & Products | Pricing | `POST /api/admin/pricing` | Yes | Partial merge | **Full auto-publish** |
| Models → Voice (Step 3) | TTS/STT-related | `POST /api/tts/config` | Yes | Already full publish | Unchanged (still full publish) |
| Owner portal → Business hours | Same as admin BH | `PATCH /api/owner/business-hours` | Yes | Manual publish | **Auto-publish** |
| Owner portal → Prompts | Greeting + prompts | `POST /api/admin/prompts` | Yes | Same as admin | **Auto-publish** (via same API) |
| Billing, audit, limits-only views | Various | Various | Mixed | N/A | Limits/billing paths unchanged (`trySync` where already present) |

---

## Runtime-facing vs non-runtime-facing (summary)

**Runtime-facing (auto-publish on save in this change):** business hours; prompts/greeting; forwarding profiles; pricing (when APIs succeed).

**Already runtime-facing elsewhere:** `POST /api/tts/config`, tenant limits / call-quality PATCHs (existing `trySyncTenantRuntimeConfigForLimits`).

**Non-runtime-facing:** audit logs, billing subscription views, Cloudflare token UI, etc. (no change).

---

## Backend contract

### Module: `control-plane/src/tenantRuntimePublish.ts`

- `syncTenantRuntimeConfigForLimits(tenantId)` — full `buildTenantRuntimeConfig` + `publishTenantConfig` (with `lastRuntimePublishedAt` stamp).
- `trySyncTenantRuntimeConfigForLimits(tenantId)` — same, boolean success (used by limits / call quality flows).
- `autoPublishTenantRuntimeAfterSave(tenantId, { settingArea, actorRole? })` — wraps sync, returns `{ published, lastRuntimePublishedAt, publishError?, publishSkippedReason? }`, and emits logs:
  - `tenant_settings_auto_publish_attempt`
  - `tenant_settings_auto_publish_success`
  - `tenant_settings_auto_publish_failed`
  - `tenant_settings_auto_publish_skipped` (when `ENABLE_RUNTIME_ADMIN` is false)

### Save handlers (admin)

After successful validation + persist, handlers log:

- `tenant_settings_save_attempt`
- `tenant_settings_save_success`

Then they merge publish metadata into JSON:

- `saved: true`
- `published: boolean`
- `lastRuntimePublishedAt: string | null` (from Redis after publish)
- `publishError` / `publishSkippedReason` when applicable

**Publish failure does not roll back** the Postgres/in-memory tenant mutation.

### Removed: `syncLLMContextToRuntime`

Replaced by full publish so **structured `llmContext.businessHours` is not stripped** when saving prompts or routing.

### `POST .../publish-from-tenant`

Implementation now delegates to `syncTenantRuntimeConfigForLimits` (single code path with TTS handler).

---

## UI changes

### Admin (`control-plane/public/admin.html`)

- `formatRuntimePublishSuffix(data)` appends voice-runtime outcome to status lines.
- After successful saves (hours, prompts, forwarding, pricing): `refreshOverviewRuntimeRedisHint()`.
- Overview: button **Advanced: Republish runtime config** — `POST publish-from-tenant` only (no longer clicks hidden voice publish).
- Models → Voice: publish button tooltip clarifies recovery use.

### Owner portal (`control-plane/public/portal.html`)

- Business hours + prompts saves show publish suffix; `loadPortalRuntimeSync()` after BH save.
- Voice “Publish” button labeled **Advanced: Full republish (Redis)**.

---

## Runtime cache / next call

Publishing **overwrites** `tenantcfg:<tenantId>` in Redis. The voice runtime loads tenant config per call from Redis; the next inbound call sees the new payload. No separate cache invalidation API was required.

---

## Tests

- **Integration:** `productionReadiness.integration.test.js` — “Business hours PATCH returns saved + published flags”.
- Existing suites: `npm test -w veralux-receptionist`, `npm run test:production-readiness`.

---

## Manual verification

1. With Redis + `ENABLE_RUNTIME_ADMIN=true`, select a tenant with valid STT/TTS (so publish can succeed).
2. **Business hours:** change Tuesday close time → Save → status should include “Voice runtime: live” and overview “Last voice runtime sync” updates.
3. **Prompts:** change greeting → Save → same.
4. Turn **off** `ENABLE_RUNTIME_ADMIN` → save should still return `saved: true`, `published: false`, `publishSkippedReason: runtime_admin_disabled`.
5. **Advanced:** Overview → Advanced republish → should succeed and refresh sync timestamp.

---

## Rollback

- Revert `control-plane/src/tenantRuntimePublish.ts` and server imports; restore `syncLLMContextToRuntime` + in-server `syncTenantRuntimeConfigForLimits` if needed.
- Revert admin/portal HTML strings and `formatRuntimePublishSuffix` helpers.

---

## Files touched (primary)

| File | Role |
|------|------|
| `control-plane/src/tenantRuntimePublish.ts` | **New** — shared full publish + auto-publish helper + logs |
| `control-plane/src/server.ts` | Wire saves, remove partial LLM sync, unify publish-from-tenant + TTS publish path |
| `control-plane/public/admin.html` | One-click status copy, overview advanced republish |
| `control-plane/public/portal.html` | Owner BH/prompts publish feedback |
| `control-plane/tests/productionReadiness.integration.test.js` | Contract test for BH response |

---

## Commands run (pass)

- `npm run build -w veralux-receptionist`
- `npm test -w veralux-receptionist`
- `npm run test:production-readiness`

(Voice runtime / shared unchanged for this feature set.)
