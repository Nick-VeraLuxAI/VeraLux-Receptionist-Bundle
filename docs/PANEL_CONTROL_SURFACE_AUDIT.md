# Panel Control-Surface Audit

**Audit type:** Read-only mapping pass over the full VeraLux Receptionist control surface (admin, owner, client portal, backend APIs, runtime config). **No code or UI changes are made by this document.**

**Stack version under audit:** the working tree at `/home/ndesantis/Documents/GitHub/VeraLux-Receptionist-Bundle` (post echo-regression fix; voice runtime confirmed end-to-end Telnyx → decode → Whisper → LLM → TTS → playback with no assistant echo into the LLM).

**Sources audited:**
- `control-plane/public/admin.html` — super-admin / ops console
- `control-plane/public/owner.html` — operator/owner console (access-token gate)
- `control-plane/public/portal.html` — client business portal (email/password login)
- `control-plane/public/dev-console.html` — local dev audio harness
- `control-plane/src/server.ts` (~3000 routes) and supporting modules (`auth.ts`, `ownerAuth.ts`, `middleware.ts`, `planLimits.ts`, `tenants.ts`, `telnyx.ts`, `receptionist.ts`, `config.ts`, `db.ts`, `stripe.ts`, `featureEntitlements.ts`, `runtime/runtimePublisher.ts`, etc.)
- `control-plane/migrations/0001_initial.sql` … `0012_tenant_limits_usage.sql`
- `veralux-voice-runtime/src/env.ts`, `src/server.ts`, `src/controlPlane.ts`, `src/calls/*`, `src/stt/*`, `src/tts/*`, `src/limits/*`, `src/tenants/*`, `src/observability/*`
- `shared/src/runtimeContract.ts`
- Companion docs: `CONFIG_MATRIX.md`, `CUSTOMER_CONFIG_SURFACE.md`, `PILOT_READINESS_SCORE.md`, `PLAN_LIMITS.md`, `BILLING_USAGE_MODEL.md`, `HEALTH_MODEL.md`, `SECURITY_POSTURE.md`, `LAUNCH_BLOCKERS.md`

---

## 1. Executive Summary

The platform has a **functionally complete super-admin console** (`admin.html`), a **mature backend API** with most plan/limits/billing/runtime-sync wiring in place, and a **working voice runtime** that pulls per-tenant config from Redis on each call. The owner-facing surface, however, is **fragmented across three overlapping HTML files** (`admin.html`, `owner.html`, `portal.html`), each with its own auth model, and the **client portal is missing the operating concepts a paying SMB will look for first** (call/transcript history, missed-call inbox, business hours, FAQ knowledge base, "test the agent" affordance, usage quota meter, agent-health pill).

There are also **multiple authorization gaps** that block self-serve / multi-tenant pilot deployment: `GET /api/admin/tenants` is unscoped, `POST /api/runtime/calls|analytics` accepts a body-supplied `tenantId`, `DELETE /api/admin/leads/:id` has no tenant filter, and the Cloudflare-token routes mutate global `process.env` under viewer auth.

**Bottom line for "first paid pilot":** the panels are usable for a **white-glove pilot the vendor sets up and operates**, but they are **not yet good enough for a client to self-serve confidently**. With ~10 focused changes (listed in §9 and the checklist) the surface becomes pilot-ready for one or two design-partner SMBs.

**Headline scores (full rubric in §10):**

| Dimension | Score |
|---|---:|
| Admin control completeness | **75 / 100** |
| Owner/client usability | **48 / 100** |
| Runtime/UI cohesion | **55 / 100** |
| Tenant safety / isolation | **60 / 100** |
| First-client onboarding readiness | **40 / 100** |
| **Overall panel readiness** | **55 / 100** |

---

## 2. Admin Panel Inventory (`/admin` → `admin.html`)

**Auth model:** modal `#admin-modal` collects an `X-Admin-Key` (DB admin key, env master key, or JWT) which is validated against `GET /api/admin/tenants`. All admin requests carry `X-Tenant-ID` + `X-Active-Tenant` (current tenant in the top strip) and the admin token via `Authorization: Bearer` or `X-Admin-Key`.

**Navigation:** flat `data-tab` switching (no hash routing). Tabs in order: `overview`, `models`, `forwarding`, `analytics`, `calls`, `audit`, `billing`, `workflows`, `settings`, plus a **`Sync stack`** refresh button.

| Tab | DOM anchor | Visible controls | Editable fields | API endpoints | Backend table | Runtime sync? | Validation | Audit |
|---|---|---|---|---|---|---|---|---|
| **Tenant strip** (global) | `#tenant-bar`, `#tenant-select`, `#tenant-new-id`, `#tenant-new-numbers`, `#tenant-create`, `#tenant-numbers-list`, `#tenant-clear-numbers`, `#owner-portal-handoff` | Tenant select, create, save, per-DID remove, clear all numbers; owner-portal URL handoff; set owner email/password | tenant id/name, DID list, owner email, owner portal password | `GET/POST /api/admin/tenants`; `GET /api/admin/tenants/:t/owner-portal-status`; `POST /api/owner/set-portal-credentials` | `tenants`, `tenant_numbers`, `owner_portal_credentials` | DID changes propagate via `setTenantNumbers`; password change has no runtime effect | client: email contains `@`, password ≥ 8, password match | `adminGuard` finish-handler |
| **Overview** | `data-tab="overview"` | Health pill, summary tiles, activity timeline, disabled "Take over / Pause AI" buttons, `#operator-force-health`, debug-JSON dump | none editable beyond debug pill | `GET /api/admin/health`, `GET /api/admin/analytics`, `GET /api/admin/config` | computed | no | none | yes |
| **Models & Prompts** | `data-tab="models"` (4-step wizard) | Step 1: provider, OpenAI model, OpenAI API key, local-LLM URL; Step 2: greeting, system preamble, policy, voice prompt, schema; Step 3: full TTS provider matrix (`coqui_xtts`, `chatterbox_http`, `kokoro_http`, `qwen3_tts_http`) with URL, voice, language, sliders, cloning + record/upload; Step 4: simulator + TTS preview + voice hot-swap on a live call | LLM provider/model/key/URL; greeting/system/voice/policy/schema; full TTS config; cloned-voice WAV upload | `GET/POST /api/admin/config`, `GET/POST /api/admin/prompts`, `GET/POST /api/tts/config`, `POST /api/admin/voice-recordings` (multipart), `POST /api/admin/runtime/tenants/:t/publish-from-tenant`, `POST /api/tts/preview/async`, `GET /api/tts/preview/async/:id`, `GET/POST /v1/calls/:cc/voice` | `tenant_configs.config`, `tenant_configs.prompts`, `tenant_configs.tts`, `tenant_secrets` (OpenAI key) | **yes** (`syncLLMContextToRuntime` on prompts; `buildTenantRuntimeConfig` + `publishTenantConfig` on TTS save when `ENABLE_RUNTIME_ADMIN`) | OpenAI key regex; cloned-voice path; modal token gate | yes |
| **Quick replies** (under Models) | `#admin-quick-replies-section` | Add/remove intent cards (id, match lines, reply) | quickReplies array | `GET /api/admin/runtime/tenants/:t/quick-replies`; `PUT` same path | Redis `tenantcfg:<t>` (merged) | **yes** | server-side schema | yes |
| **Forwarding & Products** | `data-tab="forwarding"` | Forwarding profiles list (name, E.164, role); pricing items + notes | profiles, pricing items, pricing notes | `GET/POST /api/admin/forwarding-profiles`; `GET/POST /api/admin/pricing` | `tenant_configs.forwarding_profiles`, `tenant_configs.pricing` | **yes** (LLM context sync) | client: name required | yes; gated by `multiLocation` / `crmIntegration` features |
| **Analytics** | `data-tab="analytics"` | Summary card, top questions | none | `GET /api/admin/analytics` | in-memory + `analytics` table | no | none | yes; gated by `advancedAnalytics` |
| **Calls** | `data-tab="calls"` | Call card list (caller, lead, transcript snippet) | none | `GET /api/admin/calls` | in-memory `tenant.calls` (also `calls` table) | no | none | yes |
| **Audit Logs** | `data-tab="audit"` | Audit log textarea | none | `GET /api/admin/audit` | `admin_audit_logs` | no | query num | yes (admin role) |
| **Admin Access** (also `data-tab="audit"`) | `#admin-keys` | Create key (name + role: `admin` \| `viewer`); list keys; show plaintext token once | name, role | `GET/POST /api/admin/auth/keys`; `DELETE /api/admin/auth/keys/:id` | `admin_api_keys` | no | client: name required | yes (admin role) |
| **Billing** | `data-tab="billing"` (4-step wizard) | Stripe banner + create-plan flow; manual subscription form (plan, status, price, currency, frequency, dates, card last4, notes); show-portal toggle | full subscription/manual fields, plan list, show-portal toggle | `GET/POST/PATCH/DELETE /api/admin/subscription`; `GET /api/admin/stripe/status`; `GET/POST /api/admin/stripe/plans`; `DELETE /api/admin/stripe/plans/:id`; `POST /api/admin/stripe/checkout`; `POST /api/admin/stripe/portal`; `POST /api/admin/stripe/sync` | `tenant_subscriptions`, `stripe_plans` | no (writes propagate via Stripe webhook) | client `confirm()` on remove subscription, delete plan, dangerous billing-status | yes |
| **Workflows** | `data-tab="workflows"` | Owner-can-edit toggle; workflow CRUD; trigger config (after-hours, missed-call, fire_webhook, send SMS/email); runs table; leads table | full workflow definition, owner-edit flag | `GET/PATCH /api/admin/workflows/settings`; `GET/POST/PUT/DELETE /api/admin/workflows`; `POST /api/admin/workflows/:id/test`; `GET /api/admin/workflow-runs`; `GET /api/admin/leads`; `DELETE /api/admin/leads/:id` | `workflows`, `workflow_runs`, `leads`, `tenant_configs.workflow_settings` | no | client: workflow name + ≥1 step; `confirm()` on delete workflow / delete lead | yes; gated by `customWorkflows` |
| **Settings** | `data-tab="settings"` | Cloudflare tunnel token field; per-tenant **plan & limits** form (planTier, billingStatus, overageMode, all numeric caps, feature checkboxes); usage panel, reset-to-plan-defaults, set billing status | tunnel token; full plan/limits payload | `GET/POST /api/admin/cloudflare/token`; `GET/PATCH /api/admin/tenants/:t/limits`; `GET /api/admin/tenants/:t/usage`; `POST /api/admin/tenants/:t/limits/reset-to-plan-defaults`; `POST /api/admin/tenants/:t/billing-status` | `tenant_limits`, `tenant_usage_*` (read), `process.env` (Cloudflare) | **yes** (`trySyncTenantRuntimeConfigForLimits`) | Zod (`tenantLimitsPatchSchema`); `confirm()` for lowering concurrency below usage and for suspended/canceled status; **bug:** `requireAuth(saveCloudflareToken)` is undefined in admin.html and will throw `ReferenceError` | yes (admin role + explicit `recordAudit`) |

**Sensitive items present:** OpenAI API key field (server-stored), Cloudflare tunnel token field, Stripe secret references (env), Telnyx webhook secret (env, not in admin UI), full plan-limits matrix, ability to set billing status to `suspended`/`canceled`, ability to delete admin keys / Stripe plans / leads / subscriptions.

**Sensitive items not present:** Telnyx API key UI; webhook-secret editor; STT URL editor; raw forensic artifact browser; live-call list with operator takeover that actually works (buttons are disabled placeholders); incident timeline UI; tenant-suspension-with-reason workflow; webhook-error log viewer.

---

## 3. Owner / Operator Panel Inventory (`/owner` → `owner.html`)

**Auth model:** modal asks for an "access token" (validated identically to admin). **Tenant id is hardcoded** to `"default"` in the file (`OWNER_TENANT_ID`), so this UI is **not multi-tenant aware**.

**Navigation:** single vertical page (no tabs, no hash). Sections rendered as stacked cards.

| Section | Anchor | Controls | API endpoints | View / edit | Notes |
|---|---|---|---|---|---|
| Header | `#owner-status-pill` | Status pill | `GET /ready` (every 30 s) | view | Control-plane readiness, not Telnyx/voice readiness |
| Sign-in modal | `#owner-modal` | Token input | `GET /api/admin/tenants` (validate) | edit | Stores token in JS memory; admin-key or JWT |
| Your business line | `#owner-numbers`, `#owner-save-numbers`, `#telnyx-country`, `#telnyx-area`, `#telnyx-get-number`, `#telnyx-available-list`, `#telnyx-purchase-status`, `#provisioned-number`, `#forwarding-instructions` | Number input; country/area code search; "Get this number"; provisioning workflow | `GET /api/admin/telnyx/status`, `GET /api/admin/telnyx/numbers`, `GET /api/admin/telnyx/available`, `POST /api/admin/telnyx/provision`, `POST /api/admin/telnyx/purchase`, `POST /api/admin/tenants` | edit | Implicit Telnyx onboarding flow; **provision/purchase use raw `fetch` with only `X-Admin-Key`** — JWT users may fail |
| Client portal password | `#owner-portal-pass-*` | Current/new/confirm | `POST /api/admin/tenants/default/owner-portal-password/change` | edit | Tenant id hardcoded; sets the password used at `portal.html` |
| When to transfer calls | forwarding profile editor | name, E.164, role; add/save | `GET/POST /api/admin/forwarding-profiles` | edit | |
| Services & products | pricing editor | type, name, price, desc, notes | `GET/POST /api/admin/pricing` | edit | |
| Receptionist personality | greeting, system, voice, policy textareas | save | `GET/POST /api/admin/prompts` | edit | |
| Quick replies | intent cards | add/save/reload | `GET / PUT /api/admin/runtime/tenants/default/quick-replies` | edit | |
| Receptionist voice | full TTS provider matrix incl. cloning, active-voice select | save | `GET/POST /api/tts/config` | edit | **Exposes raw provider URLs** |
| Recent activity | Calls / Messages stat chips | refresh | `GET /api/admin/analytics` | view | Counts only; no list |
| Subscription | plan grid, Stripe checkout/portal, manual card brand/last4 | | `GET /api/admin/stripe/status`, `GET /api/admin/subscription`, `POST /api/admin/stripe/checkout`, `POST /api/admin/stripe/portal`, `POST /api/admin/subscription` | mixed | |
| Leads | table | | `GET /api/admin/leads?limit=100` | view | |
| Automations | table | | `GET /api/admin/workflows`, `GET /api/admin/workflows/settings` | view | Hidden until workflows exist or `ownerCanEdit=true` — but no edit UI is rendered here |

**Critical issues:** `OWNER_TENANT_ID = "default"` hardcoded; provision/purchase Telnyx calls bypass the `apiFetch` helper (potential auth gap for JWT users); no transcripts; no missed-call inbox; no call log; no business-hours editor; no FAQ list editor; no audio preview button; no health/runtime-sync surface beyond `/ready`.

---

## 4. Client Portal Inventory (`/portal` → `portal.html`)

**Auth model:** real email/password login at `POST /api/owner/login` → JWT stored in `localStorage` (`portal_token`, `portal_tenant_id`, `portal_tenant_name`). Session validated on load with `GET /api/admin/health`. **No forgot-password flow.**

**Navigation:** single page, accordion (`<details>`) sections. No tabs, no hash.

| Section | Anchor | Controls | API endpoints | View / edit | Notes |
|---|---|---|---|---|---|
| Login | `#login-screen` | email, password, sign in; handoff banner if `?from=admin` or `?welcome=1` | `POST /api/owner/login` | edit | No "forgot password" link or endpoint |
| Header | `.portal-topbar`, `#dash-status`, `#logout-btn` | sign-out | none | view | Status text is locally derived, **not** voice-runtime health |
| Overview stats | `.portal-stat-grid` | 4 stat tiles | `/api/admin/analytics`, `/api/admin/leads?limit=100`, in-memory counts | view | No call/transcript drill-down |
| Recent activity | `#overview-activity-list` | Top-5 leads | `/api/admin/leads?limit=100` | view | |
| Change password | `#portal-pass-*` | current/new/confirm | `POST /api/owner/change-password` | edit | |
| Live summary sidebar | `aside.portal-live` | none | none | view | Mirrors edit fields |
| Greeting & tone | `#p-greeting`, `#p-system`, `#p-voice`, `#p-policy` | save / discard | `GET/POST /api/admin/prompts` | edit | |
| Quick replies | `#portal-qr-*` | add/remove cards, FAQ starters, **Suggest with AI** | `GET / PUT /api/admin/runtime/tenants/{t}/quick-replies`, `POST /api/admin/quick-replies/suggest` | edit | AI suggest sends prompts + pricing + contacts to server |
| Voice synthesis (TTS) | `#portal-tts*` | full TTS engine selector + URL + voice/lang/sliders/cloning + Save + **Publish to voice runtime (Redis)** | `GET/POST /api/tts/config`, `POST /api/admin/runtime/tenants/{t}/publish-from-tenant` | edit | **Exposes raw provider URLs**; Qwen3 hint leaks `http://veralux-qwen3-tts:7010` and docker-compose strings; no audio preview button |
| Transfer contacts | forwarding profile editor | add/remove/save | `GET/POST /api/admin/forwarding-profiles` | edit | |
| Services & pricing | items + notes | save | `GET/POST /api/admin/pricing` | edit | |
| Leads & activity | leads table + workflows table | | `GET /api/admin/analytics`, `GET /api/admin/leads?limit=100`, `GET /api/admin/workflows`, `GET /api/admin/workflows/settings` | view | Workflows table has no edit/toggle UI rendered |
| Subscription & billing | plan grid; Pay now / Manage billing or manual card last4 | | `GET /api/admin/subscription`, `GET /api/admin/stripe/status`, `POST /api/admin/stripe/checkout`, `POST /api/admin/stripe/portal`, `POST /api/admin/subscription` | mixed | Section hidden when subscription API says so |

**Items missing from `portal.html` that an SMB will look for first:** business hours editor, FAQ knowledge base editor, dedicated transcripts viewer, missed-call inbox, "test the agent" affordance, usage / quota meters, voice-agent-health pill, integration status (calendar / CRM / SMS / SMTP), forgot-password, onboarding wizard, first-call walkthrough.

**Items present that should not be self-serve client controls:** raw STT/TTS provider URLs, internal docker-compose hostnames in hint text, OpenAI / local-LLM URL hint copy, the `Publish to voice runtime (Redis)` button (it should be implicit on save, not a manually-triggered "infra" action surfaced to the SMB).

---

## 5. Backend Resource Inventory (storage → editor → reader)

### 5.1 Tenant identity & telephony

| Resource | Stored | Edited in | Read by runtime | Admin UI | Owner/Client UI | Tenant-scoped | Validated | Audited | Safe for client? |
|---|---|---|---|---|---|---|---|---|---|
| tenant id | `tenants` | admin Tenant strip; `POST /api/admin/tenants` | DID resolution, every call | yes | no | yes | partial | yes | n/a |
| business name | `tenants.name` | admin Tenant strip | LLM context (via builder) | yes | no (portal shows it read-only) | yes | partial | yes | yes (read) / admin to edit |
| DID list | `tenant_numbers` | admin Tenant strip | `tenantmap:did:<E164>` lookup | yes | yes (`owner.html` Telnyx flow) | yes | E.164 normalize | yes | **no** for raw add/remove (number portability ops are admin) |
| Telnyx API key | `process.env.TELNYX_API_KEY` | server env only | runtime env | no | no | global | env | no | **never** |
| Telnyx connection / webhook | env + `tenant_configs.config.webhookSecret` (or ref) | server env / runtime publish | `verifyTelnyxWebhook` | partial (env hint in Stripe status only) | no | mixed | env | no | **never** |
| active/inactive | `tenant_limits.billingStatus` | admin Settings | runtime `checkTenantUsageBeforeCall` | yes (admin role) | no | yes | Zod | yes | view-only for client |

### 5.2 Receptionist behavior

| Resource | Stored | Editor | Runtime read path | Notes |
|---|---|---|---|---|
| Greeting message | `tenant_configs.prompts.greetingText` (per-tenant) **+ `GREETING_TEXT` env (global default actually used at call open)** | admin Models step 2; owner; portal | `callSession.answerAndGreet` reads **`env.GREETING_TEXT`**, not the tenant prompt | **Cohesion gap:** the per-tenant `greetingText` saved by the UI is published into Redis `tenantcfg.llmContext` but the runtime opening line uses the global env. |
| System preamble | `tenant_configs.prompts.systemPreamble` → Redis `llmContext.prompts.systemPreamble` | same | **Not consumed by `brainClient`** in voice runtime (no `llmContext` reference in `veralux-voice-runtime`) | **Cohesion gap.** |
| Policy prompt | same | same | same | same gap |
| Voice prompt | same | same | same | same gap |
| Schema hint | same | same | same | same gap |
| Tone preference | folded into prompts | admin / owner / portal | n/a (no separate field) | no first-class field |
| Voice provider/mode | `tenant_configs.tts` → Redis `tenantcfg.tts` | admin Models step 3, owner, portal | `playText` per-call | full per-tenant |
| Voice id, language, rate, sliders | same | same | same | full per-tenant |
| Cloned voice WAV | `public/voice-recordings/*.wav` (control plane disk) | admin Models step 3 multipart upload | URL referenced by TTS config | **disk-only**, not in DB |
| After-hours behavior | `workflows` (`after_hours_call` trigger) | admin Workflows | Workflow engine (control plane) | not surfaced as a single setting |
| Fallback message | env `WORKFLOW_SMS_DEFAULT_MESSAGE` + brain fallback strings | env / source | runtime | not editable in UI |
| Escalation / transfer | `tenant_configs.forwarding_profiles` → Redis `transferProfiles` | admin Forwarding, owner, portal | `brainClient` request body | full per-tenant |
| Dead-air handling | env `DEAD_AIR_MS`, `DEAD_AIR_NO_FRAMES_MS` | env only | runtime | not in any UI |
| Message taking rules | none — implicit in prompts/quick-replies | n/a | n/a | not first-class |

### 5.3 Business operations

| Resource | Stored | Editor | Runtime read | Notes |
|---|---|---|---|---|
| Hours of operation | **None** (only `after_hours_call` workflow trigger has implicit hour windows) | Workflows trigger config | Workflow engine | **Major gap.** No first-class business-hours entity. |
| Holidays / closures | none | n/a | n/a | gap |
| Services offered | `tenant_configs.pricing.items` | admin / owner / portal | LLM context (via builder) | edit OK |
| Pricing disclaimers | `tenant_configs.pricing.notes` | same | same | edit OK |
| Booking / appointment rules | only via prompts | prompts | n/a | gap (no structured booking) |
| Location / address | none | n/a | n/a | gap |
| Service area | none | n/a | n/a | gap |
| FAQ / knowledge base | quick replies (intent → reply) | admin / owner / portal | `matchQuickReply` | functional but **lacks long-form FAQ** |
| Emergency handling | only via prompts/workflows | n/a | n/a | gap |
| Staff routing | forwarding profiles | yes | runtime | OK |

### 5.4 Voice / runtime configuration

| Resource | Stored | Editor | Runtime read | Notes |
|---|---|---|---|---|
| STT mode | `env.STT_*` + `tenant_configs.stt` → Redis `stt.mode` | env / per-tenant via `POST /api/admin/runtime/tenants/:t/config` | `CallSession` ctor | most knobs env-only |
| Whisper URL | env / per-tenant `stt.whisperUrl` | env / runtime API | runtime | per-tenant override exists; **not surfaced in any UI** |
| TTS mode | per-tenant `tenantcfg.tts` | admin / owner / portal | `synthesizeSpeech` | OK |
| Silence thresholds | env `STT_SILENCE_*` | env only | runtime | not in UI |
| Echo suppression mode | env `STT_ECHO_SUPPRESSION_MODE` | env only | runtime | not in UI |
| Audio forensics toggle | env `AUDIO_FORENSICS_ENABLED` + dir | env / disk only | runtime | **dangerous**; admin-only by design |
| Local brain / LLM mode | env `BRAIN_USE_LOCAL`, `BRAIN_URL` | env only | runtime | Models step 1 picks OpenAI vs local URL but **only the cloud control-plane LLM**; voice-runtime brain is env |
| Health / readiness config | env `HEALTH_VOICE_DEPENDENCIES` | env only | `routes/health.ts` | not in UI |
| Call concurrency | `tenant_limits.maxConcurrentCalls`, env `GLOBAL_CONCURRENCY_CAP`, Redis `cap:` keys | admin Settings | `tryAcquire` | per-tenant editable; global is env |

### 5.5 Plans / limits / billing

| Resource | Stored | Editor | Runtime read | Notes |
|---|---|---|---|---|
| Plan tier | `tenant_limits.planTier` | admin Settings | call-start gate | full path; client views in portal |
| Monthly minutes | `tenant_limits.includedMonthlyMinutes`, `maxMonthlyMinutesHardCap` | admin | runtime | OK |
| Daily call cap | `tenant_limits.maxDailyCalls` | admin | runtime | OK |
| Concurrent call cap | `tenant_limits.maxConcurrentCalls` + Redis cap | admin | runtime capacity Lua | OK |
| Overage mode | `tenant_limits.overageMode` | admin | runtime | OK |
| Billing status | `tenant_limits.billingStatus` | admin (with confirm) | runtime gate | suspended/canceled blocks calls |
| Usage summary | `tenant_usage_daily`, `tenant_usage_monthly` | runtime writes | `GET /api/admin/tenants/:t/usage` | not surfaced in portal |
| Billing summary | computed | n/a | `GET /api/admin/tenants/:t/billing-summary?month=YYYY-MM` | not surfaced in portal |
| Feature entitlements | `tenant_limits.feature*` | admin Settings | `requireTenantFeature` (control plane), but **not enforced in voice runtime** | `incFeatureDeniedByPlan` is defined but unreferenced |

### 5.6 Logs / observability

| Resource | Stored | Editor | Reader | Surfaced where? |
|---|---|---|---|---|
| Call history (cards) | `tenant.calls` (memory) + `calls` (DB) | runtime ingest | admin Calls tab | admin only; **not in owner/portal** |
| Transcripts | `CALL_TRANSCRIPT_DIR` files; partials in audit | runtime end-of-call | none in any UI | **only on disk**; not browseable in any panel |
| Recordings / artifacts | `AUDIO_FORENSICS_DIR`, audio storage | runtime | `GET /health/audio` (count only) | admin SSH / manual only |
| Failed calls | runtime metrics + Telnyx events | runtime | `/metrics` | not in any UI |
| Rejected transcripts | logs (`STT_REJECT_*` counters) | runtime | `/metrics` | not in any UI |
| Health snapshots | `GET /api/admin/health`, `GET /health` (runtime) | n/a | admin Overview | partial; no voice-runtime status pill in portal/owner |
| Incidents | none — no first-class incident entity | n/a | n/a | **gap** (per `INCIDENT_RESPONSE_RUNBOOK.md`) |
| Webhook errors | logs only | n/a | n/a | no UI |
| Tenant runtime sync status | implicit in `GET /api/admin/runtime/tenants/:t/config` | admin runtime tab? | admin manual call | **no UI surface** beyond debug-JSON dump |

### 5.7 Integrations

| Resource | Stored | Editor | Reader | UI |
|---|---|---|---|---|
| Calendar | `tenant_limits.featureCalendarIntegration` flag only | admin Settings | feature gate (control plane) | flag only; **no OAuth UI** |
| CRM | `tenant_limits.featureCrmIntegration` | same | same | flag only |
| SMS follow-up | `tenant_limits.featureSmsFollowup` + workflow `send_sms` step | admin | workflow engine | partial; envelope provider unclear |
| Email / SMTP | env `SMTP_*` + workflow `send_email` step | env / workflows | workflow engine | env only |
| Stripe | `stripe_plans`, `tenant_subscriptions`, env keys | admin Billing | webhook handler | full path |
| Webhooks (workflow `fire_webhook`) | workflow steps | admin / portal | workflow engine | edit OK |
| Routing/forwarding numbers | `tenant_configs.forwarding_profiles` | all 3 panels | runtime | OK |

---

## 6. Admin vs Owner/Client Responsibility Matrix

| Control | Current location | Ideal location | Gap | Risk | Recommended action |
|---|---|---|---|---|---|
| Telnyx API key | env | env (admin only) | none | low | OK |
| Telnyx number search/purchase | `owner.html` (operator) | **admin only** | wrong audience | medium (raw `fetch` + `X-Admin-Key`-only) | move to admin Tenant strip; route owner-portal to a "request a number" form |
| Webhook secret | env / runtime publish | admin only | OK | low | document; never expose in portal |
| OpenAI API key | admin Models step 1 | admin only | OK | low | already gated by admin modal |
| Local LLM URL | admin Models step 1 + env | admin only | OK | low | OK |
| STT provider URL / mode | env + per-tenant runtime API | admin only | UI gap (no editor) | low | add admin sub-tab for STT |
| TTS provider URL | admin / owner / **portal** | **admin only**; portal picks from preset list | **client editing arbitrary URLs** | **HIGH** (SSRF, infra leak) | replace URL field in portal with named-preset dropdown populated by admin |
| TTS voice / language / rate | admin / owner / portal | all three | OK | low | keep |
| Voice cloning upload | admin Models step 3 | admin only (or paid add-on) | OK | medium (file safety) | already admin |
| Plan tier | admin Settings | **admin only** | OK | low | client views via subscription |
| Billing status (suspend/cancel) | admin Settings | **admin only** | OK | low | OK |
| Limits caps | admin Settings | **admin only** | OK | low | OK |
| Feature entitlements | admin Settings | **admin only** | runtime not enforcing | medium | wire `incFeatureDeniedByPlan` and feature gates into voice-runtime paths |
| Cloudflare tunnel token | admin Settings | **admin only** | broken handler (`requireAuth` undefined) + global `process.env` mutation | **HIGH** | fix handler; persist to file/DB instead of `process.env`; restrict to true super-admin role |
| Forensics / debug toggles | env (`AUDIO_FORENSICS_*`, `STT_DEBUG_*`) | admin only | no UI | low (env-only is acceptable) | leave env-only; add admin status tile "Debug capture: on/off" |
| Production health / incidents | `/api/admin/health` only | admin first-class tab | no incident model | medium | add `incidents` table + admin Incidents tab |
| Tenant suspension | `billing-status=suspended` | admin only | OK | low | OK; add reason field |
| Greeting | admin / owner / portal | **owner/client edit** | runtime ignores per-tenant value | medium | wire runtime to use tenant `greetingText` instead of `env.GREETING_TEXT` |
| Hours | none | **owner/client edit** | **MISSING** | medium | add first-class hours entity + UI |
| Services / pricing | admin / owner / portal | owner/client edit | OK | low | OK |
| FAQs | quick replies (short) | owner/client edit | no long-form | low | extend quick-replies to support FAQ-mode entries |
| Booking preferences | none | owner/client edit | **MISSING** | medium | new booking-rules entity |
| Escalation contacts | all three | owner/client edit | OK | low | OK |
| Fallback message | env only | owner/client edit | UI gap | low | add field |
| Tone preference | folded into prompts | owner/client edit (preset chips) | UI gap | low | add tone presets that prepend to systemPreamble |
| Notification recipients | workflows | owner/client edit | OK once Workflows UI is exposed in portal | medium | add a slim "notifications" section in portal |
| Usage summary | admin Settings + `/usage` API | **owner/client view** | MISSING in portal | high | add a "Usage this month" tile in portal |
| Recent calls / messages | admin Calls + `/api/admin/calls` | **owner/client view** | MISSING in portal/owner | high | add Calls list section to portal |
| Transcripts | disk only | owner/client view | MISSING everywhere | high | add transcript viewer (admin first, then portal read-only) |
| Missed calls | none | **owner/client view** | MISSING | high | add missed-calls list (workflow engine has the trigger label already) |
| Appointment requests | none | owner/client view | MISSING | medium | tie to leads + a `lead_type=appointment` |
| Billing plan | admin / owner / portal | owner/client view | OK | low | OK |
| Current limits | admin Settings | **owner/client view** (read-only) | MISSING in portal | medium | add "Plan limits" panel |
| Secrets | env / DB | **hidden from client** | OK | low | OK |
| Raw provider config | env + admin | hidden from client | **portal exposes URLs** | HIGH | see TTS row above |
| Infrastructure ports | env | hidden from client | **leaked in Qwen3 hint text** | low–medium | scrub hint text |
| Redis / Postgres | env | hidden from client | OK | low | OK |
| Debug capture | env | hidden from client | OK | low | OK |
| Raw forensic artifacts | disk | admin export only | OK | low | OK |
| Internal errors | logs | hidden from client | mostly OK; some `confirm`/error toasts pass server text verbatim | low | wrap in friendly messages |

---

## 7. UI ↔ Backend Cohesion Check

For each item: **COMPLETE** = end-to-end working in admin and surfaced sensibly to client; **PARTIAL** = implemented but with gaps; **MISSING** = no UI; **BACKEND-ONLY** = backend works, no UI exposes it; **UI-ONLY** = UI saves it but runtime ignores; **UNSAFE** = client UI can change something it should not.

| # | Capability | Admin | Owner/Client | Verdict |
|---:|---|---|---|---|
| 1 | Greeting message | edit | edit (portal/owner) | **UI-ONLY (per-tenant value not used by runtime; `env.GREETING_TEXT` is what plays)** |
| 2 | System preamble | edit | edit | **UI-ONLY (`brainClient` does not send `llmContext.prompts`; only `assistantContext`)** |
| 3 | Policy prompt | edit | edit | UI-ONLY (same root cause) |
| 4 | Business hours | none | none | **MISSING** (workflow trigger only) |
| 5 | After-hours behavior | edit (Workflows) | view-only | PARTIAL |
| 6 | Escalation / transfer routing | edit | edit | COMPLETE |
| 7 | Message taking | implicit (prompts + workflows) | implicit | PARTIAL |
| 8 | Call logs | view (admin Calls) | none | PARTIAL — **MISSING in portal/owner** |
| 9 | Transcripts | none in UI | none | **MISSING** (disk only) |
| 10 | Missed calls | none in UI (workflow trigger label only) | none | **MISSING** |
| 11 | Usage / quotas | admin (Settings) | none | PARTIAL — **MISSING in portal** |
| 12 | Plan tier | admin edit | view (subscription) | COMPLETE |
| 13 | Billing status | admin edit | view | COMPLETE |
| 14 | Feature entitlements | admin edit, control-plane gates respect them | none | **PARTIAL** — voice runtime ignores feature flags |
| 15 | Voice / TTS selection | admin / owner / portal | edit | COMPLETE for voice; **UNSAFE** for raw provider URL exposure in portal |
| 16 | STT / TTS / LLM health | admin Overview tile | none | PARTIAL |
| 17 | Tenant runtime sync | manual button (admin + portal `publish-from-tenant`); auto on most saves | manual button in portal | PARTIAL — should be implicit + status indicator |
| 18 | Phone number / Telnyx status | partial (numbers list in tenant strip; no Telnyx auth status tile) | edit (owner.html) | PARTIAL |
| 19 | Webhook status | none in UI | none | **MISSING** (logs only) |
| 20 | Integrations (calendar / CRM / SMS / email / Stripe) | feature flags + Stripe path | partial (Stripe in portal) | PARTIAL — flags without OAuth flows |
| 21 | Forensics / debug status | none in UI | none | **BACKEND-ONLY** (env + disk) |
| 22 | Production readiness / health | admin Overview | none | PARTIAL — no voice-runtime health pill in portal |

**Top cohesion findings:**

1. **Per-tenant prompts are written to Redis but not consumed by `brainClient`.** The control plane builds `llmContext.prompts.{systemPreamble, policyPrompt, voicePrompt, schemaHint}` and writes it to `tenantcfg:<tenantId>`, but `veralux-voice-runtime/src/ai/brainClient.ts` only sends `transferProfiles`, `assistantContext`, `transcript`, and `history`. Anything edited in the prompts panels likely has no effect on call behavior unless `assistantContext` is also kept in sync (and the audit found no such sync).
2. **Greeting is global, not per-tenant.** `callSession.answerAndGreet` reads `env.GREETING_TEXT`. The per-tenant `greetingText` saved in admin/owner/portal is shipped in `llmContext` and unused.
3. **Plan feature flags are advisory only at the runtime.** `incFeatureDeniedByPlan` exists in `metrics.ts` but is never called; `usageLimits.features` is populated by the builder but not read by the voice runtime.
4. **No transcript / missed-call / call-history UI in portal or owner.** Backend stores everything; UI exposes a single counter.
5. **No first-class business-hours entity.** Hours live inside workflow triggers — fragile and invisible to the client.
6. **`portal.html` exposes raw provider URLs and a manual "Publish to Redis" button** to a paying SMB — both should be admin-only or auto.
7. **`owner.html` is hardcoded to `OWNER_TENANT_ID = "default"`** and uses raw `fetch` for two Telnyx routes. It is essentially a single-tenant operator tool, not a productized panel.
8. **Three overlapping owner-ish UIs** (`admin` token modal, `owner.html` operator, `portal.html` client) cause role and copy confusion. Pick one canonical client UI (`portal.html`) and keep `owner.html` as an internal tool only.

---

## 8. Client-Readiness UX Gaps

| Gap | Severity | Why it matters | Affected role | Recommended UI/API change | Backend / runtime dependency | Effort |
|---|---|---|---|---|---|---|
| No onboarding wizard for new business | **P0** | First-paid client cannot self-configure; staff must hand-walk every signup | client | 5-step wizard in portal: business → number → hours → greeting/services → test call | uses existing APIs + new hours entity | M |
| No "test the agent" affordance in portal | **P0** | Client cannot validate before going live | client | "Place test call" button (initiates webhook to runtime against a test DID) or browser WebRTC test (`/v1/webrtc/offer` already exists) | leverage existing `/hd-call` page; expose with auth | S |
| No transcripts viewer | **P0** | Client cannot review what the agent said; trust killer | client + admin | Calls list + per-call transcript drawer (admin first, then portal) | new endpoint `GET /api/admin/calls/:id/transcript` reading `CALL_TRANSCRIPT_DIR` | M |
| No missed-calls inbox | **P0** | Core promise of "voice receptionist" is "we won't miss calls" | client | Missed-calls section in portal Leads, distinct from generic leads | tag leads with `missed_call` source (workflow already has the trigger) | S |
| No business-hours editor | **P0** | Hours drive after-hours behavior, message-taking, voicemail tone | client | Hours picker per weekday + holidays; persists to `tenant_configs.businessHours` | new schema + builder field; runtime brain context | M |
| No usage / quota meter in portal | **P1** | Client gets bill-shocked or hits hard cap unexpectedly | client | "Usage this month" tile fed by `GET /api/admin/tenants/:t/usage` (already exists) | UI only | XS |
| No voice-agent health pill | **P1** | Client doesn't know if the agent is currently live | client + admin | "Receptionist live · last call X min ago" pill fed by `/api/admin/health` and `/health/voice` (runtime) | needs a control-plane proxy of runtime `/health/voice` since portal can't call runtime cross-origin | S |
| No "what failed" surface | **P1** | When something breaks, client has nowhere to look; support tickets balloon | client + admin | Recent issues feed (failed calls + provider degradations) in portal; full incident list in admin | new lightweight `incidents` table fed by metrics counters | M |
| No transcripts export | **P1** | Compliance / audit asks; client wants to share with staff | client | "Export call summary CSV/PDF" in portal Calls | new endpoint | S |
| No FAQ knowledge base (long form) | **P1** | Quick replies cap at one-line replies; FAQ docs are richer | client | New "Knowledge base" section: list of Q/A pairs; flow into `assistantContext` | extend builder + brain prompt | M |
| No forgot-password / password reset flow | **P1** | Client locked out → vendor must reset manually | client | "Forgot password" → magic link via SMTP | new endpoint + SMTP wiring (already partial) | S |
| No "change escalation contact" affordance with verification | **P1** | Today the field accepts any E.164 with no SMS verification | client | Forwarding profile add: send SMS code → confirm before save | new `verifyForwardingNumber` endpoint | M |
| No live "current call(s)" view | **P2** | Operator/client visibility | admin first | Live calls tile in admin Overview (Buttons in HTML are placeholders today) | runtime exposes capacity counters; needs `GET /api/admin/calls/active` | S |
| No "handoff to human" hot-transfer button | **P2** | True receptionist UX | admin/client | Buttons exist disabled in admin Overview; wire to `POST /v1/calls/:cc/voice` + a transfer API | runtime needs explicit transfer endpoint | M |
| Webhook / integrations status panel | **P2** | Client wants to know calendar / SMTP / Stripe are connected | client | Integrations panel with status chips | new `GET /api/integrations/status` | M |
| Voice / TTS audio preview button in portal | **P2** | Client cannot hear the voice they pick before going live | client | "Play sample" calling `/api/tts/preview/async` | UI only | S |
| Tone presets (friendly / formal / concierge) | **P3** | Fast intuitive personality control vs free-text prompts | client | Chips that prepend boilerplate to systemPreamble | UI only | XS |
| Notification recipients editor | **P3** | Define who gets SMS / email when a lead arrives | client | Slim form in portal Settings | extend workflow settings | S |
| Branding / logo upload in portal | **P3** | Multi-brand SMB experience | client | Optional logo URL; already partly env-driven | extend `BRAND_*` to per-tenant | M |

---

## 9. Security / Permission Findings

The control-plane backend uses `adminGuard("viewer")` on all `/api/admin/*` and `adminGuard("admin")` on the riskier mutations, plus `ensureTenantAccess` on most tenant-scoped routes. Per-call runtime control is gated by `VOICE_CONTROL_API_KEY` on `/v1/calls/:cc/voice`. Owner JWTs are inserted into the membership table at login so they pass `ensureTenantAccess` for their tenant.

**Confirmed gaps (in priority order):**

| # | Finding | Where | Risk | Fix |
|---:|---|---|---|---|
| S1 | `GET /api/admin/tenants` returns **all tenants** for any viewer JWT — no per-JWT tenant filter | `server.ts` admin tenants list | **information disclosure across tenants** | filter by `req.ctx.tenantIds` for non-superadmin |
| S2 | `POST /api/runtime/calls` and `POST /api/runtime/analytics` accept `tenantId` from request body, no `ensureTenantAccess` | runtime ingest routes | **cross-tenant IDOR** for any tenant JWT with admin role | bind `tenantId` to JWT membership; reject mismatched body |
| S3 | `DELETE /api/admin/leads/:id` calls `deleteLead(id)` with no tenant filter | leads | **cross-tenant lead deletion if UUID known** | add `WHERE tenant_id = $2` |
| S4 | `GET/POST /api/admin/cloudflare/token` mutates **global `process.env`** under viewer auth and lives outside any tenant | platform secret | **dangerous global mutation, not multi-worker safe** | persist to disk/DB; restrict to admin role; reload via SIGHUP-style mechanism |
| S5 | Telnyx routes (`status`, `numbers`, `available`, `provision`, `purchase`, `connections`) are **viewer-only** but are **account-level** (not tenant-scoped) | Telnyx admin routes | tenant JWT can probe / mutate the carrier account | restrict to admin role + non-OIDC superadmin only |
| S6 | `owner.html` calls Telnyx provision/purchase via raw `fetch` with **only `X-Admin-Key`** | client UI | JWT users cannot use them; admin-key path may be unintentionally privileged | route through `apiFetch`; require Bearer; consider moving entirely to admin |
| S7 | `portal.html` exposes **raw STT/TTS provider URL fields** to the client | portal TTS section | **SSRF, infra leak** | replace with named-preset dropdown; admin curates presets |
| S8 | `portal.html` Qwen3 hint text leaks `http://veralux-qwen3-tts:7010` and docker-compose strings | portal | **infra topology leak** | scrub copy |
| S9 | `validationSchemas.ts` exists but is **not imported by `server.ts`**; many routes rely on ad-hoc checks | server-wide | inconsistent / weaker validation | wire schemas into `validateBodyMiddleware` for at least admin POST/PATCH |
| S10 | Owner bootstrap routes (`/api/owner/set-passcode`, `/api/owner/set-portal-credentials`) **bypass `adminGuard` audit log + CORS allowlist** | bootstrap | gaps in audit trail | route through `adminGuard("admin")` + ensure CORS |
| S11 | `/v1/calls/:callControlId/voice` (control plane proxy) has **no tenant binding**; relies entirely on the voice runtime to honor admin token + call id | runtime hot-swap | cross-tenant voice change if `callControlId` is guessable / leaked | runtime should verify `callControlId` belongs to a tenant the requester can see |
| S12 | Bug: `requireAuth(saveCloudflareToken)` is referenced in `admin.html` but `requireAuth` is **not defined** in that file (it lives in `owner.html`) | UI | **Cloudflare save throws `ReferenceError`** | inline an admin-modal gate or define `requireAuth` in admin.html |
| S13 | `portal.html` accepts both **JWT and raw admin key** as a portal token (via `setPortalAuthHeaders` falling back to `X-Admin-Key`) | client UI | semantics blur; an admin key inadvertently typed in could authenticate as portal | restrict portal flow to JWT only |
| S14 | `GET /api/admin/health` returns **whisperUrl, TTS URLs, localUrl, global active call counts** to any viewer | health | **operational data leakage** | return less for non-admin role |
| S15 | Voice-recording uploads land at predictable URLs under `public/voice-recordings/` | TTS cloning | **enumeration / unauthorized download** of cloned voices | move out of `public/`; serve through auth-gated endpoint |
| S16 | No account lockout / brute-force protection beyond IP rate-limit on `/api/owner/login` | auth | weak abuse posture | add per-account counter + lockout |
| S17 | No CSRF protection on `apiFetch` POSTs (relies on Bearer token in JS) | portal | acceptable for token auth, but portal sets `Authorization` from `localStorage` — vulnerable to XSS-token theft | move to httpOnly cookie + CSRF token |

**Frontend-only enforcement to be aware of:** the `confirm()` modals, password length checks, and input format checks in `admin.html` / `portal.html` are best-effort UX. The audit confirmed that mutating routes that matter (limits, billing-status, runtime config, admin keys) **also enforce** Zod / role / tenant-scope checks server-side. The exceptions are S1–S5, S10, S11, S15.

---

## 10. Product Cohesion Score

Strict scoring against "first paid SMB pilot" expectations (the bar is "the client can use this without engineering hand-holding").

### 10.1 Admin control completeness — **75 / 100**

**Good:** plan/limits/billing-status/usage all editable; full TTS provider matrix; prompts editor; workflow CRUD; admin-key management; analytics + audit + calls views; Stripe wiring; runtime publish + per-tenant runtime config + DID map.

**Incomplete:** STT URL/mode editor; webhook secret editor; first-class incidents tab; live calls tile (placeholders only); transcripts viewer; webhook-error feed; integrations status (calendar/CRM/SMTP); Telnyx connection-status tile separate from numbers list.

**Confusing:** admin token modal flow vs OIDC flow; `requireAuth` bug; "Sync stack" button vs implicit syncs; debug pill returning raw JSON.

**Must fix before pilot:** S1, S2, S3, S4, S12 (security + the broken Cloudflare handler).

### 10.2 Owner / client usability — **48 / 100**

**Good:** portal has email/password login; persistent session; clean accordion editor with live preview; AI-assist for quick replies; Stripe checkout/portal wiring.

**Incomplete:** **no transcripts, no call history, no missed-call inbox, no business-hours editor, no usage meter, no agent-health pill, no test-call button, no onboarding wizard, no forgot-password.** These are the items a paying SMB will look for in the **first 60 seconds**.

**Confusing:** raw STT/TTS provider URLs visible to client; Publish-to-Redis button looks like infra; copy mentions "OpenAI API key" and "Redis" in hint text; three different owner-ish UIs.

**Must fix before pilot:** missed-calls + transcripts + hours + usage tile + onboarding wizard.

### 10.3 Runtime / UI cohesion — **55 / 100**

**Good:** runtime publish path is real and exercised on most admin saves; per-call tenantcfg load works; quick replies and forwarding profiles do reach the runtime; capacity Lua + per-tenant caps work; usage counters write to Postgres.

**Incomplete:** **prompts written by UI are not consumed by the brain client** (the central cohesion bug); greeting is global env not per-tenant; feature entitlements not enforced at the runtime; many env knobs (STT silence, echo, dead-air, forensics) have no UI; webhook status / sync status not surfaced.

**Confusing:** "Publish to runtime" button vs implicit sync (sometimes both fire); two layers of TTS config (env default vs per-tenant); transcript files exist but are not addressable from any UI.

**Must fix before pilot:** wire prompts into `brainClient` (or merge them into `assistantContext` in the builder); use tenant `greetingText` in `answerAndGreet`.

### 10.4 Tenant safety / isolation — **60 / 100**

**Good:** `adminGuard` + `ensureTenantAccess` cover most tenant-scoped routes; owner JWTs scoped to single tenant via membership; capacity Lua bounds per-tenant; production startup fail-fast for debug capture; Telnyx signature verification + replay guard; `/v1/calls/:cc/voice` requires API key.

**Incomplete:** S1–S6, S10, S11, S15 (above) are real cross-tenant or platform-secret gaps. `tenant_api_keys` table exists but is unused. Voice-recording upload bucket is publicly enumerable. No account lockout.

**Must fix before pilot:** S1, S2, S3, S4, S5 at minimum.

### 10.5 First-client onboarding readiness — **40 / 100**

**Good:** the technical pieces exist (Telnyx number search/purchase, owner password set, prompts/voice/forwarding/pricing editors, plan limits, Stripe checkout).

**Missing:** any guided sequence. A new client lands on `portal.html`, sees seven accordions and a Pay Now button, with no Telnyx provisioning UI (that's only on `owner.html`), no test call, no business-hours field, no clear "you are live" state.

**Must fix before pilot:** add a 5-step wizard or scripted vendor onboarding playbook + a "you are live" page.

### 10.6 Overall panel readiness — **55 / 100**

The platform can run a **white-glove pilot** today (vendor onboards client, vendor sets prompts/voice/Telnyx via admin, client logs into portal mostly to view leads + change pricing/contacts). It is **not yet ready** to hand to an SMB and ask them to self-onboard, self-monitor, or self-recover.

| What is already good | What is incomplete | What is confusing | What MUST be fixed before pilot | What can wait |
|---|---|---|---|---|
| Backend route surface, plan-limits, runtime publish, Stripe, capacity, audit logging, admin token + OIDC, replay/signature, debug fail-fast | Transcripts, missed calls, hours, usage tile in portal, agent-health pill, test-call, password reset, incident model, integrations OAuth, prompts→brain wiring | Three owner-ish UIs; raw provider URLs in client portal; `Publish to Redis` button; admin Overview "Take over" placeholders | S1–S5 + S12 cross-tenant/perm fixes; prompts+greeting reaching the runtime; missed-calls + transcripts + hours + usage in portal; onboarding wizard or scripted vendor playbook | Live-calls tile, hot-transfer button, FAQ long-form editor, voice audio preview in portal, integration status panel, branding per-tenant |

---

## 11. Prioritized Implementation Roadmap

### Sprint 0 — Stop the bleeding (≤ 1 week)

1. **S1**: scope `GET /api/admin/tenants` to JWT memberships.
2. **S2**: bind `POST /api/runtime/*` to JWT tenant.
3. **S3**: add `tenant_id` filter to `deleteLead`.
4. **S4**: persist Cloudflare token to DB (or env-only on disk); restrict route to admin role.
5. **S12**: fix `requireAuth` reference in `admin.html`.
6. Replace raw provider URL fields in `portal.html` with admin-curated preset dropdown; scrub Qwen3 hint copy.

### Sprint 1 — Make the runtime honor what the UI saves (≤ 1 week)

7. Wire `llmContext.prompts.{systemPreamble, policyPrompt, voicePrompt, schemaHint}` into `brainClient` (either by sending `llmContext` or by merging into `assistantContext` at build time).
8. Use tenant `greetingText` in `callSession.answerAndGreet`; fall back to env only if missing.
9. Wire `incFeatureDeniedByPlan` into the actual feature paths (SMS, calendar, recording).

### Sprint 2 — Make the portal answer the client's first 5 questions (≤ 2 weeks)

10. Add **Calls** section to `portal.html` (paginated list from `GET /api/admin/calls`).
11. Add **Transcripts** drawer (new endpoint `GET /api/admin/calls/:id/transcript` reading `CALL_TRANSCRIPT_DIR`).
12. Add **Missed calls** subtab in Leads (filter by `source=missed_call`).
13. Add **Usage this month** tile fed by `/api/admin/tenants/:t/usage`.
14. Add **Receptionist live** pill fed by control-plane proxy of `/health/voice`.

### Sprint 3 — Make the client able to set up themselves (≤ 2 weeks)

15. Add **Business hours** entity + editor (per weekday, holidays); flow into builder + brain context; expose `after_hours_call` workflow trigger as a derived state.
16. Add **Onboarding wizard** in portal (business name → number → hours → greeting/services → test call).
17. Add **Test call** affordance (browser WebRTC `/v1/webrtc/offer` is already wired — just gate it behind portal auth).
18. Add **Forgot password** flow via SMTP magic link.

### Sprint 4 — Operations + observability (≤ 2 weeks)

19. Add admin **Incidents** tab + lightweight `incidents` table fed by metric counters.
20. Add admin **Live calls** tile (capacity counters + tenant breakdown).
21. Add **Webhook errors** feed in admin Overview.
22. Add **Integrations** status panel in portal (calendar/CRM/SMTP/Stripe chips).
23. Add **Tone presets** chips + voice audio preview in portal.

### Sprint 5+ — Enterprise-only

24. OAuth flows for calendar / CRM.
25. Per-tenant branding upload.
26. Full incident SLO dashboard.
27. Account lockout + anomaly alerts on owner/admin login.
28. Move portal auth to httpOnly cookie + CSRF token.

---

## 12. Final Readiness Score

**Overall: 55 / 100** — pilot-ready under vendor white-glove operation; not ready for SMB self-serve.

Pilot-band threshold (per `PILOT_READINESS_SCORE.md`) is "trained operators + written limitations + test-call exit criterion". The control surface meets that under those guardrails. The Sprint-0 + Sprint-2 items above are the minimum to lift the experience into "the client can run this" territory (target: **75**).

**Quick win deltas if Sprint 0 + 1 + 2 ship:**

| Dimension | Now | After Sprints 0–2 |
|---|---:|---:|
| Admin control completeness | 75 | 80 |
| Owner/client usability | 48 | 70 |
| Runtime/UI cohesion | 55 | 80 |
| Tenant safety / isolation | 60 | 80 |
| First-client onboarding readiness | 40 | 60 |
| **Overall** | **55** | **74** |
