# VeraLux — API brief for Emergent (dashboard + customer portal)

Hand this file to Emergent as the API contract. Build **two frontends** against the **existing** control-plane REST API. Do **not** invent new backend routes. There is no OpenAPI spec.

Live call handling, Telnyx webhooks, and media stay on the voice runtime. Do not call those from the dashboard or portal.

---

## Product to build

| App | Audience | Login | Tenant scope |
|-----|----------|-------|----------------|
| **Platform dashboard** | VeraLux staff (superadmin) | `POST /api/admin/login` | Send `X-Tenant-ID` to pick a tenant |
| **Customer portal** | Business owner (one tenant) | `POST /api/owner/login` | JWT is already scoped; still send `X-Tenant-ID` |

There is **no `/api/portal/*` namespace**. The existing portal reuses `/api/owner/*` plus many `/api/admin/*` routes with an owner JWT. Emergent should do the same.

Existing HTML shells (do not copy the UI; use as behavior reference only):

- `/admin` — platform console
- `/portal` — tenant owner portal
- `/owner` — legacy single-tenant UI (ignore; hardcoded `default` tenant)

---

## Base URL and transport

- **Base URL:** `{CONTROL_PLANE}` — make this a configurable env var (local default `http://localhost:4000`).
- **JSON:** `Content-Type: application/json` unless noted.
- **Errors:** `401` invalid/expired session, `403` tenant or feature forbidden, `400` `{ error, details? }`.
- After most config writes, response includes `saved`, `published`, `lastRuntimePublishedAt`. If `published` is false, show a “voice runtime not synced” warning.

---

## Auth (required on every authenticated request)

### Platform dashboard

```http
Authorization: Bearer <token from POST /api/admin/login>
X-Tenant-ID: <tenant-id>
```

Dev only: `X-Admin-Key: <ADMIN_API_KEY>` also works. Production is JWT-only (`ADMIN_AUTH_MODE=jwt-only`).

### Customer portal

```http
Authorization: Bearer <token from POST /api/owner/login>
X-Tenant-ID: <tenant.id from login response>
```

Store `token` + `tenant.id` after login (e.g. `localStorage` keys `portal_token`, `portal_tenant_id`). Owner JWT lasts 24 hours.

### Multi-membership OIDC users (staff, optional)

If the token is a Cognito/OIDC JWT and the user belongs to more than one tenant, also send:

```http
X-Active-Tenant: <tenant-id>
```

### Roles

| Role | Capabilities |
|------|----------------|
| `superadmin` | All tenants; Telnyx carrier; raw diagnostics; infra URLs |
| `tenant-admin` | Own tenant(s); writes allowed |
| `tenant-viewer` | Read-only on `/api/admin/*` |
| Owner JWT | Own tenant; portal + most admin config routes |

### Feature gates

Plan limits return **403** when a feature is off. Hide the screen and show an upgrade CTA.

| Feature flag | Screens it unlocks |
|--------------|--------------------|
| `advancedAnalytics` | Analytics dashboard |
| `multiLocation` | Forwarding profiles |
| `crmIntegration` | Pricing / services |
| `customWorkflows` | Workflows CRUD |

---

## 1. Login and session

| Method | Path | Who | Body | Response |
|--------|------|-----|------|----------|
| `POST` | `/api/admin/login` | Public | `{ email, password }` | `{ success, token }` |
| `POST` | `/api/owner/login` | Public | `{ email, password }` **or** `{ phone, passcode }` | `{ success, token, tenant: { id, name, numbers } }` |
| `GET` | `/api/branding` | Public | — | White-label colors/name from env |
| `GET` | `/health` | Public | — | `{ status, timestamp }` |
| `GET` | `/ready` | Public | — | `{ status, checks }` |
| `GET` | `/api/admin/health` | Both | — | LLM/STT/TTS status, active calls. Portal uses this as “session still valid”. |
| `POST` | `/api/owner/change-password` | Owner | `{ currentPassword, newPassword }` | `{ success }` |
| `POST` | `/api/owner/change-passcode` | Owner | `{ currentPasscode, newPasscode }` | `{ success }` |

Password minimum length is **8**. There is **no forgot-password or MFA** endpoint.

Owner login example:

```http
POST /api/owner/login
Content-Type: application/json

{ "email": "owner@example.com", "password": "********" }
```

```json
{
  "success": true,
  "token": "<jwt>",
  "tenant": {
    "id": "acme-salon",
    "name": "Acme Salon",
    "numbers": ["+15551234567"]
  }
}
```

---

## 2. Platform dashboard — tenants, plans, carrier

### Tenants

| Method | Path | Body / query | Notes |
|--------|------|--------------|-------|
| `GET` | `/api/admin/tenants` | — | `{ tenants: [{ id, name, numbers, businessNumber, createdAt, updatedAt }] }` |
| `POST` | `/api/admin/tenants` | `{ id, name?, numbers?, businessNumber? }` | Create **or** update (upsert). `id` is slug `[a-zA-Z0-9_-]`, max 64 |
| `GET` | `/api/admin/tenants/:tenantId/owner-portal-status` | — | `{ passcodeSet, emailLoginSet }` |
| `POST` | `/api/owner/set-portal-credentials` | `{ tenantId, email, password }` | Admin sets owner email login |
| `POST` | `/api/owner/set-passcode` | `{ tenantId, passcode }` | Admin sets phone/passcode login (passcode ≥ 4 chars) |
| `POST` | `/api/admin/tenants/:tenantId/owner-portal-password/change` | `{ currentPassword, newPassword }` | Admin-assisted reset |
| `POST` | `/api/admin/tenants/:tenantId/owner-passcode/change` | `{ currentPasscode, newPasscode }` | Admin-assisted reset |

There is **no** `GET /api/admin/tenants/:id`. Load one tenant from the list.

`POST /api/admin/tenants` example:

```json
{
  "id": "acme-salon",
  "name": "Acme Salon",
  "numbers": ["+15551234567"],
  "businessNumber": "+15557654321"
}
```

`numbers` may also be a comma/space/newline-separated string. Creating more numbers than `maxPhoneNumbers` returns `400 max_phone_numbers_exceeded`. Portal email must be unique across tenants (`409 email_already_registered`).

### Plan, usage, billing status

| Method | Path | Body / query |
|--------|------|--------------|
| `GET` | `/api/admin/tenants/:tenantId/limits` | — → `{ tenantId, limits }` |
| `PATCH` | `/api/admin/tenants/:tenantId/limits` | Partial limits object → `{ tenantId, limits, runtimeSyncOk }` |
| `POST` | `/api/admin/tenants/:tenantId/limits/reset-to-plan-defaults` | `{ planTier? }` |
| `POST` | `/api/admin/tenants/:tenantId/billing-status` | `{ billingStatus }` |
| `GET` | `/api/admin/tenants/:tenantId/usage` | — |
| `GET` | `/api/admin/tenants/:tenantId/billing-summary` | `?month=YYYY-MM` |

**Enums**

- `planTier`: `starter` \| `professional` \| `premium` \| `enterprise`
- `billingStatus`: `trial` \| `active` \| `past_due` \| `suspended` \| `canceled`
- `overageMode`: `allow_and_bill` \| `throttle` \| `hard_stop`

**Limits fields**

```
planName, planTier, billingStatus, overageMode, monthlyMinuteOverageRateCents,
effectiveFrom, effectiveUntil,
maxConcurrentCalls, includedMonthlyMinutes, maxMonthlyMinutesHardCap,
maxDailyCalls, maxMonthlyCalls, maxKnowledgeBaseSizeMb, maxIntegrations,
maxLocations, maxPhoneNumbers, maxAdminUsers, maxEscalationContacts,
afterHoursMode, smsFollowup, calendarIntegration, crmIntegration,
advancedAnalytics, callRecording, transcriptRetention, multiLocation,
customWorkflows, prioritySupport
```

Do **not** set `transcriptRetention: false` — the API rejects it.

Usage response includes `usage`, `overageMinutes`, `hardCapRemainingMinutes`, `includedMinutesRemaining`.

### Phone numbers (superadmin only)

These touch the shared Telnyx account. Tenant-admin / owner JWT gets `403 carrier_admin_required`.

| Method | Path | Body / query |
|--------|------|--------------|
| `GET` | `/api/admin/telnyx/status` | — |
| `GET` | `/api/admin/telnyx/numbers` | — |
| `GET` | `/api/admin/telnyx/available` | `?country=&state=&city=&contains=&limit=` |
| `POST` | `/api/admin/telnyx/provision` | `{ phone_number }` |
| `POST` | `/api/admin/telnyx/purchase` | `{ phone_number }` |
| `GET` | `/api/admin/telnyx/connections` | — |
| `POST` | `/api/admin/runtime/dids/map` | `{ didE164, tenantId }` |
| `POST` | `/api/admin/runtime/dids/unmap` | `{ didE164 }` |
| `GET` | `/api/admin/runtime/dids/:didE164` | — |

After purchase/provision, also `POST /api/admin/tenants` with the new number on `numbers[]`, then map the DID.

### Platform ops

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/admin/audit` | `?limit=` max 200. Superadmin |
| `GET` | `/api/admin/auth/keys` | List API keys (no secrets) |
| `POST` | `/api/admin/auth/keys` | `{ name, role? }` — plaintext token shown **once** |
| `DELETE` | `/api/admin/auth/keys/:id` | Revoke |
| `GET` | `/api/admin/diagnostics/call-db-check` | Superadmin, `?tenantId=` |
| `GET` | `/api/admin/runtime/health` | Redis health |
| `GET` | `/api/admin/telephony/secret` | `{ hasSecret }` |
| `POST` | `/api/admin/telephony/secret` | `{ secret }` |
| `GET` | `/api/admin/cloudflare/token` | `{ hasToken }` only — POST is disabled (`410`) |

---

## 3. Shared tenant config (dashboard and portal)

Owner JWT + `X-Tenant-ID` works on these unless noted.

### Receptionist personality (prompts)

| Method | Path | Body |
|--------|------|------|
| `GET` | `/api/admin/prompts` | — |
| `POST` | `/api/admin/prompts` | `{ greetingText?, systemPreamble?, policyPrompt?, voicePrompt?, schemaHint? }` |

### LLM routing

| Method | Path | Body |
|--------|------|------|
| `GET` | `/api/admin/config` | Safe config + `hasOpenAIApiKey` (key never returned) |
| `POST` | `/api/admin/config` | `{ provider: "openai"\|"local", localUrl?, openaiModel?, openaiApiKey? }` |
| `GET` | `/api/owner/llm-config` | Owner-safe summary (no secrets) |
| `POST` | `/api/owner/llm-config` | `{ mode, tenantProvider?, tenantModel?, apiKey?, ... }` |
| `POST` | `/api/owner/llm-config/api-key` | Set/remove key |
| `POST` | `/api/owner/llm-config/test` | `{ apiKey, model? }` → `{ ok, status }` |
| `GET` | `/api/admin/tenants/:tenantId/llm-config` | Admin view |
| `POST` | `/api/admin/tenants/:tenantId/llm-config` | Admin write |
| `POST` | `/api/admin/tenants/:tenantId/llm-config/test` | `{ apiKey, model? }` |

Never display a returned API key. Only show `hasOpenAIApiKey` / “key set”.

### Voice (TTS)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/tts/config` | Tenant URLs are redacted |
| `POST` | `/api/tts/config` | Large TTS object (below) |
| `POST` | `/api/tts/preview` | `{ text? }` → `audio/wav` |
| `POST` | `/api/tts/preview/async` | `{ text? }` → `202 { id }` |
| `GET` | `/api/tts/preview/async/:id` | `{ status: pending\|ready\|failed, ... }` |
| `POST` | `/api/admin/voice-recordings` | `multipart/form-data` field `audio` (WAV) → `{ url, filename, size }` |

**TTS enums**

- `ttsMode`: `kokoro_http` \| `coqui_xtts` \| `chatterbox_http` \| `qwen3_tts_http` \| `miso_tts_http`
- `preset`: `neutral` \| `warm` \| `energetic` \| `calm`
- `defaultVoiceMode`: `preset` \| `cloned`

Also accepted: `voiceId`, `language`, `rate` (0.5–2), `clonedVoice: { speakerWavUrl, label? }`, plus provider-specific sliders (`coqui*`, `qwen3*`, `miso*`, `chatterboxVariant`). Provider URL fields (`kokoroUrl`, `coquiXttsUrl`, etc.) are **superadmin-only** on write — do not expose URL inputs in the customer portal.

Prefer async preview in the UI (poll until `ready`, then play audio).

### Hours, forwarding, pricing

| Method | Path | Gate | Body |
|--------|------|------|------|
| `GET` / `PATCH` | `/api/owner/business-hours` | — | Hours object (portal) |
| `GET` / `PATCH` | `/api/admin/tenants/:tenantId/business-hours` | — | Same (admin) |
| `GET` / `POST` | `/api/admin/forwarding-profiles` | `multiLocation` | `{ profiles: [{ id, name, number?, role? }] }` |
| `GET` / `POST` | `/api/admin/pricing` | `crmIntegration` | `{ items: [{ name, price, description? }], notes? }` |

GET hours returns `{ businessHours, openNow, summary }`. PATCH body:

```json
{
  "timezone": "America/Los_Angeles",
  "weekly": {
    "mon": { "open": "09:00", "close": "17:00" },
    "tue": { "open": "09:00", "close": "17:00" },
    "wed": { "open": "09:00", "close": "17:00" },
    "thu": { "open": "09:00", "close": "17:00" },
    "fri": { "open": "09:00", "close": "17:00" },
    "sat": { "closed": true },
    "sun": { "closed": true }
  },
  "afterHoursMessage": "We're closed. Leave a message."
}
```

Day keys: `mon` `tue` `wed` `thu` `fri` `sat` `sun`. Each day is either `{ open, close }` (`HH:MM`) or `{ closed: true }`.

Forwarding `number` must be E.164 (`+15551234567`). POST forwarding/pricing **replaces** the full list.

### Quick replies and publish to voice runtime

Config saves often auto-publish. Still call publish after a batch of edits, and always after writing quick replies.

| Method | Path | Body |
|--------|------|------|
| `GET` | `/api/admin/runtime/tenants/:tenantId/quick-replies` | — → `{ quickReplies, runtimeConfigMissing? }` |
| `PUT` | `/api/admin/runtime/tenants/:tenantId/quick-replies` | `{ quickReplies: [...] }` — `404` if never published |
| `POST` | `/api/admin/quick-replies/suggest` | `{ greeting?, systemPreamble?, pricingItems?, notes?, forwardingLines?, maxIntents? }` — does **not** save |
| `POST` | `/api/admin/runtime/tenants/:tenantId/publish-from-tenant` | Rebuild + publish Redis config |
| `GET` | `/api/owner/voice-runtime-sync` | `{ lastRuntimePublishedAt }` |
| `GET` | `/api/admin/runtime/tenants/:tenantId/config` | Full Redis config (staff / advanced) |
| `POST` | `/api/admin/runtime/tenants/:tenantId/config` | Raw publish (staff only, not portal) |

Quick reply item used by the current UI:

```json
{ "id": "hours", "match": ["hours", "open"], "reply": "We're open 9 to 5 weekdays." }
```

If GET quick-replies returns `runtimeConfigMissing: true`, call `publish-from-tenant` first, then PUT.

---

## 4. Calls, analytics, leads, workflows

| Method | Path | Who | Notes |
|--------|------|-----|-------|
| `GET` | `/api/owner/calls` | Owner | `?limit=50&filter=all\|missed`. Caller IDs **masked**. `Cache-Control: no-store` |
| `GET` | `/api/owner/calls/:callId` | Owner | Summary only, optional `callQuality` |
| `GET` | `/api/owner/call-quality-summary/:callControlId` | Owner | `{ visible, summary? }` |
| `GET` | `/api/admin/calls` | Admin | Full history + lead + transcript |
| `GET` | `/api/admin/analytics` | Both | Gated by `advancedAnalytics` |
| `GET` | `/api/admin/leads` | Both | `?limit=100` |
| `DELETE` | `/api/admin/leads/:id` | Both | Tenant-scoped |
| `GET` | `/api/admin/workflows` | Both | Gated by `customWorkflows` |
| `POST` | `/api/admin/workflows` | Both | `{ name, triggerType, triggerConfig?, steps?, adminLocked? }` → `201` |
| `PUT` | `/api/admin/workflows/:id` | Both | `{ name?, enabled?, triggerType?, triggerConfig?, steps?, adminLocked? }` |
| `DELETE` | `/api/admin/workflows/:id` | Both | `{ success }` |
| `POST` | `/api/admin/workflows/:id/test` | Both | Dry-run; optional `{ callerId, durationMs, turns, transcript, lead }` |
| `GET` | `/api/admin/workflow-runs` | Both | `?limit=` |
| `GET` / `PATCH` | `/api/admin/workflows/settings` | Both | `{ ownerCanEdit }` |

**Owner call list item**

```json
{
  "id": "...",
  "callerDisplay": "+1•••5678",
  "stage": "unknown",
  "createdAt": "...",
  "updatedAt": "...",
  "transcriptSummary": "...",
  "missed": false
}
```

Owner call detail may add `transcriptsDisabled` and `callQuality`. **Never** use `/api/admin/calls` in the customer portal — that exposes full transcripts and raw caller IDs.

### Call quality and onboarding

| Method | Path | Who |
|--------|------|-----|
| `GET` / `PATCH` | `/api/admin/tenants/:tenantId/call-quality-settings` | Admin |
| `POST` | `/api/admin/tenants/:tenantId/raw-audio-diagnostics/enable-next-call` | Superadmin `{ reason, expiresAt, mode? }` |
| `POST` | `/api/admin/tenants/:tenantId/raw-audio-diagnostics/disable` | Superadmin `{ reason }` |
| `GET` | `/api/owner/operator-state` | Owner onboarding flags |
| `POST` | `/api/owner/operator-test-call/complete` | Owner marks test call done |
| `GET` | `/api/admin/tenants/:tenantId/operator-state` | Admin |
| `POST` | `/api/admin/tenants/:tenantId/operator-test-call/complete` | Admin |

---

## 5. Billing (Stripe)

Tenant-scoped via `X-Tenant-ID`. Live Receptionist catalog only — do not create Stripe Products/Prices. Owners never pick prices. In the portal, only show Customer Portal if `showBillingPortal` is true. See `docs/STRIPE_BILLING.md`.

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET` | `/api/admin/subscription` | — | `{ configured, billingState, planName, entitlements, … }` |
| `POST` | `/api/admin/subscription` | Full subscription fields | Local record only (staff) |
| `PATCH` | `/api/admin/subscription` | `{ showBillingPortal?, adminNotes? }` | Staff. Audits portal toggle |
| `DELETE` | `/api/admin/subscription` | — | Local record only (staff) |
| `GET` | `/api/admin/stripe/status` | — | `{ configured, liveMode, webhookPath }` |
| `GET` | `/api/admin/stripe/plans` | — | Live catalog (staff). Owners get empty `plans` |
| `POST` | `/api/admin/stripe/subscribe` | `{ priceId, includeSetup?, confirm }` | Staff. Live keys require `confirm: true` |
| `POST` | `/api/admin/stripe/cancel` | `{ confirm, atPeriodEnd? }` | Staff |
| `POST` | `/api/admin/stripe/checkout` | `{ priceId, successUrl?, cancelUrl?, includeSetup? }` | Staff, catalog prices only |
| `POST` | `/api/admin/stripe/portal` | `{ returnUrl? }` | Owner only if self-serve. Return `/portal/billing` |
| `POST` | `/api/admin/stripe/sync` | — | Staff. Pull customer + subscription |

Do **not** call `POST /api/stripe/webhook` from the UI. Stripe hits that.

---

## Suggested screens → APIs

### Platform dashboard

1. **Login** → `POST /api/admin/login`
2. **Tenant list** → `GET /api/admin/tenants`
3. **Create tenant** → `POST /api/admin/tenants` then `POST /api/owner/set-portal-credentials`
4. **Tenant overview** → `GET /api/admin/health`, `GET .../usage`, `GET .../limits`, `GET /api/admin/subscription`
5. **Numbers** → Telnyx routes + `POST /api/admin/tenants` + DID map
6. **Receptionist setup** → prompts, TTS, forwarding, pricing, quick replies, `publish-from-tenant`
7. **Calls / analytics** → `/api/admin/calls`, `/api/admin/analytics`
8. **Leads / workflows** → `/api/admin/leads`, `/api/admin/workflows*`
9. **Billing** → subscription + Stripe plans / checkout / sync
10. **Audit / API keys** → `/api/admin/audit`, `/api/admin/auth/keys`

### Customer portal

1. **Login** → `POST /api/owner/login`
2. **Overview** → `/api/admin/health`, `/api/admin/analytics` (may 403), `/api/admin/leads`, `/api/owner/voice-runtime-sync`, `/api/owner/operator-state`
3. **Calls** → `/api/owner/calls`, `/api/owner/calls/:id`
4. **Hours** → `GET` / `PATCH /api/owner/business-hours`
5. **Greeting and tone** → `/api/admin/prompts`
6. **Voice** → `/api/tts/config`, preview, `/api/admin/voice-recordings`
7. **Transfer lines** → `/api/admin/forwarding-profiles` (403 if no `multiLocation`)
8. **Services / prices** → `/api/admin/pricing` (403 if no `crmIntegration`)
9. **Quick replies** → GET / PUT `.../quick-replies`, suggest, then `publish-from-tenant`
10. **Billing** → subscription status + Stripe Customer Portal (if allowed). Owners cannot pick prices.
11. **Account** → `POST /api/owner/change-password`

---

## Do not call from either UI

Internal or not a UI surface:

- `POST /api/runtime/analytics`
- `POST /api/runtime/calls`
- `POST /api/runtime/call-quality-summary`
- `POST /api/runtime/tenants/:id/diagnostics/consume-next-call-arm`
- `GET /api/runtime/tenants/:id/secrets/*`
- `POST /api/stripe/webhook`
- Voice runtime (port `4001`): `/v1/telnyx/webhook`, `/v1/webrtc/offer`, live `/v1/calls/:id/voice`
- All `410 voice_runtime_moved` stubs: `/api/calls/*`, `/api/telnyx/call-control`, `/api/telnyx/audio/*`, `/api/dev/*`
- `POST /admin-auth` (installer script, not dashboard)
- `GET /oauth/login` and `/oauth/callback` unless you are implementing Cognito (optional; not required)

---

## Gaps (APIs that do not exist — mock or skip)

Do not invent client-only “fake backends” that pretend these exist as VeraLux APIs. Skip the feature or stub locally with a clear “not in API yet” note.

- `GET /api/me` / session introspection / membership list
- User invite, team members, or per-tenant role assignment
- Forgot password / MFA
- Knowledge-base document CRUD
- Dedicated transfer-profile or call-forwarding REST beyond forwarding profiles
- WebSocket / SSE live-call stream
- CSV / PDF export
- Tenant-owned programmatic API keys
- Outbound webhooks for “call ended” / “lead created”
- End-caller self-service portal (current portal is the **business owner**, not the person who called)
- Cursor pagination (lists use `?limit=` only, typically 50–100)

---

## Data models (minimum)

### Tenant

```
{ id, name, numbers: string[], businessNumber?, createdAt, updatedAt }
```

### Subscription (when configured)

Includes `planName`, `priceCents`, `status`, Stripe IDs, `showBillingPortal`, `adminNotes`, period dates.

### Operator state

JSON blob. Important flag: `testCall.completedAt` — use for an onboarding checklist.

---

## System prompt (paste into Emergent)

> Build two React apps against an existing VeraLux control-plane REST API. Do not invent new backend routes. Base URL is configurable (`VITE_CONTROL_PLANE_URL` or equivalent).
>
> **Admin dashboard:** login via `POST /api/admin/login`, send `Authorization: Bearer` and `X-Tenant-ID` on every request. Superadmin can list/create tenants, set owner portal credentials, manage Telnyx numbers, plan limits, usage, Stripe plans, audit logs, and per-tenant receptionist config.
>
> **Customer portal:** login via `POST /api/owner/login` (`{ email, password }`), store token + tenant id. Owner JWT can call `/api/owner/*` and most `/api/admin/*` routes scoped to that tenant. Use `/api/owner/calls` (masked) not `/api/admin/calls`. Hide screens that 403 on feature gates (`advancedAnalytics`, `multiLocation`, `crmIntegration`, `customWorkflows`). After config saves, call `POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant`.
>
> Never call `/api/runtime/*`, Stripe webhook, or Telnyx voice webhooks. Never display raw API keys or TTS provider URLs in the customer portal. There is no OpenAPI file; use only `EMERGENT_API_BRIEF.md`.

---

## Source of truth

This brief is a snapshot of `control-plane/src/server.ts` and related handlers. If an endpoint and this file disagree, the TypeScript server wins. Related docs:

- `control-plane/docs/api.md` — shorter admin/runtime overview
- `PLAN_LIMITS.md` / `BILLING_USAGE_MODEL.md` — plan semantics
- `docs/PANEL_CONTROL_SURFACE_AUDIT.md` — current HTML UI → API mapping
