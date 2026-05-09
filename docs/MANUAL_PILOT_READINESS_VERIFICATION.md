# Manual pilot readiness verification — VeraLux Receptionist (Sprint 1)

| Field | Value |
| --- | --- |
| **Date** | 2026-05-09 (initial probes) · **2026-05-09 follow-up** (operator evidence sweep) |
| **Scope** | Post–Sprint 1 pilot gate: browser + portal + runtime + (intended) live PSTN + forensics |
| **Targets** | Admin: `https://admin.veraluxclients.com/admin` · Portal: `https://admin.veraluxclients.com/portal` (canonical; `…/portal.html` → **301** → `/portal`) · Runtime: `https://voice.veralux.ai` |
| **Verifier** | Automated HTTP probes + **local** Docker forensics sample (§5.1). **Follow-up:** no browser screenshots, HAR excerpts, call notes, or **production** forensics bundle were added to this repo or Appendix A at sweep time — manual items stay **Pending** per “do not invent evidence.” |

---

## Operator evidence checklist (required to flip any row to PASS)

**Status after follow-up sweep:** **No operator-supplied artifacts** were found in `docs/MANUAL_PILOT_READINESS_VERIFICATION.md` Appendix A, no pasted notes in-repo, and no new files under `docs/` capturing your browser/phone run. Therefore every row below remains **Pending**. To complete verification, add **non-secret** proof (screenshot description, HTTP status + redacted response snippet, `call_control_id`, path to forensics bundle under your ops storage, etc.).

| Item | Result | Evidence still needed (examples) |
| --- | --- | --- |
| **Admin login** | **Pending** | Screenshot of successful admin modal / session **or** redacted Network line showing `GET /api/admin/tenants` **200** after `X-Admin-Key` / JWT |
| **Tenant load** | **Pending** | Screenshot of tenant dropdown populated **or** redacted `GET /api/admin/tenants` **200** JSON shape (`tenants` array) |
| **Business hours save** | **Pending** | Redacted `PUT`/`PATCH` (actual verb from Network) to business-hours endpoint with **2xx** + follow-up `GET` showing saved hours **or** UI “saved” state + matching request id |
| **Portal login** | **Pending** | Screenshot post-login **or** redacted `POST /api/owner/login` **200** with `success: true` (no token body pasted) |
| **Portal hours parity** | **Pending** | Side-by-side notes or screenshots: admin hours vs portal hours same tenant (no PII beyond business name if needed) |
| **Live PSTN call** | **Pending** | Timestamp (UTC), tenant id, `call_control_id`, outcome notes (greeting/hearsay OK or not) — **no** signing secrets |
| **Greeting / prompt behavior** | **Pending** | Qualitative call notes aligned to expected greeting + one policy/hours-dependent turn **or** redacted runtime log line referencing tenant config version |
| **Portal recent calls + drawer** | **Pending** | Screenshot of Calls list including the PSTN row **or** redacted `GET /api/admin/calls` **200** with that call id + drawer open screenshot |
| **Production forensics** | **Pending** | Path or ticket link to **production** `voice.veralux.ai` forensics session (not local Docker); `analysis/summary.md` excerpt showing 005/007/009 counts **or** equivalent |
| **Test-call checklist** | **Pending** | Screenshot after “Mark test call completed” in admin **and** portal checklist delta **or** redacted API **2xx** for the completion endpoint |

---

## Executive summary

- **Reachability / liveness (automated, still Pass):** Admin HTML, control-plane `/health` and `/ready`, and voice runtime `/health` + `/health/voice` respond successfully on public URLs; sampled health JSON showed no credential-like fields.
- **Authenticated admin + portal + PSTN + production Redis + production forensics:** **No new evidence** was recorded in this document after the operator’s intended browser/phone steps — all such checks remain **Pending** (see table above). Nothing below is upgraded to **Pass** on that basis.
- **Forensics (§5.1 only):** The **local Docker** reference session analysis remains the only forensics evidence in-repo; it does **not** prove production `voice.veralux.ai` behavior.
- **Product checklist:** `docs/PANEL_CLIENT_READINESS_CHECKLIST.md` P0 items remain open for **client self-serve** gating.

---

## Pass / fail matrix (this verification pass)

Legend: **Pass** = verified this run · **Pending** = requires operator / secrets / PSTN · **N/A** = not applicable without prior Pass · **Fail** = objective automated failure

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| **A** | Admin URL returns 200 HTML | **Pass** | `GET /admin` → 200; build marker `8427234` present in HTML |
| **A** | Portal URL reachable | **Pass** | `GET /portal.html` → **301** → `/portal` → **200** |
| **A** | Control plane `/health` + `/ready` | **Pass** | Both 200 on `admin.veraluxclients.com` |
| **A** | Runtime `/health` + `/health/voice` | **Pass** | `voice.veralux.ai` returns JSON with `status":"ok"` and dependency checks |
| **1** | Admin browser flow (full) | **Pending** | No post-login screenshots / redacted Network proof in Appendix A |
| **2** | Portal browser flow (full) | **Pending** | Same |
| **3** | Runtime config in **production** Redis | **Pending** | No redacted config dump or `redis-cli` transcript attached |
| **4** | Live PSTN call | **Pending** | No call timestamp + `call_control_id` + outcome notes in appendix |
| **5** | Forensics on **production** call | **Pending** | Only §5.1 local Docker; no production bundle reference |
| **6** | Test call completed → checklists | **Pending** | No completion screenshot or API proof |

---

## 1. Admin browser flow

| Step | Result | Notes / evidence |
| --- | --- | --- |
| Admin loads | **Pending** | Static shell loads (HTTP 200); full SPA behavior needs login |
| Tenant dropdown loads | **Pending** | |
| Business profile loads | **Pending** | |
| Business hours card loads | **Pending** | |
| Runtime sync timestamp displays | **Pending** | |
| Handoff checklist displays | **Pending** | |
| Save/update business hours | **Pending** | |
| Save/update greeting and prompt | **Pending** | |
| Publish/sync tenant config | **Pending** | |
| No console errors | **Pending** | Operator: DevTools → Console + Network, attach screenshot to appendix |

**Operator procedure:** Log in with deployment `ADMIN_API_KEY` (or JWT per env), walk the Overview + Models & Prompts + hours + **Sync this business to voice runtime / Publish** paths, export HAR only after redacting secrets.

---

## 2. Portal browser flow

| Step | Result | Notes / evidence |
| --- | --- | --- |
| Owner login works | **Pending** | |
| Portal loads correct tenant | **Pending** | |
| Business hours match admin | **Pending** | |
| Voice runtime last synced displays | **Pending** | |
| Go-live checklist displays | **Pending** | |
| Recent calls section renders | **Pending** | |
| Missed call filter works | **Pending** | |
| Call drawer opens for an allowed call | **Pending** | |
| No raw provider URLs / internal hostnames in UI | **Pending** | Spot-check DOM + Network JSON bodies |
| No secrets in HTML/network | **Pending** | Confirm no `sk-`, bearer tokens, webhook secrets in responses saved to HAR |

**Canonical portal URL:** `https://admin.veraluxclients.com/portal` (avoid bookmarking only `portal.html` if you rely on a single hop).

---

## 3. Runtime config verification (production)

| Step | Result | Notes |
| --- | --- | --- |
| Redis/runtime tenant blob contains `greetingText`, prompts, business hours, `lastRuntimePublishedAt` | **Pending** | Requires `redis-cli` / admin “runtime config” API against **production** control plane + Redis |
| Owner-facing responses omit `webhookSecret` and raw provider secrets | **Pending** | Spot-check `GET` portal/control-plane responses under owner JWT |

**Safe alternative (operator):** From admin UI after auth, use runtime Redis hint + “Force health pull” / config inspect paths your runbook documents — paste **redacted** JSON keys only into appendix.

---

## 4. Live PSTN call

| Step | Result | Notes |
| --- | --- | --- |
| One real call placed | **Pending** | |
| Greeting matches tenant | **Pending** | |
| Business-hours–dependent answer | **Pending** | |
| Call logged (control plane / analytics) | **Pending** | |
| Portal recent calls updates | **Pending** | |
| Transcript / summary drawer | **Pending** | |

**Operator:** Record call time + `call_control_id` (from admin Calls or runtime logs) in appendix — **do not** paste webhook signing secrets or raw Telnyx payloads.

---

## 5. Forensics verification

### 5.1 Local reference session (automated slice)

**Important:** This is **not** a capture from `https://voice.veralux.ai`. It is the **newest** session under the developer machine’s Docker container `veralux-runtime` (`AUDIO_FORENSICS_ENABLED=true`, `AUDIO_FORENSICS_DIR=/app/audio/forensics`), copied to `/tmp/vlx-pilot-forensics/session` and analyzed with:

```bash
./scripts/analyze-audio-forensics.sh /tmp/vlx-pilot-forensics/session
```

| Artifact / criterion | Result | Evidence |
| --- | --- | --- |
| `005_whisper_request` exists | **Pass** | `summary.md`: count **1** |
| `007_normalized_transcript` exists | **Pass** | count **1** |
| `009_llm_request` / `009_transcript_to_llm` | **Pass** | counts **1** each |
| LLM input clean caller text | **Pending** (manual read) | `transcript_comparison.md` / `009_*` files contain **PII** — reviewer opens locally, not pasted here |
| Tenant prompt/context in LLM request | **Pending** | Same |
| No assistant echo to LLM (heuristic) | **Pass** (sample) | “**none flagged**” echo similarity; no `008 assistant_echo` policy rows called out in summary |
| TTS / playback artifacts | **Pass** | `012_tts_raw`: **4**; `013_telnyx_playback`: **4**; `014_playback_events`: **4** |

### 5.2 Production voice forensics

| Step | Result |
| --- | --- |
| Enable / collect forensics on **voice.veralux.ai** tenant, run `scripts/run-voice-test-call.sh` or ops copy path | **Pending** |

See `docs/AUDIO_FORENSICS.md` for enablement guards (`ALLOW_PROD_DEBUG_CAPTURE`, etc.).

---

## 6. Test call state (checklists)

| Step | Result | Notes |
| --- | --- | --- |
| Mark test call completed (admin or portal) | **Pending** | |
| Checklist updates in admin + portal | **Pending** | |

---

## Console / network errors (this run)

- **Automated:** No browser session — **n/a**.
- **Operator:** Append findings to **Appendix A** (screenshots + 1–2 sentence summary per surface).

---

## Remaining blockers (product / engineering, not just this doc)

High-signal items still open per `docs/PANEL_CLIENT_READINESS_CHECKLIST.md` (P0): cross-tenant / guardrail fixes, runtime prompt wiring (`llmContext` / greeting in call path), portal calls/transcript/missed-call/health tiles, raw URL scrubbing in portal, Cloudflare token handling hardening, Telnyx admin route guards, etc. Treat that file as the **authoritative gate** until items are checked off for self-serve.

---

## Final verdict

| Question | Verdict | Rationale |
| --- | --- | --- |
| **White-glove pilot ready?** | **No** | Automated liveness + §5.1 local forensics only. **None** of the operator checklist rows (admin/portal login, saves, PSTN, production forensics, test-call checklist) have **Pass**-grade evidence attached to this report, so the pilot gate is **not** closed in documentation. |
| **Client self-serve ready?** | **No** | Same evidence gap **plus** open P0 items in `docs/PANEL_CLIENT_READINESS_CHECKLIST.md` (unchanged engineering gate). |

---

## Appendix A — Operator attachments (fill in)

**Follow-up sweep (2026-05-09):** _Empty — no attachments received._

When you complete the browser/phone steps, paste **redacted** notes or relative paths below (no secrets, no bearer tokens, no `sk-` keys).

1. **Admin login:** _Pending — e.g. “`GET /api/admin/tenants` 200 at …Z” + screenshot of Overview._  
2. **Tenant load:** _Pending — screenshot of dropdown or redacted tenants payload._  
3. **Business hours save:** _Pending — save response 2xx + GET confirmation._  
4. **Portal login:** _Pending — screenshot or “`POST /api/owner/login` 200, success true”._  
5. **Portal hours parity:** _Pending — short table admin vs portal hours._  
6. **Live PSTN:** _Pending — UTC time, tenant id, `call_control_id`, greeting/hours behavior notes._  
7. **Portal calls + drawer:** _Pending — screenshot or redacted calls API row + drawer._  
8. **Production forensics:** _Pending — e.g. “S3/internal path … / ticket …” + `summary.md` excerpt (counts only)._  
9. **Test call checklist:** _Pending — before/after screenshots admin + portal._  

---

## Appendix B — Commands used (safe, no secret output)

```bash
# Reachability
curl -sS -o /dev/null -w '%{http_code}\n' 'https://admin.veraluxclients.com/admin'
curl -sSIL 'https://admin.veraluxclients.com/portal.html'   # observe 301 → /portal
curl -sS -o /dev/null -w '%{http_code}\n' -L 'https://admin.veraluxclients.com/portal.html'
curl -sS -o /dev/null -w '%{http_code}\n' 'https://admin.veraluxclients.com/health'
curl -sS -o /dev/null -w '%{http_code}\n' 'https://admin.veraluxclients.com/ready'
curl -sS 'https://voice.veralux.ai/health'
curl -sS 'https://voice.veralux.ai/health/voice'

# Optional: API-layer smoke (local control-plane with DB/Redis), from repo:
# cd control-plane && npm run build && DATABASE_URL=... REDIS_URL=... ADMIN_API_KEY=... node scripts/pilot-readiness-smoke.cjs
```
