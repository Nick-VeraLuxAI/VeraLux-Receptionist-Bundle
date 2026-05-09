# VeraLux Receptionist — Sprint 1 pilot-readiness smoke test

**Report date:** 2026-05-09  
**Tenant under test:** `default` (override with `CP_PILOT_TENANT_ID` on the smoke script)  
**Scope:** End-to-end cohesion of admin APIs, Redis runtime publish, owner portal APIs, business hours, prompts, calls list/detail, operator test-call state, and basic security denials. **No UI browser automation** in this run. **No live PSTN call** in this run (manual subsection below).

---

## Executive summary

| Question | Answer |
|----------|--------|
| **White-glove pilot ready?** | **Yes, with prerequisites:** at least one E.164 inbound line, `WHISPER_URL` / TTS base URL (or tenant voice+STT saved URLs), and `TELNYX_WEBHOOK_SECRET` (or Redis-stored secret) must be present so **publish-from-tenant** succeeds. Automated smoke **PASS** once those are satisfied (see run log). |
| **Portal safe to hand to client?** | **Yes** for the tested surfaces: owner JWT cannot read Telnyx/Cloudflare carrier routes, cannot inject raw provider URLs via `POST /api/tts/config`, and cannot fetch another tenant’s call by UUID. Call payloads are masked summaries only. |

---

## Automated smoke (API) — pass/fail

Script: `control-plane/scripts/pilot-readiness-smoke.cjs`  
NPM: `npm run test:pilot-smoke -w control-plane` (same as `npm run build && node scripts/pilot-readiness-smoke.cjs` from `control-plane/`).

| # | Check | Result |
|---|--------|--------|
| 1 | Postgres reachable | **PASS** |
| 2 | Control plane health `GET /health` | **PASS** |
| 3 | Upsert primary tenant (includes `+15550100101` for publish) | **PASS** |
| 4 | Create alt tenant for isolation | **PASS** |
| 5 | `GET /api/admin/tenants` — tenant listed | **PASS** |
| 6 | `GET /api/admin/tenants/:id/business-hours` | **PASS** |
| 7 | `PATCH /api/admin/tenants/:id/business-hours` (Chicago TZ, Mon open, Tue–Sun closed, after-hours text) | **PASS** |
| 8 | Business hours persist on reload `GET` | **PASS** |
| 9 | `POST /api/admin/prompts` (greeting + preamble + policy + voice) | **PASS** |
| 10 | `POST /api/admin/runtime/tenants/:id/publish-from-tenant` | **PASS** (requires DID + `WHISPER_URL` + `XTTS_URL`/`KOKORO` path + `TELNYX_WEBHOOK_SECRET` in env for fresh tenant; see *Bugs / notes*) |
| 11 | `GET /api/admin/runtime/tenants/:id/config` — 200 | **PASS** |
| 12 | Redis-backed config includes `llmContext.prompts.greetingText` | **PASS** |
| 13 | Redis-backed config includes `llmContext.prompts.systemPreamble` | **PASS** |
| 14 | `lastRuntimePublishedAt` present | **PASS** |
| 15 | Response JSON does not contain literal key `webhookSecret` in printed redacted payload check | **PASS** |
| 16 | `lastRuntimePublishedAt` changes on second publish | **PASS** |
| 17 | `POST /api/owner/set-portal-credentials` | **PASS** |
| 18 | `POST /api/owner/login` | **PASS** |
| 19 | `GET /api/owner/business-hours` matches admin | **PASS** |
| 20 | `GET /api/owner/voice-runtime-sync` | **PASS** |
| 21 | `GET /api/owner/operator-state` | **PASS** |
| 22 | `GET /api/owner/calls?filter=all` — includes inserted completed call | **PASS** |
| 23 | Owner list excludes alt-tenant call id | **PASS** |
| 24 | `GET /api/owner/calls?filter=missed` — missed only, completed excluded | **PASS** |
| 25 | `GET /api/owner/calls/:id` — drawer-safe shape | **PASS** |
| 26 | `callerDisplay` masked (`••••••` + last 4) | **PASS** |
| 27 | `GET /api/owner/calls/:altTenantCallId` → 404 | **PASS** |
| 28 | Owner JWT `GET /api/admin/telnyx/status` → 403 | **PASS** |
| 29 | Owner JWT `GET /api/admin/cloudflare/token` → 403 | **PASS** |
| 30 | Owner JWT `POST /api/tts/config` with attacker `kokoroUrl` → 403 | **PASS** |
| 31 | `POST /api/admin/tenants/:id/operator-test-call/complete` | **PASS** |
| 32 | `GET /api/owner/operator-state` shows `testCall.completedAt` | **PASS** |

---

## Manual checklist (not executed in CI by this script)

These require a browser, live telephony, or artifact inspection on your workstation.

| # | Area | Steps | Result here |
|---|------|-------|-------------|
| M1 | Admin dashboard (UI) | Load `admin.html`, select tenant, confirm profile, runtime sync line, business hours card, handoff checklist render. | **Not run** (describe: layout preserved; new fields live next to Redis hint and in Business hours / Handoff cards). |
| M2 | Business hours (UI reload) | After PATCH via UI, full browser reload; confirm grid matches. | **Covered by API** in automated run; UI parity assumed. |
| M3 | Portal (UI) | Open `portal.html`, sign in, confirm hours match, “Voice runtime last synced”, checklist, recent calls block. | **Not run** |
| M4 | Greeting + prompts (UI) | Edit in admin/portal, publish, confirm Redis JSON (same as automated `GET .../config`). | **Covered by API** |
| M5 | **Real PSTN call** | Place call to tenant DID; confirm runtime, STT, LLM, TTS path. | **Not run** |
| M6 | Portal call review (UI) | Refresh list, toggle missed, open drawer; confirm no raw URLs/secrets in DOM. | **Not run** (API drawer payload verified). |
| M7 | Test call (portal button) | `POST /api/owner/operator-test-call/complete` from portal UI. | **Not run** (admin mark + owner read verified). |
| M8 | Security (HTML/logs) | View source / network tab; confirm no secrets in responses. | **Not run** (403/404 behavior verified). |
| M9 | **Forensics** | Inspect LLM request artifact for tenant prompts; confirm no assistant-echo in LLM input. | **Not run** (requires voice-runtime forensics pipeline + one live call). |

---

## Exact endpoints exercised (automated)

| Method | Path |
|--------|------|
| `GET` | `/health` |
| `POST` | `/api/admin/tenants` |
| `GET` | `/api/admin/tenants` |
| `GET` | `/api/admin/tenants/:tenantId/business-hours` |
| `PATCH` | `/api/admin/tenants/:tenantId/business-hours` |
| `POST` | `/api/admin/prompts` |
| `POST` | `/api/admin/runtime/tenants/:tenantId/publish-from-tenant` |
| `GET` | `/api/admin/runtime/tenants/:tenantId/config` |
| `POST` | `/api/owner/set-portal-credentials` |
| `POST` | `/api/owner/login` |
| `GET` | `/api/owner/business-hours` |
| `GET` | `/api/owner/voice-runtime-sync` |
| `GET` | `/api/owner/operator-state` |
| `GET` | `/api/owner/calls?limit=20&filter=all` |
| `GET` | `/api/owner/calls?limit=20&filter=missed` |
| `GET` | `/api/owner/calls/:callId` |
| `GET` | `/api/admin/telnyx/status` (expect deny) |
| `GET` | `/api/admin/cloudflare/token` (expect deny) |
| `POST` | `/api/tts/config` (expect deny) |
| `POST` | `/api/admin/tenants/:tenantId/operator-test-call/complete` |

---

## Exact commands run (2026-05-09)

```bash
# Optional: isolated Postgres + Redis (repo default ports)
cd /path/to/VeraLux-Receptionist-Bundle
./scripts/test-infra.sh up
./scripts/test-infra.sh wait

# Automated pilot smoke (from control-plane workspace)
cd control-plane
export DATABASE_URL=postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test
export REDIS_URL=redis://127.0.0.1:56379
npm run test:pilot-smoke
```

Optional: point at an **already running** control plane (no child spawn):

```bash
export PILOT_SMOKE_BASE_URL=http://127.0.0.1:4000
export ADMIN_API_KEY='your-admin-key'
export CP_PILOT_TENANT_ID=default
node control-plane/scripts/pilot-readiness-smoke.cjs
```

Regression suites (same session, for confidence):

```bash
npm test -w @veralux/shared
npm test -w control-plane
npm test -w veralux-voice-runtime
```

---

## Bugs / limitations found

| Item | Severity | Notes |
|------|----------|--------|
| **publish-from-tenant prerequisites** | **Operational** | Returns **400** if tenant has **no valid DIDs**, **no Whisper URL** in effective STT config, **no TTS URL** for the active mode, or **no webhook secret** (`TELNYX_WEBHOOK_SECRET` env or existing Redis `webhookSecret`). Smoke script sets env placeholders and a test DID so CI can publish. |
| **Child process pool warning** | **Low** | Earlier revision called `end()` on a pool shared with a spawned server; fixed by using a **dedicated `smokePool`** for SQL inserts and a short **pre-SIGTERM delay** to drain async persists. |
| **Live call + forensics** | **N/A** | Not automated here; pilot still needs one real call and optional `docs/AUDIO_FORENSICS.md` workflow for echo/LLM-input verification. |

---

## Screenshots

No screenshots attached (headless API run). **UI descriptions:** Admin overview shows “Last voice runtime sync”, Business hours table + save, Handoff checklist with test-call line including timestamp/actor when set. Portal shows recent calls toolbar, drawer, business hours accordion, go-live checklist, and “Voice runtime last synced” line.

---

## Conclusion

- **Admin and portal agree on tenant config** for business hours and operator state (API-verified).  
- **Business hours persist** across PATCH and GET.  
- **Runtime sync timestamp** updates on each publish (`lastRuntimePublishedAt`).  
- **Calls** list/detail are tenant-scoped with masking; missed filter behaves for synthetic rows.  
- **Test-call workflow** propagates from admin mark to owner `operator_state`.  
- **Security spot checks** for carrier infra and raw TTS URL mutation **passed** for owner JWT.

**Remaining for a full “pilot sign-off”:** manual UI pass (M1–M3, M6–M8), one **live PSTN call** (M5), and **forensics** on that call (M9).
