# Panel Client-Readiness Checklist

Companion to `docs/PANEL_CONTROL_SURFACE_AUDIT.md`. Items are grouped by **release gate**, not by area. Check items off as they ship.

Legend: `[ ]` = todo · `[x]` = done · **(S/M/L)** = effort · **{role}** = who does the work · **→** = links to audit section / finding id.

---

## A. Must fix before first paid pilot (release gate: P0)

These must be done before a paying SMB touches the portal. Anything left unchecked here means the vendor must operate it manually.

### A.1 Security / cross-tenant safety

- [ ] **S1** Scope `GET /api/admin/tenants` to JWT memberships (currently lists all tenants for any viewer JWT) **(S) {backend}** → audit §9 S1
- [ ] **S2** Bind `tenantId` on `POST /api/runtime/calls` and `POST /api/runtime/analytics` to JWT membership; reject body-supplied mismatches **(S) {backend}** → §9 S2
- [ ] **S3** Add `WHERE tenant_id = $2` to `deleteLead` so `DELETE /api/admin/leads/:id` cannot delete cross-tenant **(XS) {backend}** → §9 S3
- [ ] **S4** Move Cloudflare tunnel token off `process.env`; persist to DB or local file; restrict GET/POST routes to `adminGuard("admin")` **(S) {backend}** → §9 S4
- [ ] **S5** Restrict Telnyx admin routes (`status`, `numbers`, `available`, `provision`, `purchase`, `connections`) to `adminGuard("admin")` + non-OIDC superadmin **(XS) {backend}** → §9 S5
- [ ] **S12** Fix `requireAuth(saveCloudflareToken)` `ReferenceError` in `admin.html` (function not defined in that file) **(XS) {frontend}** → §9 S12
- [ ] Replace raw STT/TTS provider URL fields in `portal.html` with named-preset dropdown curated by admin **(M) {frontend, backend}** → §9 S7
- [ ] Scrub Qwen3 docker-compose hint copy from `portal.html` **(XS) {frontend}** → §9 S8

### A.2 Runtime ↔ UI cohesion (the prompts the client edits actually take effect)

- [ ] Wire `llmContext.prompts.{systemPreamble, policyPrompt, voicePrompt, schemaHint}` into `brainClient` request body (or fold them into `assistantContext` at build time) **(M) {runtime}** → §7 finding 1
- [ ] Use tenant `greetingText` in `callSession.answerAndGreet`; fall back to `env.GREETING_TEXT` only if missing **(S) {runtime}** → §7 finding 2

### A.3 Client-portal "first 60 seconds" essentials

- [ ] Add **Calls** section to `portal.html` (paginated list from `GET /api/admin/calls`) **(S) {frontend}** → §8
- [ ] Add **Transcript** drawer per call (new endpoint `GET /api/admin/calls/:id/transcript` reading `CALL_TRANSCRIPT_DIR`) **(M) {backend, frontend}** → §8
- [ ] Add **Missed calls** filter to portal Leads (source = `missed_call`) **(S) {frontend}** → §8
- [ ] Add **Usage this month** tile fed by `GET /api/admin/tenants/:t/usage` **(XS) {frontend}** → §8
- [ ] Add **Receptionist live** health pill in portal header (control-plane proxy of `/health/voice`) **(S) {backend, frontend}** → §8
- [ ] Add **Business hours** first-class entity (per-weekday + holidays) and editor in portal; flow into runtime `assistantContext` **(M) {backend, runtime, frontend}** → §8
- [ ] Add **Forgot password** magic-link flow over SMTP **(S) {backend, frontend}** → §8

### A.4 Onboarding

- [ ] Either (a) ship a 5-step onboarding wizard in portal (business → number → hours → greeting/services → test call) **(L) {frontend, backend}** OR (b) publish a written vendor-onboarding playbook + scripted helper script and gate the portal behind a "vendor-completed setup" flag **(M) {docs, ops}** → §8
- [ ] Add **Test call** affordance in portal (gate the existing `/v1/webrtc/offer` browser path behind portal auth) **(S) {frontend, backend}** → §8
- [x] Night-desk **cutover table** (not `operatorState.onboarding` JSON) gates go-live: DID, hours, playbook, on-call SMS, refuse-out-of-area, book-or-hold, test call **{backend, frontend}**

### A.5 Operability minimum

- [ ] Decide canonical client UI: keep `portal.html` (client) and `admin.html` (super-admin); demote `owner.html` to internal vendor tool only (or delete) **(S) {product}** → §7 finding 8
- [ ] Remove the **Publish to voice runtime (Redis)** button from `portal.html`; make publish implicit on every save (it already is for most paths) **(XS) {frontend}** → §3 / §4
- [ ] Hide raw "OpenAI API key" / "local LLM URL" copy from any portal-facing surface **(XS) {frontend}** → §6
- [ ] Hardcoded `OWNER_TENANT_ID = "default"` in `owner.html`: either remove `owner.html` from production routes, or wire it to the active tenant **(S) {frontend}** → §3

---

## B. Should fix before second/third pilot (release gate: P1)

Get these done before onboarding pilot #2. They convert "vendor-operated" into "client-operated".

### B.1 Security hardening

- [ ] **S6** Route Telnyx provision/purchase calls in `owner.html` through the standard auth helper (not raw `fetch` with admin-key only) **(XS) {frontend}**
- [ ] **S10** Route owner bootstrap endpoints (`set-passcode`, `set-portal-credentials`) through `adminGuard("admin")` so audit log + CORS apply **(S) {backend}**
- [ ] **S11** In voice runtime, verify `callControlId` belongs to a tenant the requester can see before allowing `/v1/calls/:cc/voice` **(S) {runtime}**
- [ ] **S14** Reduce `GET /api/admin/health` payload for non-admin role (hide whisperUrl, TTS URLs, global call counts) **(S) {backend}**
- [ ] **S15** Move voice-recording uploads out of `public/voice-recordings/`; serve through auth-gated endpoint **(M) {backend}**
- [ ] **S9** Wire `validationSchemas.ts` into `validateBodyMiddleware` for at least the admin POST/PATCH routes **(M) {backend}**
- [ ] **S13** Restrict portal auth to JWT only (drop the `X-Admin-Key` fallback in `setPortalAuthHeaders`) **(XS) {frontend}**
- [ ] **S16** Add per-account login lockout + anomaly counter on `/api/owner/login` and `/admin-auth` **(M) {backend}**

### B.2 Plan / feature enforcement

- [ ] Wire `incFeatureDeniedByPlan` into the actual SMS / calendar / recording paths in voice runtime; gate behavior by `usageLimits.features` **(M) {runtime}** → §7 finding 3
- [ ] Surface "Plan limits" read-only panel in portal (current caps + included minutes + overage mode) **(S) {frontend}** → §6

### B.3 Operations visibility

- [ ] Add admin **Incidents** tab + lightweight `incidents` table fed by existing metric counters **(M) {backend, frontend}** → §11 Sprint 4
- [ ] Add admin **Live calls** tile (capacity Lua counters + per-tenant breakdown) **(S) {backend, frontend}** → §11
- [ ] Add admin **Webhook errors** feed (last 50, grouped by reason) **(S) {backend, frontend}** → §11
- [ ] Add **Integrations** status chips in portal (calendar / CRM / SMTP / Stripe) **(M) {backend, frontend}** → §11

### B.4 Client-portal polish

- [ ] Add **Voice audio preview** button next to TTS picker in portal (`/api/tts/preview/async`) **(S) {frontend}** → §11
- [ ] Add **Tone preset** chips that prepend boilerplate to systemPreamble (friendly / formal / concierge) **(XS) {frontend}** → §11
- [ ] Add **Notification recipients** editor in portal (who gets SMS / email when a lead arrives) **(S) {frontend, backend}** → §11
- [ ] Add **Export call summaries** (CSV/PDF) in portal Calls **(S) {backend, frontend}** → §8
- [ ] Add **FAQ knowledge base** (long-form) editor; flow into `assistantContext` **(M) {backend, runtime, frontend}** → §8
- [ ] Add **SMS verification** when client adds a forwarding/escalation number **(M) {backend, frontend}** → §8

### B.5 Three-UI consolidation

- [ ] Decide whether `owner.html` is deleted, kept as internal-only, or merged into a "tenant operator" tab in `admin.html`; document the decision **(M) {product}**
- [ ] Move Telnyx number search/purchase out of `owner.html` into the admin Tenant strip (or a dedicated admin Telephony tab) **(M) {frontend}**

---

## C. Can wait until GA (release gate: P2)

These improve the product but are not required to unblock pilot #1–#3.

- [ ] Live "current call(s)" view + hot-transfer button in admin Overview (placeholders exist today) **(M) {backend, frontend}**
- [ ] "Handoff to human" flow with explicit transfer endpoint + UI **(L) {runtime, backend, frontend}**
- [ ] Webhook signing-secret rotation UI for admin **(M) {backend, frontend}**
- [ ] Per-tenant branding (logo / primary color) upload **(M) {backend, frontend}**
- [ ] Configurable fallback message in portal (today only env) **(XS) {backend, frontend}**
- [ ] Admin sub-tab for STT mode / Whisper URL / silence thresholds (today env-only) **(M) {backend, frontend}**
- [ ] Audit log export (CSV) and search filters in admin **(S) {backend, frontend}**
- [ ] Periodic admin-key rotation + secret-provenance check **(M) {backend, ops}** → `SECURITY_POSTURE.md`
- [ ] Centralize control-plane log redaction (still partial) **(M) {backend}** → `SECURITY_POSTURE.md`
- [ ] Move portal auth to httpOnly cookie + CSRF token **(M) {backend, frontend}** → §9 S17
- [ ] Document `dev-console.html` as internal only and exclude from production image, or wire branding **(XS) {ops}**
- [ ] Drop unused `tenant_api_keys` table or wire it for per-tenant API access **(S) {backend, db}**

---

## D. Enterprise later (release gate: P3)

Not on the SMB pilot critical path; required before enterprise SOW commitments.

- [ ] OAuth flows for Google Calendar, Outlook, HubSpot/Salesforce/Pipedrive **(L) {backend, frontend}**
- [ ] SOC2 / HIPAA evidence collection workstream **(L) {ops, security}**
- [ ] Multi-region / Redis HA architecture **(L) {ops, runtime}**
- [ ] Cross-provider automatic STT/TTS/LLM failover (currently partial) **(L) {runtime}**
- [ ] Third-party penetration test of multi-tenant isolation **(M) {security}** → `PLAN_LIMITS.md`
- [ ] Per-tenant SLA dashboards (uptime, P95 first-token, P95 STT) **(L) {observability, frontend}**
- [ ] Workflow CRUD UI exposed to clients with `ownerCanEdit=true` (today the table renders but no editor in portal) **(M) {frontend}**
- [ ] Branded white-label CSS variables driven by `/api/branding` **(M) {frontend}** → `CUSTOMER_CONFIG_SURFACE.md` Phase E/F
- [ ] Bulk DID import + multi-location routing UX **(L) {backend, frontend}**
- [ ] Compliance-grade transcript retention controls (retention policy editor, redaction rules) **(L) {backend, runtime, frontend}**

---

## Acceptance criterion for "pilot-ready"

Section A is fully checked **and** the existing `PILOT_ACCEPTANCE_TEST_PLAN.md` matrix passes against the upgraded panels (in particular: tenant-isolation probes do not succeed; missed-calls inbox shows expected entries; transcripts viewer renders; usage tile updates after a test call).
