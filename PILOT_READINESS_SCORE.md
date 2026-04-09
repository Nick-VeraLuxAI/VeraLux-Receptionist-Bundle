# Pilot readiness score (strict)

**Scale:** 0 = not deployable; 10 = meets the literal managed-deployment standard with no caveats.  
**Standard:** one documented path, one env file, predictable startup, predictable health verification, predictable persistence, no source edits for customer customization.

**Overall score: 6 / 10**

**Verdict: Ready for pilot customers — not ready for general managed production rollout** (see **`LAUNCH_BLOCKERS.md`**).

---

## Rubric (weighted)

| Dimension | Weight | Score (0–10) | Weighted | Notes |
|-----------|--------|--------------|----------|-------|
| One documented runtime path | 15% | 8 | 1.2 | `./deploy.sh` / `./up` / `start.sh` aligned; `install.sh` bootstrap only |
| One env file (literal) | 15% | 4 | 0.6 | `.env.internal` + override file are contract-supported |
| Predictable startup | 20% | 7 | 1.4 | Logic deterministic; duration and HF/model failures not bounded |
| Predictable health verification | 20% | 7 | 1.4 | HTTP/Docker readiness solid; **no** Telnyx E2E in health |
| Predictable persistence | 20% | 5 | 1.0 | Volumes clear; **automation** is Postgres-only |
| No source edits for customization | 10% | 6 | 0.6 | `BRAND_*` etc.; deep UI still fork/mount/source |

**Weighted sum:** **6.2** → reported as **6 / 10** (rounded down for strictness).

---

## Sub-score interpretation

- **8** — Strong single orchestration story; documentation and `UNSUPPORTED_PATTERNS` back it.
- **4** — Weakest dimension vs the **literal** “one env file” requirement.
- **7** — Startup and health are **engineered** but **telephony** and **cold-start time** remain operator variables.
- **5** — Persistence **model** is good; **operational predictability** for full DR is not automated.
- **6** — White-label **common case** covered; **edge** rebrand still out of band.

---

## Threshold mapping (internal)

| Score | Gate |
|-------|------|
| 0–3 | **Not ready** — do not place with paying customers |
| 4–5 | **Not ready** — internal / design-partner only with engineering embedded |
| **6–7** | **Pilot** — trained operators + written limitations + test-call exit criterion |
| 8 | **Conditional GA** — remaining gaps documented and accepted in MSA |
| 9–10 | **Strict GA** — literal standard met |

**This repo: 6 → pilot band.**

---

## Revision

| Date | Score | Verdict |
|------|-------|---------|
| 2026-04-06 | 6 / 10 | Pilot yes; managed production GA no |
