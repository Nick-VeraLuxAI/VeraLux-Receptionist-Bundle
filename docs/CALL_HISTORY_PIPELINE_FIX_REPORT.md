# Call history pipeline — persistence and UI fix

**Date:** 2026-05-09  
**Scope:** Control plane **Postgres `calls` table**, **`POST /api/runtime/calls`**, **`GET /api/admin/calls`**, **`GET /api/owner/calls`**, admin/portal fetch behavior, admin API rate limiting.

---

## 1. Root cause

1. **`upsertCalls` deleted all rows** for a tenant (`DELETE FROM calls WHERE tenant_id = $1`) then re-inserted **only** what was in the **in-memory** call store. On **`action: "end"`**, the handler removed the call from memory **before** persistence reflected a completed row, so **ended PSTN calls never remained in Postgres** — the owner portal (which reads **`listCallsForTenantDb`**) stayed empty.
2. **Runtime `reportCallEnd`** sends **`callId` = Telnyx `call_control_id`**, which is **not** a UUID. The **`end`** path previously required an in-memory hit by that id; when absent, the row was never written. The fix **upserts a new UUID row** and stores the Telnyx id under **`lead.voiceCallControlId`** (already used elsewhere for quality summary).
3. **`GET /api/admin/calls`** returned **in-memory** `tenant.calls.listCalls()` while the portal used **DB** — inconsistent and stale relative to operator expectations.
4. **Browser / intermediary caching** could surface **`304 Not Modified`** on repeated polls; responses lacked explicit **`Cache-Control: no-store`**.
5. **Global `/api/admin` rate limit** counted **every** admin GET; frequent **`/api/admin/calls`**, **`/analytics`**, **`/health`** polling could contribute to **`429`** under load.

---

## 2. Persistence (`POST /api/runtime/calls`)

| Step | Behavior |
|------|----------|
| **Handler** | `control-plane/src/server.ts` — `POST /api/runtime/calls` (unchanged auth: `adminGuard` + `ensureTenantAccess`). |
| **DB write** | **`upsertCallRowMerge`** in `control-plane/src/db.ts` — single-row **`INSERT … ON CONFLICT DO UPDATE`**. |
| **Table** | **`calls`** (`id` UUID PK, `tenant_id`, `caller_id`, `stage`, `lead` jsonb, `history` jsonb, timestamps). |
| **`action: "end"`** | **In-memory hit:** persist final **`stage: "end"`** + merged **`lead`** (includes **`voiceCallControlId`**) + history, then **`deleteCall`** so active memory matches reality. **No in-memory hit:** generate **`randomUUID()`**, upsert one completed row with **`voiceCallControlId`** = runtime **`callId`**. |
| **Logging** (no secrets, no full E.164) | Structured: **`call_history_store_attempt`**, **`call_history_store_success`**, **`call_history_store_failed`** with **`tenantId`** + truncated **`callControlId`** (max 120 chars). |

**`upsertCalls` (in-memory → DB mirror)** no longer deletes tenant history; it **merges** active snapshots only.

---

## 3. Read paths

| Endpoint | Change |
|----------|--------|
| **`GET /api/admin/calls`** | Reads **`listCallsForTenantDb`** (tenant-scoped via **`getTenantForAdmin`**). **`Cache-Control: no-store, private`**. History normalized for admin cards via **`normalizeHistoryForAdminUi`**. |
| **`GET /api/owner/calls`** / **`GET /api/owner/calls/:id`** | **`Cache-Control: no-store, private`**. Logic unchanged; now sees persisted rows. |
| **Superadmin diagnostic** | **`GET /api/admin/diagnostics/call-db-check?tenantId=`** — counts/latest id/timestamp only; **`requireSuperAdminCtx`** + **`ensureTenantAccess`**. |

---

## 4. Frontend / rate limit

| Area | Change |
|------|--------|
| **`portal.html` `apiFetch`** | Default **`cache: "no-store"`**; treat **`429`** as explicit error message for recent calls. |
| **`admin.html` `fetchJSON`** | Default **`cache: "no-store"`**; surface **`429`**. |
| **Polling intervals** | Slightly reduced frequency (`loadHealth` / `loadAnalytics` / `loadCalls` / `audit` / `auth/keys`). |
| **`/api/admin` rate limit** | **`adminApiRateLimitUnlessPollingGet`** — **GET** **`/api/admin/calls`**, **`/api/admin/analytics`**, **`/api/admin/health`** (+ health subpaths) **skip** the shared cap (still behind **`adminGuard`**). |

**Portal** already used **`/api/owner/calls`** and **`/api/owner/calls/:id`** — no wrong **`/api/admin/calls`** path.

---

## 5. Transcript summary parity

**`summarizeHistory`** (`callSanitizer.ts`) now reads **`content`** when **`message`** is absent so owner **`transcriptSummary`** works for runtime-shaped history.

---

## 6. Tests

| Test | Location |
|------|----------|
| **`normalizeHistoryForAdminUi`** | `control-plane/tests/callSanitizer.test.js` |
| **End-to-end persist + admin list + `Cache-Control`** | `control-plane/tests/productionReadiness.integration.test.js` — *"Call history: POST /api/runtime/calls end persists…"* |

---

## 7. Validation commands (executed)

- `npm run build -w control-plane` — **pass**
- `npm test -w control-plane` — **pass** (includes new cases)
- `npm test -w veralux-voice-runtime` — **pass**
- `npm run test:production-readiness` — **pass**

---

## 8. Manual follow-up (operator)

1. Place a **live PSTN** call.  
2. Confirm **`POST /api/runtime/calls`** → **200** and logs show **`call_history_store_success`**.  
3. **Refresh** owner portal **Recent calls** — row should appear; **Missed** filter unchanged for completed calls.  
4. Open **drawer** — detail loads via UUID **`id`**.  
5. Optional: **`GET /api/admin/diagnostics/call-db-check?tenantId=default`** (superadmin) — **`hasRows: true`**.

---

## 9. Tenant isolation

- **`ensureTenantAccess`** unchanged on **`POST /api/runtime/calls`**.  
- **`listCallsForTenantDb`** / **`getCallByIdForTenantDb`** unchanged — **SQL `WHERE tenant_id = $1`**.  
- Admin list still resolved with **`getTenantForAdmin`** (JWT tenant or explicit **`X-Tenant-ID`** for superadmin).

---

## 10. Out of scope (by design)

- **No** runtime STT/TTS/audio path changes.  
- **No** Sprint 0 auth model changes beyond read/cache/rate-limit ergonomics.
