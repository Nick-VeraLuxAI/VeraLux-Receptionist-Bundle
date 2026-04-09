# Release bundle specification

**Audience:** release engineering, managed services, anyone producing customer-facing ZIPs.  
**Scope:** root Docker bundle only (this repo). Not the upstream application monorepo.  
**Authoritative packagers:** `scripts/build-online-bundle.sh`, `scripts/build-offline-bundle.sh`.

---

## 1. Product readiness audit (current state)

| Area | Status | Notes |
|------|--------|--------|
| **Single startup contract** | Good | `deploy.sh`, `./up`, and `scripts/start.sh` all delegate to the same path; Compose project `veralux` and profiles are enforced in `deploy.sh`. |
| **Customer entrypoints** | Good | `install.sh` (optional), `./up` / `./deploy.sh up`, `scripts/preflight.sh`, `scripts/healthcheck.sh`. |
| **Docs split** | Mixed | Root operator docs exist (`QUICKSTART.md`, checklists, runbooks). **`DEPLOYMENT_CONTRACT.md`**, **`SUPPORTED_OPERATIONS.md`**, and **`UNSUPPORTED_PATTERNS.md`** are referenced from `README.md` and the contract but were **not** copied by bundle scripts until aligned with this spec—operators unzipping only the ZIP had a broken doc trail. |
| **Source tree in ZIP** | Good | Bundles do **not** ship `control-plane/`, `veralux-voice-runtime/`, etc. Images are pulled or offline-archived. |
| **Parity: README vs ZIP** | Risk | `README.md` lists `./scripts/start.sh`; online/offline bundles historically shipped only a subset of `scripts/`. Either ship `scripts/start.sh` or strip that line from customer README builds—**this spec requires shipping `start.sh`.** |
| **Offline image set** | Gap to document | `build-offline-bundle.sh` archives app images + `redis` + `postgres`. **`cloudflared`** (profile `cloudflare`) is **not** in the default offline list; airgapped hosts using tunnels need a deliberate image add or registry pull policy. |
| **Reproducibility** | Weak | No `SHA256SUMS`, no embedded manifest of paths/hashes/version. Recommended for managed releases (see §7). |

---

## 2. Release artifacts (managed deployments)

Ship **exactly these** customer artifacts per version `VERSION` (from `.env` / `.env.example`):

| Artifact | Contents |
|----------|----------|
| **`dist/veralux-receptionist-{VERSION}-online.zip`** | Runtime layout in §3, **no** `images.tar.zst`, **no** `load-images.sh` optional—see §5. |
| **`dist/veralux-receptionist-{VERSION}-offline.zip`** | Same layout + **`images.tar.zst`** + **`load-images.sh`**. |

**Naming:** Prefix `veralux-receptionist-` + semver (or your release tag) + suffix `-online` / `-offline`.

**Internal-only artifacts (not customer ZIPs):** git tag, CI logs, SBOM, vulnerability scans, signing keys, staging compose overrides.

---

## 3. Packaged folder structure (recommended)

Unzipped layout must be **flat at bundle root** (operators `cd` into the folder and run `./up`). No nested `deploy/` package unless you intentionally retrain customers.

```
veralux-receptionist-{VERSION}/
├── README.md
├── QUICKSTART.md
├── CLIENT_DEPLOY_CHECKLIST.md
├── FIRST_BOOT_EXPECTATIONS.md
├── TROUBLESHOOTING_DEPLOY.md
├── DEPLOYMENT_CONTRACT.md
├── SUPPORTED_OPERATIONS.md
├── UNSUPPORTED_PATTERNS.md
├── PRECHECKS.md
├── HEALTH_MODEL.md
├── PERSISTENCE_CONTRACT.md
├── BACKUP_RESTORE.md
├── UPGRADE_RUNBOOK.md
├── ROLLBACK_RUNBOOK.md
├── RELEASE_CHANNELS.md
├── CUSTOMER_CONFIG_SURFACE.md
├── FILES_REQUIRING_SOURCE_EDITS.md
├── docker-compose.yml
├── .env.example
├── .env.internal.example
├── deploy.sh
├── install.sh
├── up
├── load-images.sh                    # offline bundle only
├── images.tar.zst                    # offline bundle only
├── nginx/                            # if present in source repo
├── scripts/
│   ├── preflight.sh
│   ├── healthcheck.sh
│   ├── backup.sh
│   ├── restore.sh
│   ├── validate-voice-deploy.sh
│   └── start.sh
└── (optional) cloudflared/config.yml # only if you document host path mounts using it
```

**Optional future file (recommended):** `BUNDLE_MANIFEST.txt` — one line per included path, optional sha256, generated at pack time—to support support desk “what build is this?” without opening the ZIP.

---

## 4. What ships to an operator vs stays internal

### 4.1 Always ship (customer / operator)

Everything in §3 **except** items marked offline-only. Purpose: install, configure `.env`, run, verify, upgrade, back up, and understand **supported** vs **unsupported** behavior.

| Class | Rationale |
|-------|-----------|
| **Contract trio** | `DEPLOYMENT_CONTRACT.md`, `SUPPORTED_OPERATIONS.md`, `UNSUPPORTED_PATTERNS.md` — reduces “works on my laptop” ambiguity. |
| **Operator quick path** | `QUICKSTART.md`, `CLIENT_DEPLOY_CHECKLIST.md`, `FIRST_BOOT_EXPECTATIONS.md`, `TROUBLESHOOTING_DEPLOY.md`. |
| **Runbooks** | `UPGRADE_RUNBOOK.md`, `ROLLBACK_RUNBOOK.md`, `BACKUP_RESTORE.md`, `RELEASE_CHANNELS.md`. |
| **Technical depth** | `PRECHECKS.md`, `HEALTH_MODEL.md`, `PERSISTENCE_CONTRACT.md` — needed for serious ops. |
| **Config surface** | `CUSTOMER_CONFIG_SURFACE.md` — what operators may change without forking. |
| **Fork / advanced UI** | `FILES_REQUIRING_SOURCE_EDITS.md` — still ship: it sets expectations when white-label needs exceed env/branding; managed customers without source treat it as “requires vendor change.” |
| **Examples** | `.env.example` (required secrets and ports), `.env.internal.example` (optional tuning; not secret-by-default). |

### 4.2 Ship only with internal / partner documentation (not in public ZIP)

Keep **out** of the standard customer bundle unless you have a separate “engineering drop”:

| Path / pattern | Why |
|----------------|-----|
| **Entire source trees** | `control-plane/`, `veralux-voice-runtime/`, `veralux-audio-stack/`, `**/node_modules/`, `**/dist/` from builds | Intellectual property, noise, wrong support surface. |
| **`.github/`** | CI secrets patterns, internal workflows. |
| **`.git/`** | History, refs. |
| **`build/`**, **`dist/*.zip`** (when rebuilding) | Intermediate artifacts; avoid recursive ZIP. |
| **`.env`** (real) | Secrets; never pack. |
| **Internal audit / gap / planning docs** | `ONE_CLICK_GAP_REPORT.md`, `DEPLOYMENT_AUDIT.md`, `ENV_VALIDATION_PLAN.md`, `CONFIG_MATRIX.md`, `control-plane/docs/CODEBASE_AUDIT.md`, `STRENGTHENING_PLAN.md`, etc. | Productization and engineering planning, not operator runbooks. |
| **`docs/`** (subfolder) | Mostly duplicates or deep dev docs; **do not** ship whole tree. If you need one stub, ship only `docs/CLIENT_DEPLOY_QUICKSTART.md` (pointer to root `QUICKSTART.md`) or omit entirely—root docs are canonical. |
| **Per-service `README.md` under components** | Unless you explicitly want field engineers reading runtime internals. |
| **`scripts/build-*-bundle.sh`** | Maintainer tooling; optional in a “vendor toolkit” ZIP, not default customer. |
| **`scripts/seed-default-runtime-config.json`** | Seed data for dev/bootstrap; only ship if install docs require it (today: not part of bundle scripts). |

### 4.3 “Advanced operator” (ship, but label in README)

- **`.env.internal.example`** — tuning and non-default URLs; precedence rules matter; keep in bundle but secondary to `.env.example`.

---

## 5. Files to exclude from customer delivery (checklist)

Use as `rsync --exclude-from` or packager denylist:

```
.git/
.github/
.env
.env.*
!.env.example
!.env.internal.example
build/
control-plane/
veralux-voice-runtime/
veralux-audio-stack/
**/node_modules/
**/.venv/
**/__pycache__/
*.pyc
.DS_Store
ONE_CLICK_GAP_REPORT.md
DEPLOYMENT_AUDIT.md
ENV_VALIDATION_PLAN.md
CONFIG_MATRIX.md
docs/
!docs/CLIENT_DEPLOY_QUICKSTART.md
```

Adjust `docs/` rule if you choose to ship only the stub (include that one path explicitly).

---

## 6. Files required in every customer deployment package

**Must be present** in both online and offline ZIPs (offline adds §6.1):

| File / directory | Role |
|------------------|------|
| `docker-compose.yml` | Stack definition |
| `.env.example` | Configuration template |
| `deploy.sh` | Supported lifecycle CLI |
| `up` | Short alias to `deploy.sh up` |
| `install.sh` | Guided bootstrap (optional path; still ship) |
| `README.md` | Orientation; must agree with shipped scripts |
| `scripts/preflight.sh` | Go-live gate |
| `scripts/healthcheck.sh` | HTTP + container health smoke |
| `scripts/backup.sh` | Pre-upgrade backup hook |
| `scripts/restore.sh` | Restore companion |
| `scripts/validate-voice-deploy.sh` | Voice/GPU profile validation |
| `scripts/start.sh` | Same as `./up` (README parity) |
| `DEPLOYMENT_CONTRACT.md` | Supported model |
| `SUPPORTED_OPERATIONS.md` | Command reference |
| `UNSUPPORTED_PATTERNS.md` | Explicit exclusions |
| `QUICKSTART.md` | Short operator path |
| `CLIENT_DEPLOY_CHECKLIST.md` | Ordered rollout |
| `FIRST_BOOT_EXPECTATIONS.md` | Model load / health timing |
| `TROUBLESHOOTING_DEPLOY.md` | Failure playbooks |
| `PRECHECKS.md`, `HEALTH_MODEL.md`, `PERSISTENCE_CONTRACT.md` | Deep ops |
| `BACKUP_RESTORE.md`, `UPGRADE_RUNBOOK.md`, `ROLLBACK_RUNBOOK.md`, `RELEASE_CHANNELS.md` | Lifecycle |
| `CUSTOMER_CONFIG_SURFACE.md`, `FILES_REQUIRING_SOURCE_EDITS.md` | Config boundaries |
| `.env.internal.example` | Advanced tuning template |
| `nginx/` | If repo contains it; reverse proxy/TLS patterns |

### 6.1 Offline-only additions

| File | Role |
|------|------|
| `load-images.sh` | Load `images.tar.zst` into Docker |
| `images.tar.zst` | Frozen images per offline script configuration |

---

## 7. Release checklist (before publishing a customer ZIP)

- [ ] **Version** — `VERSION` in `.env.example` matches git tag / release notes.
- [ ] **Registry** — `.env.example` `REGISTRY` default matches images you published for this tag.
- [ ] **Build** — Run `./scripts/build-online-bundle.sh` and `./scripts/build-offline-bundle.sh` from a **clean** tree (no local `.env` in workspace, or verify packager never copies `.env`).
- [ ] **Manifest** — Unzip to temp; confirm **no** `control-plane/`, `veralux-voice-runtime/`, `.github/`, `.git/`.
- [ ] **Contract docs** — `DEPLOYMENT_CONTRACT.md`, `SUPPORTED_OPERATIONS.md`, `UNSUPPORTED_PATTERNS.md` present.
- [ ] **Executable bits** — `deploy.sh`, `install.sh`, `up`, `load-images.sh` (offline), and all `scripts/*.sh` are executable in the ZIP (Unix).
- [ ] **Offline images** — `docker load` / `load-images.sh` smoke on a clean host; document if `cloudflared` is omitted from the archive.
- [ ] **README smoke** — From unzip dir: `./scripts/preflight.sh` (expected failures OK without `.env`), then minimal `.env` and `./up` on a staging host per `QUICKSTART.md`.
- [ ] **Checksums (recommended)** — Publish `SHA256SUMS` for each ZIP alongside download.
- [ ] **Support handoff** — Record `VERSION`, bundle filename, and git SHA used to build images.

---

## 8. Maintainer note: keep spec and scripts aligned

When adding a root-level operator doc or script that `README.md` references, update **both** `build-online-bundle.sh` and `build-offline-bundle.sh` in the same change, or add a single sourced file list to avoid drift.

---

## 9. Revision

| Date | Change |
|------|--------|
| 2026-04-06 | Initial spec; aligned mandatory includes with contract docs and `scripts/start.sh`. |
