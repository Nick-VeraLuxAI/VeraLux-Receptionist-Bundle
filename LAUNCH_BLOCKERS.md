# Launch blockers (managed deployment)

**Use:** go/no-go lists for **pilot** vs **general managed production**.  
**Standard:** same as **`FINAL_PRODUCTIZATION_REVIEW.md`** (one path, one env file, predictable startup/health/persistence, no source edits for customization).

---

## A. Must fix before general managed production rollout

These are **blockers for declaring GA** “managed production” under a strict reading. Pilots may proceed **only** with explicit written acceptance of the workaround.

| ID | Blocker | Why it fails the bar | Workaround for pilot (if any) |
|----|---------|----------------------|-------------------------------|
| **P1** | **More than one first-class config file** (`.env` + optional `.env.internal` + optional `docker-compose.override.yml`) | Violates “one env file” and increases drift risk | Pilot: mandate **`.env` only**; vendor holds `.env.internal` if needed; no customer overrides without change control |
| **P2** | **Automated backup scope = Postgres only** while **Redis / audio / uploads** can be business-critical (`PERSISTENCE_CONTRACT.md`, `UNSUPPORTED_PATTERNS.md` §14) | “Predictable persistence” / RPO is undefined for full stack | Pilot: customer signs **Postgres RPO** + manual runbook for other volumes; or vendor runs scripted `tar`/`redis-cli` jobs |
| **P3** | **Health checks do not validate Telnyx / public URL / webhook reality** | “Predictable health verification” does not extend to **calls working** | Pilot: **exit criterion = test call** + Telnyx checklist; treat `healthcheck.sh` as necessary not sufficient |
| **P4** | **Release integrity not enforced in artifact** (no mandatory `SHA256SUMS` / manifest in customer ZIP by default; see `RELEASE_BUNDLE_SPEC.md` §7) | Supply-chain and support reproducibility weak for managed fleet | Pilot: internal checksum registry; customer gets hash out-of-band |
| **P5** | **Deep white-label still implies fork, source edit, or bind mount** (`FILES_REQUIRING_SOURCE_EDITS.md`, `CUSTOMER_CONFIG_SURFACE.md` §3) | Violates “no source-code edits for customer customization” for **full** rebrand | Pilot: restrict to **BRAND_***-level white-label; defer layout/CSS to professional services |

---

## B. Can fix after first customers (non-blocking for pilot)

| ID | Item | Notes |
|----|------|--------|
| **F1** | **First-boot wall-clock bounds** | Improve with pre-baked images, airgap image policy, HF token runbook; already documented, not “fixed” |
| **F2** | **`install.sh` default vendor API URL** | Enterprise customers should pin `INSTALLER_CONFIG_API_URL` / offline flow (`UNSUPPORTED_PATTERNS.md` §17) |
| **F3** | **Optional automation for Redis / volume backups** | Wrapper script or cron template; not required if RPO sold as Postgres-only |
| **F4** | **Offline bundle: `cloudflared` image omission** | Document or add to offline list (`RELEASE_BUNDLE_SPEC.md` audit) |
| **F5** | **Branding phase E/F** (`CUSTOMER_CONFIG_SURFACE.md` §4) | CSS variables / dev-console branding |
| **F6** | **`BUNDLE_MANIFEST.txt` generation** | Support and audit trail (`RELEASE_BUNDLE_SPEC.md` §3) |
| **F7** | **CPU path for Chatterbox** | Product decision: GPU-only SKU vs new service |

---

## C. Not blockers (explicit non-goals for this review)

- **Kubernetes / Helm** — out of scope for this bundle; wrapping is customer risk (`UNSUPPORTED_PATTERNS.md` §10).
- **Windows hosts** — documented limitation.
- **Operator must configure Telnyx + DNS** — expected; failure is **process**, not missing code, if runbooks exist.

---

## D. Recommended pilot contract clause (one paragraph)

> Deployment uses **`./up`** (or **`./deploy.sh up`**) only. Configuration is **`/.env`** [plus vendor-managed internal overrides if any]. **Automated backup covers PostgreSQL only**; other data requires agreed procedures. **Go-live requires** `./scripts/healthcheck.sh` **and** a successful **test call** on a production DID. **White-label** is limited to env-driven branding unless a separate SOW covers HTML/CSS or compose overrides.
