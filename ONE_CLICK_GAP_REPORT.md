# One-click deploy — gap report

Brutal summary: this repo is a **strong Docker Compose product** with a **realistic path** to client deployment, but it is **not** a fully self-contained one-click product until **external telephony + HTTPS** and **profile/orchestration footguns** are addressed.

---

## Blockers by severity

### Critical (must fix for true one-click)

| Gap | Evidence | Impact |
|-----|----------|--------|
| **Audio stack not in default Compose project** | Whisper/XTTS/Kokoro/Qwen services live under `profiles: [gpu]` or `[cpu]`. Comments in `docker-compose.yml` say `docker compose up` works; **without** `./deploy.sh up`, core voice dependencies are missing. | Runtime starts “healthy” while **STT/TTS are unreachable** — silent degradation until a call fails. |
| **Telnyx + public URL configuration is manual** | `PUBLIC_BASE_URL`, `AUDIO_PUBLIC_BASE_URL`, webhook setup in Telnyx portal. | No amount of compose fixes removes **DNS + TLS + webhook URL** steps for PSTN. |
| **Installer / registry tag mismatch risk** | `install.sh` historically used `VERSION=latest`; images are tagged by semver/git in docs. | **Pull failures** or wrong image on fresh installs. *(Partially remediated: installer now defaults `VERSION=0.1.0`.)* |
| **Cloudflare tunnel required extra env** | `cloudflared` service needs `CLOUDFLARE_TUNNEL_TOKEN`; image tag was mandatory `:?` until defaults added. | **`docker compose config` / up** could fail or tunnel step skipped. *(Remediated: default `CLOUDFLARED_TAG` in compose; installer adds tag when token present.)* |
| **Rolling update broke tunnel restart** | `deploy.sh` `cmd_update` called `up -d cloudflared` **without** `--profile cloudflare`. | After update, tunnel might not be recreated correctly. *(Remediated in `deploy.sh`.)* |

### Important (reliability / support cost)

| Gap | Evidence | Impact |
|-----|----------|--------|
| **Runtime health vs dependency readiness** | *(Remediated.)* Compose `healthcheck` for **`runtime`** uses **`GET /health/ready`** (Redis + Whisper + TTS HTTP). **`control`** uses **`GET /ready`** (DB + Redis). See **`HEALTH_MODEL.md`**. | Model load can still leave containers **starting** for minutes — that is expected until audio **`/health`** passes. |
| **GPU memory / model load failures** | Multiple large models (Whisper, XTTS, Chatterbox, Qwen3, optional vLLM) compete for GPU; compose allows split via `*_GPU_IDS` but easy to misconfigure. | **OOM / crash loops** on first customer hardware. |
| **Hugging Face gating** | Chatterbox/Qwen3 compose env documents `HF_TOKEN`. | **First-run download failures** if token or license missing. |
| **`install.sh` JSON parsing** | Uses `grep -o` on JSON responses / base64 payloads. | Fragile if API adds fields or changes formatting. |
| **Online installer API hardcoded** | *(Partially remediated.)* Defaults remain; override with **`INSTALLER_CONFIG_API_URL`** / **`INSTALLER_SIGNUP_URL`** before **`install.sh`**. See **`CUSTOMER_CONFIG_SURFACE.md`**. | Airgapped hosts should use offline installer path. |
| **Admin “local LLM” path vs Docker** | Installer suggests Ollama on host; compose stack does not start Ollama; `LLM_PROVIDER=local` expects reachable `LOCAL_LLM_URL`. | **Conceptual mismatch** for operators who think “local” means “in the bundle.” |
| **README troubleshooting** | Suggests `docker pull ${REGISTRY}/veralux-control:${VERSION}` but image name is **`veralux-control-plane`**. | Wasted support cycles. |
| **Duplicate/confusing compose** | `control-plane/docker-compose.yml` is a **separate** dev-oriented stack vs root bundle. | Developers may run wrong stack. |

### Nice to have (polish)

| Gap | Evidence | Impact |
|-----|----------|--------|
| **`API_KEY` in root compose for control** | No `API_KEY` usage in `control-plane` `.ts` sources. | Operators think it is required; **documentation debt**. |
| **shellcheck optional in CI** | `.github/workflows/ci.yml` runs shellcheck with `\|\| true`. | Script quality regressions possible. |
| **No single “stack ready” exit code** | Operators must interpret `docker compose ps` and logs. | **`scripts/healthcheck.sh` added** to improve this. |

---

## Remediation plan (concrete)

### Files to create or modify

| File | Action | Purpose |
|------|--------|---------|
| `docker-compose.yml` | **Done**: default `CLOUDFLARED_TAG` / `NGROK_TAG` | `docker compose config` works without tunnel vars; fewer footguns. |
| `deploy.sh` | **Done**: `cmd_update` restarts **cloudflared** (profile `cloudflare`) and **ngrok** (profile `ngrok`); pulls **llm**/**tunnel** images when those containers run; includes **Chatterbox** in audio refresh. See **`UPGRADE_RUNBOOK.md`**. |
| `install.sh` | **Done**: richer `.env` (BASE_URL, URLs, VERSION, CLOUDFLARED_TAG when token) | Fewer broken first boots. |
| `.env.example` | **Done**: warning about `deploy.sh` vs plain compose | Reduces profile mistake. |
| `scripts/start.sh` | **Added** | Single obvious “start” entry. |
| `scripts/healthcheck.sh` | **Added** | Post-deploy verification. |
| `DEPLOYMENT_AUDIT.md` | **Added** | Inventory + score + model fit. |
| `docs/CLIENT_DEPLOY_QUICKSTART.md` | **Added** | Operator-facing steps. |
| `README.md` | Optional follow-up | Fix image name typo; link quickstart. |
| `docker-compose.yml` | Optional | Add top-of-file **warning** matching `.env.example` (deploy.sh required for audio). |
| `install.sh` | Optional | Replace `grep` JSON parsing with `jq` when available; parameterize `API_URL`. |
| New `scripts/validate-env.sh` | Optional | Grep `.env` for `CHANGE_ME`, empty Telnyx keys, localhost `PUBLIC_BASE_URL` when `TELNYX_VERIFY_SIGNATURES=true` in prod, etc. |

### Recommended deploy architecture

- **Single VM / bare metal** with Docker: `control`, `runtime`, `postgres`, `redis`, **cpu or gpu profile** audio services.
- **Edge**: Cloudflare Tunnel (profile `cloudflare`) or customer reverse proxy terminating TLS.
- **Optional second phase**: split Postgres/Redis to managed services — **not** required by current compose but common for scale; would need compose overrides.

### Recommended Compose / installer structure (target state)

- **One** supported entrypoint: `./install.sh` (greenfield) or `./deploy.sh up` (existing).
- **Profiles**: `cpu` | `gpu` for audio; `cloudflare` | `ngrok` for tunnel; `llm` for vLLM+brain.
- **Per-client**: `.env` or `.env.clientname` + `docker compose --env-file` (document pattern); **no** forked code.

### Config strategy for per-client deployments

- **Secrets**: `.env` on host (chmod 600), never committed; generated by `install.sh` or your provisioning API.
- **Non-secret tenant behavior**: control plane DB + Redis-published runtime config (existing pattern).
- **Version pinning**: `VERSION` + `REGISTRY` per client release channel.

### Health check strategy

- **Container**: existing `healthcheck` blocks in `docker-compose.yml` for postgres, redis, control, runtime, audio services.
- **Host**: `./scripts/healthcheck.sh` after up (HTTP + optional Whisper + Docker health inspection).
- **Improvement**: change runtime Compose `healthcheck` to hit `/health` or `/ready` once dependencies are stable, **or** add `depends_on` from runtime to whisper/xtts with `service_healthy` (harder because service names differ between cpu/gpu profiles).

### Logging and failure recovery

- **json-file** logging with rotation (compose `x-logging`).
- **Recovery**: `docker compose restart <svc>`; `./deploy.sh logs <svc>`; `docker compose down` + volume backup restore via `scripts/backup.sh`.
- **GPU OOM**: document lowering workers, splitting GPUs, or using `cpu` profile in `.env` / docs.

---

## Deployment model verdict

**Best fit today: Docker Compose + `./deploy.sh`**, optionally **+ Cloudflare Tunnel profile** for HTTPS without nginx cert management.

Not the best fit: Electron installer, or “SaaS only” without shipping this compose bundle.
