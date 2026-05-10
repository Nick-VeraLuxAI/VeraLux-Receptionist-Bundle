# Preflight checks (`scripts/preflight.sh`)

Operators should run **`./scripts/preflight.sh`** before going live, or rely on **`./up`** / **`./deploy.sh up`**, which **run preflight automatically** and **exit before** pulling images or starting containers if any check fails.

After containers are up, **readiness** (what “healthy” means for traffic) is documented in **`HEALTH_MODEL.md`** and checked by **`./scripts/healthcheck.sh`** (default mode).

## What it validates (repo-specific)

| Category | Behavior |
|----------|----------|
| **`.env` present** | Fails if `.env` missing (non-CI). |
| **Docker + daemon** | `docker` on PATH; `docker info` succeeds. |
| **Compose** | `docker compose` (v2) or `docker-compose` (legacy). |
| **Compose file** | `docker compose -f docker-compose.yml config --quiet` (+ `--env-file .env.internal` if present). |
| **Required keys** | Non-empty: Postgres, JWT, admin key, encryption key, media token, Telnyx keys, `BASE_URL`, `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, `VERSION`, `REGISTRY`. |
| **Placeholder secrets** | Fails on `CHANGE_ME`, empty, or obvious template substrings in critical secrets. |
| **`OPENAI_API_KEY`** | If `LLM_PROVIDER=openai` (default), key must be set and not a placeholder. |
| **Public URLs** | Fails if `PUBLIC_*` / `AUDIO_*` still contain `your-domain.com` or `example.com`. Warns on `localhost` / `127.0.0.1` for runtime URLs (Telnyx cannot reach). |
| **Tunnel hint** | If runtime URL is localhost and neither Cloudflare nor ngrok token is set → **warn**. |
| **`TELNYX_PHONE_NUMBER`** | Empty → **warn** (DIDs may live in DB only). |
| **`SECRET_ENCRYPTION_KEY` length** | When `SECRET_MANAGER=db` (default), fails if the value is shorter than **32 UTF-8 bytes** (matches control plane `secretStore.ts`). |
| **`TTS_MODE`** | Must be one of `coqui_xtts`, `kokoro_http`, `qwen3_tts_http`, `chatterbox_http`. |
| **`HF_TOKEN`** | **Fail** if `TTS_MODE` is `chatterbox_http` or `qwen3_tts_http` and token missing/short. |
| **Voice / GPU** | Runs **`scripts/validate-voice-deploy.sh`** (e.g. Chatterbox requires GPU). |
| **GPU notice** | Info when no NVIDIA GPU (CPU profile). |
| **Ports** | Best-effort: `ss` or `lsof` for `CONTROL_PORT` / `RUNTIME_PORT` (warn if something listens and it may not be this stack). |
| **`docker-compose.override.yml`** | Volume lines `- ./hostdir:...` — **warn** if `hostdir` does not exist. |

## Usage

```bash
# Full check (reads .env + .env.internal)
./scripts/preflight.sh
```

```bash
# CI / template only: no placeholder failures, uses a single file for merged reads
./scripts/preflight.sh --ci .env.example
```

```bash
# Treat warnings as failures (stricter go-live gate)
PREFLIGHT_STRICT=1 ./scripts/preflight.sh
```

## Integration (official startup path)

| Entry | Preflight |
|-------|-----------|
| `./deploy.sh up` | Runs **`scripts/preflight.sh`** first; **exits 1** on failure. |
| `./deploy.sh update` | Same. |
| `./deploy.sh tunnel` | Same. |
| `./up` | Same (delegates to `deploy.sh up`). |

If `scripts/preflight.sh` is missing, **`deploy.sh`** falls back to **`scripts/validate-voice-deploy.sh`** only.

## Sample: successful run (abbreviated)

```text
Veralux Receptionist — preflight

[ OK ] Found .env
[ OK ] Found .env.internal (merged for checks)
[ OK ] docker binary present
[ OK ] Docker daemon reachable
[ OK ] Compose command: docker compose
[ OK ] docker compose config --quiet
[ OK ] Voice profile / GPU compatibility (validate-voice-deploy.sh)
[ .. ] No NVIDIA GPU detected — deploy will use CPU audio profile (slower).
[ OK ] Port 4000 (CONTROL_PORT): nothing listening (ss)
[ OK ] Port 4001 (RUNTIME_PORT): nothing listening (ss)
[ OK ] Scanned docker-compose.override.yml for host paths

Summary: 0 failure(s), 0 warning(s)
Preflight passed. You can start the stack with ./up or ./deploy.sh up
```

## Sample: failed run (placeholders + bad URL)

```text
Veralux Receptionist — preflight

[ OK ] Found .env
[ OK ] docker binary present
[ OK ] Docker daemon reachable
[ OK ] Compose command: docker compose
[ OK ] docker compose config --quiet
[FAIL] Secret looks unset or placeholder: TELNYX_API_KEY
       → Generate a strong value; e.g. openssl rand -hex 32  (see .env.example comments).
[FAIL] PUBLIC_BASE_URL still looks like a template (https://your-domain.com)
       → Set PUBLIC_BASE_URL to the HTTPS URL Telnyx can reach (tunnel or reverse proxy).
[FAIL] LLM_PROVIDER=openai but OPENAI_API_KEY is missing or placeholder
       → Set OPENAI_API_KEY or set LLM_PROVIDER=local and LOCAL_LLM_URL (see .env.internal.example).

Summary: 3 failure(s), 0 warning(s)
Preflight failed. Fix the [FAIL] items above, then run ./up or ./deploy.sh up
```

## Sample: warnings only (localhost + strict mode)

With `PUBLIC_BASE_URL=http://localhost:4001`:

```text
[WARN] PUBLIC_BASE_URL is localhost — Telnyx cannot reach this from the internet.
       → Use Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN), ngrok, or a public hostname.
[WARN] No CLOUDFLARE_TUNNEL_TOKEN or NGROK_AUTHTOKEN — confirm you have another way to expose :4001.

Summary: 0 failure(s), 2 warning(s)
Preflight passed. You can start the stack with ./up or ./deploy.sh up
```

With **`PREFLIGHT_STRICT=1`**, the same run **exits 1** after the summary.

## Related docs

- **`ENV_VALIDATION_PLAN.md`** — roadmap for deeper validation.
- **`CONFIG_MATRIX.md`** — where each variable belongs.
- **`DEPLOYMENT_CONTRACT.md`** — supported operations model.
