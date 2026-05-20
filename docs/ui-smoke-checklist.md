# VeraLux Receptionist — UI live smoke runbook

Post–UI-stabilization checklist for **browser verification** of `/portal`, `/admin`, and `/owner`.

This complements API smokes (`control-plane/scripts/pilot-readiness-smoke.cjs`, `npm run test:pilot-smoke`) which do **not** exercise rendered HTML or client-visible copy.

---

## 0. Existing test infrastructure (inventory)

| Tool | Present? | Notes |
|------|----------|--------|
| **Playwright** | No | Not in repo |
| **Cypress** | No | Not in repo |
| **Vitest browser** | No | `node --test` only (unit/integration) |
| **API pilot smoke** | Yes | `control-plane/scripts/pilot-readiness-smoke.cjs` — portal login via API, not DOM |
| **Stage 1/2 bash smokes** | Yes | Auth/tenant API (`test:stage1`, `test:stage2`) |
| **Voice/runtime smokes** | Yes | `veralux-voice-runtime/scripts/*` |
| **UI HTML fetch smoke** | Yes (this pass) | `control-plane/scripts/ui-smoke-html.cjs` — structural + copy guard (no browser) |

**No seeded “demo login” in `.env`.** Portal credentials are per-tenant in Postgres (`owner_portal_credentials`), set from admin Overview or API.

---

## 1. Prerequisites

### Stack running

```bash
# From repo root (production-like)
./deploy.sh build control
# recreate control — see deploy.sh / prior session notes
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/ready   # expect 200
```

Or local dev:

```bash
cd control-plane && npm run dev:server
# Postgres + Redis must match DATABASE_URL / REDIS_URL in control-plane/.env
```

### Base URL

| Variable | Default |
|----------|---------|
| `UI_SMOKE_BASE_URL` | `http://localhost:4000` |
| `CONTROL_PORT` in `.env` | `4000` |

### Portal test credentials

**Option A — Admin sets credentials (recommended for manual demo)**

1. Open `/admin` with `ADMIN_API_KEY` or admin JWT.
2. Select tenant (e.g. `default`).
3. Overview → **Owner portal** handoff: set email + password (≥ 8 chars).
4. Use those on `/portal`.

**Option B — API (matches pilot smoke)**

```bash
export ADMIN_API_KEY="<from .env>"
export TENANT_ID=default
export PORTAL_EMAIL="demo@yourbusiness.test"
export PORTAL_PASSWORD="DemoPortal!234567"

curl -s -X POST "$UI_SMOKE_BASE_URL/api/owner/set-portal-credentials" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"email\":\"$PORTAL_EMAIL\",\"password\":\"$PORTAL_PASSWORD\"}"
```

**Option C — Pilot smoke creates ephemeral credentials**

```bash
cd control-plane
DATABASE_URL=... REDIS_URL=... ADMIN_API_KEY=... PILOT_SMOKE_BASE_URL=http://127.0.0.1:4000 npm run test:pilot-smoke
# Note the printed email/password from smoke output if you need to log in manually.
```

### Admin access

- **API key:** `ADMIN_API_KEY` from `.env` (modal on `/admin` if unauthenticated).
- **JWT:** Bearer token if `ADMIN_AUTH_MODE` is JWT-only in your env.

### Owner access

- Same **admin API key** in the owner unlock modal (`#owner-pass-input`) — not portal email/password.

---

## 2. Automated pre-check (optional, no browser)

Structural checks + portal default copy guard (excludes **Advanced voice settings** `<details>` and `<script>` blocks):

```bash
cd control-plane
# Against running control plane (must match latest image — rebuild if stale):
UI_SMOKE_BASE_URL=http://localhost:4000 npm run test:ui-smoke-html

# Against workspace HTML only (no server; verifies repo files):
UI_SMOKE_READ_LOCAL=1 npm run test:ui-smoke-html
```

Pass = HTML served (or local files), critical IDs present, no forbidden terms in portal **default** HTML slice.  
**Does not replace** the manual browser steps below (login, accordions, hash tabs, collapsed state).

If live fetch fails but `UI_SMOKE_READ_LOCAL=1` passes, rebuild and recreate the control-plane container (`./deploy.sh build control`).

---

## 3. Portal smoke (client-facing) — **run first**

**URL:** `{BASE}/portal` or `{BASE}/portal.html`

### 3.1 Login (unauthenticated)

| # | Step | Pass criteria |
|---|------|----------------|
| P1 | Open `/portal` | Login card visible; no dashboard |
| P2 | Branding | Logo and/or “Manage your AI receptionist” / branded tagline; header not broken |
| P3 | `veralux-shell.css` | Network tab: `/veralux-shell.css` 200 (optional) |
| P4 | Client copy scan (login + page source before login) | View source: no `Redis`, `voice runtime`, `OPENAI_API_KEY` in visible login block |
| P5 | No admin link | Page has no link to `/admin` |

### 3.2 Authenticated dashboard

| # | Step | Pass criteria |
|---|------|----------------|
| P6 | Log in | Email/password → dashboard (`#dashboard` visible, `#login-screen` hidden) |
| P7 | Overview | Business name, stat cards (calls, messages, contacts, services), “Last updated for live calls” line (not “voice runtime”) |
| P8 | Live sidebar | “At a glance” panel shows greeting/transfers preview |
| P9 | Accordions visible | Greeting & tone, Business hours, Transfer, Services & pricing, Quick replies, Voice & tone on calls, Leads, (Billing if enabled) |

### 3.3 Client-safety (default UI only)

**Do not expand “Advanced voice settings”.**

| # | Check | Pass |
|---|--------|------|
| P10 | Visible page text (scan main column) | No Redis, voice runtime, OPENAI_API_KEY |
| P11 | | No `/api/` shown as user-facing copy |
| P12 | Voice section default | Voice profile / language / speaking speed / **Save voice settings** |
| P13 | Advanced collapsed | `#portal-tts-advanced-block` closed; summary “Advanced voice settings” |
| P14 | Quick replies copy | “Save quick replies” (not “Save to voice runtime”) |

*If P10–P11 fail only after opening Advanced voice, that is acceptable (support tier).*

### 3.4 Section smoke (no Stripe/Telnyx)

| # | Section | Action | Pass |
|---|---------|--------|------|
| P15 | Greeting & tone | Edit greeting → **Save to receptionist** | Status/help updates; live preview updates |
| P16 | Business hours | Change timezone or one row → **Save business hours** | No JS error; message OK |
| P17 | Transfer | Add name + E.164 number → **Add contact** | List updates (auto-saves; no separate Save button) |
| P18 | Pricing | Add line item → **Save pricing** | List persists after refresh |
| P19 | Quick replies | **Add intent** or reload | Section renders; save does not throw |
| P20 | Voice | Change speed or voice if shown → **Save voice settings** | `#portal-tts-status` message (not Redis error) |
| P21 | Billing | If `#billing-section` visible | Section renders; **Pay now** / manage opens Stripe or shows config message — no white screen |
| P22 | Billing hidden | If section `display:none` | Rest of portal still works |

### 3.5 Sign out

| # | Step | Pass |
|---|------|------|
| P23 | **Sign out** (`#logout-btn`) | Returns to login; `localStorage` portal_token cleared (Application tab) |
| P24 | Back button | Cannot access dashboard without login |

---

## 4. Admin smoke (operator-only)

**URL:** `{BASE}/admin`

| # | Step | Pass criteria |
|---|------|----------------|
| A1 | Load `/admin` | Neural console shell; auth modal or authenticated shell |
| A2 | Default tab | **Overview** active (`data-tab="overview"`) |
| A3 | Hash: `/admin#calls` | Call log tab active; `#calls` content visible |
| A4 | Hash: `/admin#billing` | Billing tab active |
| A5 | Hash: `/admin#settings` | Settings tab active |
| A6 | Build stamp | `#vlx-admin-build-stamp` **hidden** on normal load |
| A7 | Debug stamp | `/admin#debug` or `?debug=1` → stamp visible (`body.admin-debug-mode`) |
| A8 | Tenant selector | `#tenant-select` present and populated after auth |
| A9 | Call log | Table/list area in calls tab renders (empty OK) |
| A10 | Settings | Settings tab forms render |
| A11 | Audit | Audit tab renders |
| A12 | Intervention controls | “Coming soon” alert; Take over / Pause AI buttons **disabled** (`disabled`, `tabindex="-1"`) — not primary CTAs |

Operator terminology (voice runtime, Redis in copy) on admin is **expected**.

---

## 5. Owner smoke (internal-only)

**URL:** `{BASE}/owner`

| # | Step | Pass criteria |
|---|------|----------------|
| O1 | Load `/owner` | Page loads |
| O2 | Internal banner | Gold banner: “Internal setup tool — VeraLux implementers only” (or branded equivalent) |
| O3 | Portal pointer | Copy directs clients to **Business Portal** (`/portal`) |
| O4 | Not client-primary | Single-column setup layout; banner above business line |
| O5 | Admin link | Footer references ops console for **VeraLux team only** — not “Open full admin dashboard” as client CTA |
| O6 | Telnyx / line setup | “Your business line” / find numbers / provision UI renders |
| O7 | Unlock modal | Access token modal works with `ADMIN_API_KEY` |
| O8 | Status pill | Does not show “DB & Redis down” (should be “Service temporarily unavailable” if unhealthy) |

Full TTS engine names on owner are **OK** (internal surface).

---

## 6. Regression quick reference (element IDs)

Must exist **once** on portal (grep / DevTools):

`login-email`, `login-btn`, `logout-btn`, `save-prompts`, `portal-bh-save`, `portal-qr-save`, `save-portal-tts`, `portal-tts-status`, `price-save`, `fp-add`, `billing-section` (may be hidden)

Admin: `tenant-select`, `vlx-admin-build-stamp`, tabs `overview`, `calls`, `billing`, `settings`, `audit`

Owner: `vlx-owner-internal-banner-title`, `telnyx-get-number`, `owner-pass-confirm`

---

## 7. Demo & pilot readiness (after smoke)

| Audience | Ready when |
|----------|------------|
| **Guided SMB demo** | Portal P1–P24 pass; use `/portal` only; do not open Advanced voice |
| **Paying pilot (portal self-serve)** | Above + stable credentials + support path; billing optional |
| **Owner URL to clients** | **No** — internal only |
| **Admin URL to clients** | **No** |

---

## 8. Troubleshooting

| Symptom | Check |
|---------|--------|
| Portal 401 after login | `ADMIN_JWT_SECRET` / owner credentials; tenant active |
| Stale UI | Rebuild control image + hard refresh (Ctrl+Shift+R) |
| Footer missing on portal | `BRAND_PORTAL_FOOTER_DISABLED` / `apply-branding.js` hiding empty footer |
| Billing hidden | No subscription in DB — expected |
| `test:ui-smoke-html` fails on Coqui | Script may need advanced-block strip — run manual P10–P14 |

---

## 9. Related docs

- `docs/PANEL_CONTROL_SURFACE_AUDIT.md` — API/panel map (pre–UI pass; some portal gaps since fixed)
- `docs/PILOT_READINESS_SMOKE_TEST_REPORT.md` — API pilot smoke
- `control-plane/scripts/pilot-readiness-smoke.cjs` — automated API + portal login

**Last updated:** UI stabilization pass (portal/owner shell + admin neural console).
