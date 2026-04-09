# Environment validation plan (repo-specific)

Goal: catch misconfiguration **before** calls fail silently, without forcing every operator to understand the full Zod schema in **`veralux-voice-runtime/src/env.ts`**.

---

## Current state (what exists today)

| Stage | Mechanism | Scope |
|-------|-----------|--------|
| **Pre-up (host)** | **`scripts/preflight.sh`** | Docker/Compose, required `.env` keys, placeholder secrets, URL sanity, Telnyx/LLM/HF, ports, override bind paths; calls **`validate-voice-deploy.sh`**. Invoked from **`deploy.sh`** (`up`, `update`, `tunnel`). See **`PRECHECKS.md`**. |
| **Voice runtime container start** | Zod **`EnvSchema`** in **`veralux-voice-runtime/src/env.ts`** | Full runtime env; throws on invalid types / missing required keys. |
| **Pre-up (voice subset)** | **`scripts/validate-voice-deploy.sh`** | `TTS_MODE` enum; `chatterbox_http` + GPU; also run from **`preflight.sh`**. |
| **Control plane container start** | **`control-plane/scripts/docker-entrypoint.sh`** | Requires `ADMIN_API_KEY` in production; runs DB wait + migrations. |
| **Compose interpolation** | `docker compose config` in CI | Syntax / variable substitution only. |
| **CI** | **`bash scripts/validate-voice-deploy.sh .env.example`** | Ensures operator template stays valid. |

---

## Gaps (honest)

| Gap | Risk | Severity |
|-----|------|----------|
| No single validator for **operator `.env`** required keys (`PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `SECRET_ENCRYPTION_KEY` length, etc.) | Bad first boot after copy-paste | High |
| Control plane does **not** mirror runtime Zod | Drift between services until runtime crashes | Medium |
| **`scripts/backup.sh`** uses `grep \| xargs` for Postgres vars | Breaks on exotic quoting in `.env` | Medium |
| Tenant **`RuntimeTenantConfig`** validated in control plane on publish; runtime validates on consume | Invalid Redis payload → runtime errors mid-call | Medium |

---

## Recommended phases

### Phase A — Operator `.env` gate (fast, shell)

**Partially implemented:** **`scripts/preflight.sh`** covers required keys, placeholders, URLs, Telnyx/LLM/HF, Compose config, and ports. Remaining gaps below.

Optionally extend **`preflight.sh`** to fail when:

- Required keys are missing or still `CHANGE_ME` / empty:  
  `POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_API_KEY`, `SECRET_ENCRYPTION_KEY`, `MEDIA_STREAM_TOKEN`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `BASE_URL`
- `SECRET_ENCRYPTION_KEY` length below control-plane expectations (see **`control-plane/docs/configuration.md`**).
- `PUBLIC_BASE_URL` / `AUDIO_PUBLIC_BASE_URL` are still obvious placeholders (`your-domain.com`, `localhost`) **and** `TELNYX_VERIFY_SIGNATURES=true` (warn or fail for “prod” mode via `DEPLOYMENT_ENV=production` flag — not yet implemented).

**Integration:** **`deploy.sh`** runs **`scripts/preflight.sh`** after **`check_env`** and before **`dc up`** (see **`PRECHECKS.md`**).

### Phase B — Control plane startup schema (Node)

Introduce a small Zod (or typed parser) module **`control-plane/src/envSchema.ts`** that validates:

- Required production vars when `NODE_ENV=production`.
- URLs parse as URLs for `BASE_URL`, `REDIS_URL`, `DATABASE_URL`.

Fail fast with a single error block (like runtime).

### Phase C — Runtime / control alignment

- Document cross-service invariants in **`CONFIG_MATRIX.md`** (already started).
- Optional: control plane **`GET /api/admin/health`** already exposes STT/TTS “configured” hints — extend with **“placeholder URL detected”** when env matches known bad patterns.

### Phase D — Tenant config

- Keep **`parseRuntimeTenantConfig`** as the authority for Redis payloads.
- Add control-plane **validation on save** in the UI API path (if not already complete) so bad TTS blocks never publish.

---

## What not to duplicate

- Do **not** re-implement the full **`env.ts`** schema in shell. Use Phase A for **operator-required** keys only; let Zod own the rest at container start.

---

## Testing

| Test | Command / location |
|------|---------------------|
| Operator template | `bash scripts/preflight.sh --ci .env.example` (CI) |
| Compose | `docker compose config --quiet` (CI) |
| Runtime unit | Existing **`veralux-voice-runtime`** tests with **`testEnv.ts`** |
| Manual | `./up` on a staging host after intentional `.env` mistakes |

---

## Related files

- **`deploy.sh`** — `dc()`, **`read_merged_env_value`**, **`cloudflare_token_configured`**, **`ngrok_token_configured`**
- **`docker-compose.yml`** — interpolation defaults
- **`.env.example`**, **`.env.internal.example`**
- **`CONFIG_MATRIX.md`**
