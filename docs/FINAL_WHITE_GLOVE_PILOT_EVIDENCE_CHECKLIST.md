# Final white-glove pilot — evidence checklist

**Purpose:** Separate **automated backend smoke** (compose, unit tests, production-readiness scripts) from **manual live PSTN proof** with operator-visible evidence. **Do not** mark any row **PASS** without the listed artifact or a redacted network note.

**Rules:**

- **No secrets** in screenshots, paste bins, or this document (no JWTs, API keys, `MEDIA_STREAM_TOKEN`, raw env dumps).
- **No full transcripts** with customer PII unless your compliance process explicitly allows it; prefer counts, timestamps, and internal IDs that are already non-sensitive.

---

## Evidence matrix

| # | Area | What to prove | Evidence (examples) | Pass |
|---|------|----------------|----------------------|------|
| 1 | **Admin login** | Superadmin or tenant admin can authenticate | HTTP **200** on a protected admin route (e.g. **`GET /api/admin/tenants`** with session); or screenshot with tokens blurred | ☐ |
| 2 | **Tenant loads** | Selected tenant / business profile visible in admin UI | Screenshot (business name public OK) or redacted JSON snippet without secrets | ☐ |
| 3 | **Business hours save** | Hours persist round-trip | **`PATCH`** then **`GET`** return **200**; hours match; screenshot or redacted HAR note | ☐ |
| 4 | **Portal login** | Owner portal login succeeds | **`POST /api/owner/login`** → success **`true`**, HTTP **200** — **do not** paste the token | ☐ |
| 5 | **Portal hours parity** | Portal shows same hours as admin | Matching screenshot pair or written confirmation with UTC date | ☐ |
| 6 | **Publish / runtime sync** | Published config reaches runtime | Publish endpoint **200**; runtime or admin shows **updated sync** timestamp (redacted if tied to internal only) | ☐ |
| 7 | **Live PSTN call** | End-to-end voice on real number | Note **UTC time**, **tenant id**, **`call_control_id`** (Telnyx), and operator checklist: greeting heard → question asked → answer heard | ☐ |
| 8 | **Portal recent call** | Call appears in portal recent activity | Screenshot or API list entry with **call id** only (no recording URLs with secrets) | ☐ |
| 9 | **Call drawer / summary** | Detail view opens; no secret leakage | Screenshot or redacted JSON: confirm **no** raw provider URLs / webhook secrets in normal tenant/admin payloads (Sprint 2A redaction path) | ☐ |
| 10 | **Production forensics** | Pipeline stages present for the test call | Forensics **path** (directory or bucket prefix only); **counts** of artifacts such as: `005_whisper_request`, `007_normalized_transcript`, `009_llm`, `012_tts`, `013_playback` — **counts only**, not raw audio/transcript bodies | ☐ |
| 11 | **Test call closed** | Call completed in product sense | Billing or call-end webhook handled; or internal “test call” checklist row signed | ☐ |

---

## Verdict (fill after pilot)

| Question | Answer |
|----------|--------|
| **White-glove pilot ready?** | **yes** / **no** — requires **all** critical rows (typically 1–11) **PASS** with evidence |
| **Client self-serve ready?** | Default **no** unless onboarding, docs, and support runbooks were exercised without operator assist |

---

## Important distinctions

- **Automated smoke** (CI, `npm run test:production-readiness`, compose `config`) proves **build integrity** and **contract** — not **customer-perceived quality** on the PSTN.
- **Merge-ready** (Sprint 2A) ≠ **pilot-ready** — merge-ready follows `docs/SPRINT_2A_MERGE_REVIEW.md` and `docs/SPRINT_2A_FINALIZATION_REPORT.md`.
- If any evidence is missing, record **PENDING** and the **blocking row number** — do not claim **PASS**.
