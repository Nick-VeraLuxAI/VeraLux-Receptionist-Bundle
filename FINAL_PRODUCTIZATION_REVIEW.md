# Final productization review (managed deployment)

**Reviewer stance:** Principal engineer, **strict** go/no-go against a single bar.

**Target standard (verbatim):**

> A trained operator can deploy a dedicated customer instance with **one documented path**, **one env file**, **predictable startup**, **predictable health verification**, **predictable persistence**, and **no source-code edits for customer customization**.

**Evidence base:** `DEPLOYMENT_CONTRACT.md`, `CUSTOMER_CONFIG_SURFACE.md`, `PERSISTENCE_CONTRACT.md`, `BACKUP_RESTORE.md`, `HEALTH_MODEL.md`, `UNSUPPORTED_PATTERNS.md`, `deploy.sh`, operator docs (`QUICKSTART.md`, etc.), `FILES_REQUIRING_SOURCE_EDITS.md`.

**Date:** 2026-04-06.

---

## 1. Criterion-by-criterion review

### 1.1 One documented path

**Mostly met.**

- **In-contract runtime orchestration** is **`./deploy.sh`**; **`./up`** and **`scripts/start.sh`** are documented equivalents (`DEPLOYMENT_CONTRACT.md` §4, `SUPPORTED_OPERATIONS.md`).
- Operator docs consistently warn against raw `docker compose up` for voice (`QUICKSTART.md`, `README.md`, `UNSUPPORTED_PATTERNS.md` §4–5).
- **`install.sh`** is explicitly **bootstrap-only**, not the ongoing orchestrator (`DEPLOYMENT_CONTRACT.md` §11). That is the right split, but it still introduces a **second** “first-time” path operators may remember incorrectly.

**Gap (minor):** cognitive load from “install once, then always `./up`” — manageable with training, not a structural failure.

---

### 1.2 One env file

**Not met under a literal reading.**

- The contract defines **`.env`** as the primary operator surface **and** allows **`.env.internal`** for overrides with **Compose precedence** (`DEPLOYMENT_CONTRACT.md` §8; `deploy.sh` `dc()` merges `--env-file .env.internal` when present).
- **`docker-compose.override.yml`** is also an **in-contract** customization mechanism for bind mounts, digests, limits (`DEPLOYMENT_CONTRACT.md` §8 item 5) — not application source, but **not** “one env file” either.

**Interpretation for scoring:** a **managed “standard SKU”** can be *operationally* defined as “operators only touch `.env`,” but the **product as documented** officially supports a second file and host overrides. That fails the stated standard unless you narrow the standard to “one *required* operator env file” (not what was asked).

---

### 1.3 Predictable startup

**Partially met.**

**Predictable:**

- **`deploy.sh up`** runs **`scripts/preflight.sh`** before containers start (`DEPLOYMENT_CONTRACT.md` §4).
- Audio profile selection is **rule-based** (`TTS_MODE` + GPU visibility) (`DEPLOYMENT_CONTRACT.md` §2).
- Compose **`depends_on`** with **`service_healthy`** orders control after data stores.

**Not fully predictable (time and externalities):**

- **First boot** can block on **model downloads** inside audio images, Hugging Face gating, and GPU memory — documented in operator materials and `HEALTH_MODEL.md` / `FIRST_BOOT_EXPECTATIONS.md`, but **wall-clock time is not bounded** by the repo.
- **`TTS_MODE=chatterbox_http` on CPU-only hosts** is **out of contract** (no `chatterbox-cpu` service) (`UNSUPPORTED_PATTERNS.md` §6). A misconfigured SKU is a hard failure mode, not a soft degradation.

**Verdict:** predictable *logic*, not predictable *duration* or *misconfiguration forgiveness*.

---

### 1.4 Predictable health verification

**Partially met.**

**Predictable:**

- **`./scripts/healthcheck.sh`** and documented endpoints (`/ready`, `/health/ready`, Docker health) align with **`HEALTH_MODEL.md`** (`DEPLOYMENT_CONTRACT.md` §6).
- Operators can distinguish **liveness** vs **readiness** (`--liveness`).

**Gaps:**

- **Telnyx, DNS, TLS, and webhook correctness** are **not** proven by container or HTTP readiness checks. A “green” stack can still fail all calls — this is acknowledged as operator responsibility in the contract (`DEPLOYMENT_CONTRACT.md` §10) but violates a naive reading of “predictable health verification” for **telephony**.
- **`HEALTH_VOICE_DEPENDENCIES=false`** allows a readiness path that **does not** validate Whisper/TTS — legitimate for special stacks, dangerous if misused in production (`HEALTH_MODEL.md`).

---

### 1.5 Predictable persistence

**Partially met.**

**Predictable:**

- **Named volumes** and classifications are explicit (`PERSISTENCE_CONTRACT.md`).
- **Automated** `./deploy.sh backup` / `scripts/backup.sh` target **PostgreSQL only** (`DEPLOYMENT_CONTRACT.md` §7; `UNSUPPORTED_PATTERNS.md` §14).
- Restore procedure documents **control + runtime restart** after DB restore to realign Redis (`BACKUP_RESTORE.md`).

**Gaps for managed offerings:**

- **Redis**, **audio volume**, and **control uploads** are **critical or conditionally critical** per `PERSISTENCE_CONTRACT.md` but **not** in the automated backup path — only optional manual procedures (`BACKUP_RESTORE.md` §2).
- **RPO/RTO** for a customer who expects “managed backup” is therefore **ambiguous** unless sales/support **explicitly** sell Postgres-only RPO or operators add runbooks.

---

### 1.6 No source-code edits for customer customization

**Partially met.**

**Met for a “standard” white-label:**

- **Branding and copy** for common cases are **env-driven** (`BRAND_*`, `PRODUCT_DISPLAY_NAME`, Telnyx display name, SMTP From, etc.) per **`CUSTOMER_CONFIG_SURFACE.md`**.

**Not met for strict “any customer customization”:**

- **`FILES_REQUIRING_SOURCE_EDITS.md`** and **`CUSTOMER_CONFIG_SURFACE.md` §3** still describe **HTML/CSS/layout** and **deep rebrand** as paths that require **source edits**, **fork**, or **bind mounts** / **`docker-compose.override.yml`**.
- Bind mounts are not “source edits” but they **are** file-based customization **outside** a single `.env` — and override files are easy to drift from vendor defaults.

---

## 2. Aggregate score and verdict

See **`PILOT_READINESS_SCORE.md`** for the numeric rubric.

**Summary score:** **6 / 10** (strict).

**Verdict:** **Ready for pilot customers** with a **written** limitation addendum (backup scope, Telnyx validation, optional second env file). **Not ready for unmanaged “managed production rollout”** without addressing **`LAUNCH_BLOCKERS.md`** (must-fix before GA).

---

## 3. Strengths (do not regress)

- Single Compose project, fixed `container_name` set, explicit **unsupported** list.
- **Contract trio** (`DEPLOYMENT_CONTRACT.md`, `SUPPORTED_OPERATIONS.md`, `UNSUPPORTED_PATTERNS.md`) plus operator quick docs reduces improvisation.
- Preflight-before-up, profile-aware **`deploy.sh`**, and readiness-oriented healthchecks are appropriate for voice stacks.

---

## 4. Closing statement

The repository is **operationally serious** and **documentation-led**, which is necessary but not sufficient for the **literal** one-env, full-persistence, no-exceptions customization bar. The gaps are **knowable and containable** for **pilots**; they are **not** acceptable to ignore for **general managed production** without product decisions (SKU, RPO, release integrity) codified outside the README.
