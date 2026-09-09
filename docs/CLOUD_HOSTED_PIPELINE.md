# Cloud-hosted pipeline, price refresh, and teardown

**Track:** `cloud-hosted` / `DEPLOYMENT_PROFILE=cloud-api`  
**Admin:** `/admin/pipeline`  
**Related:** [`CLOUD_API_DEPLOYMENT.md`](CLOUD_API_DEPLOYMENT.md), [`DEPLOYMENT_CONTRACT.md`](../DEPLOYMENT_CONTRACT.md)

## What this is

The hub control plane (this repo’s admin) is the fleet manager. For each tenant you can:

1. Compose a pipeline: paid **host** + Telnyx + **STT** + **LLM** + **TTS**.
2. See a running **list-price COGS** and **suggested retail** per billable minute. **Estimates are not invoices.**
3. Apply the recipe to this hub’s receptionist config (and optionally copy retail into plan overage ¢/min). If a deployment is `ready`, Apply also pushes STT / LLM / TTS onto the **remote** control plane.
4. **Spin up** an isolated paid stack (control + runtime + Postgres + Redis) on Render, Railway, or AWS Fargate. Ready means health probes passed.

Language models listed on Pipeline are only IDs we can call with a public BYOK key on the existing OpenAI / Anthropic / Google / Groq / xAI routes. **Groq is Groq Cloud** (`https://api.groq.com/openai/v1`). Developer-plan Llama IDs were retired.

The calculator also shows **typical reply-start latency**. That number is a list-speed estimate, not an SLA.

## What Spin up actually does

`POST /api/admin/tenants/:id/deployments` (superadmin) starts a job. The orchestrator owns the step machine. Host adapters only create resources; they cannot stamp later steps.

| Step | What “ok” means |
|------|-----------------|
| `create_db` | Host API created Postgres |
| `create_redis` | Host API created Redis / Key Value |
| `create_control` | Host API created the control-plane image service |
| `create_runtime` | Host API created the voice-runtime image service |
| `inject_env` | Both services received `CloudStackEnv` (DB/Redis URLs, per-deployment secrets, vendor keys, webhook URL). URLs come from the host API, not guessed hostnames |
| `wait_healthy` | `GET {controlUrl}/health` and `GET {runtimeUrl}/health/live` returned 200 |
| `configure_telnyx` | Hub created a Telnyx connection with webhook `{runtimeUrl}/v1/telnyx/webhook`. If the hub tenant already has a DID, it is assigned. Otherwise the job can still succeed with `needsNumber` |
| `ready` | All of the above succeeded. `deployment.status=ready` is never set before health |

If inject, health, or Telnyx is skipped, the job **fails**. There is no “mark remaining steps ok” path.

Teardown: `DELETE /api/admin/tenants/:id/deployments/:id` deletes host resources (Render services + DB + KV, Railway project, AWS CloudFormation stack) and clears the bootstrap admin key.

Free host SKUs are rejected. One active deployment per tenant.

## What is real on each host

Images: `{REGISTRY}/veralux-control-plane:{VERSION}` and `{REGISTRY}/veralux-voice-runtime:{VERSION}` (`ghcr.io/nick-veraluxai` / `0.1.0` by default). Publish those images before Spin up.

| Host | What the adapter does | Operator follow-up |
|------|-----------------------|--------------------|
| **Render** (starter / standard / pro only) | Creates Postgres, Key Value, two image web services. Fetches real service URLs and internal connection strings. PUTs env vars and triggers deploys. Polls health. Deletes on teardown | Paid plan. Paste `RENDER_API_KEY` in Settings |
| **Railway** (hobby / pro only) | Creates project, Postgres + Redis plugins, two image services, public domains from the API, GraphQL variable upsert. Failures are not swallowed | Paid plan. Paste `RAILWAY_TOKEN` in Settings |
| **AWS** (`fargate_small` / `fargate_medium`) | Creates a CloudFormation stack: VPC, RDS Postgres, ElastiCache Redis, ECS Fargate (control + runtime), dual internet-facing ALBs. Outputs are **real ALB DNS** on HTTP :80. Teardown is `DeleteStack` | Paste `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`. Attach ACM + HTTPS listener if you need TLS (Telnyx webhooks prefer HTTPS). Images must be pullable from GHCR (public, or add a pull secret later) |

AWS does **not** invent `*.awsapprunner.com` hostnames. Catalog SKUs are Fargate, not App Runner.

## Apply to the remote stack

Hub remains the fleet source of truth.

- Apply always writes this hub tenant + publishes runtime config.
- When `getActiveDeployment` is `ready`, Apply also POSTs the tenant row and pipeline STT/LLM/TTS to `{controlUrl}` using the per-deployment bootstrap admin key (stored as `deployment_admin_{id}`, never logged).
- The Apply JSON includes `published` / `publishError` and `remoteApplied` / `remoteApplyError`.

Per-tenant LLM BYOK (`TENANT_LLM_OPENAI_SECRET_KEY` / portal model) is injected into the remote env in preference to hub `OPENAI_API_KEY`. Hub `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, and `TELNYX_API_KEY` fill in when the tenant has no override.

## Operator checklist (not automated)

1. Publish the two GHCR images.
2. Paste host credentials in Settings.
3. Have Telnyx + Deepgram and/or OpenAI + ElevenLabs keys available.
4. Spin up from `/admin/pipeline`.
5. If the job says assign a number, attach a DID to the new Telnyx connection.
6. Apply so the remote receptionist modes match the hub.
7. Place one real inbound DID proof yourself. This repo’s proof script does **not** call live Telnyx.

Proof (mock only): `scripts/prove-cloud-provision.sh`

## Price refresh

The hub runs `startPriceRefreshLoop()` every **6 hours** (`PRICE_REFRESH_INTERVAL_MS`) and on startup if the last success is older than the interval.

| Source | What it prices |
|--------|----------------|
| LiteLLM `model_prices_and_context_window.json` | Frontier LLM tokens, OpenAI Whisper, OpenAI TTS |
| OpenRouter `/api/v1/models` | Optional LLM corroboration when `OPENROUTER_API_KEY` is set |
| Telnyx listed | `telnyx:inbound` per minute (`TELNYX_INBOUND_PER_MIN_USD`) |
| Deepgram / ElevenLabs listed | Nova-2 per minute, Flash per 1k chars |
| Host SKU tables | Render / Railway / AWS monthly bundle (2 web + Postgres + Redis) |
| AWS Price List | Reachability / publication date (bundle cents stay on the host table) |

Rules:

- `POST /api/admin/pipeline/estimate` never calls vendors. It reads the latest `rate_card_versions` row plus `price_overrides`.
- A failed feed keeps last-good prices and marks that source **stale** (warning after 24h).
- `PRICE_REFRESH_ENABLED=false` stays on the seed card (air-gap) and shows a banner.
- Superadmin **Refresh now** and SKU overrides live on the Pipeline / Settings surfaces.

Store host API keys in Settings (encrypted `platform_settings`) or env: `RENDER_API_KEY`, `RAILWAY_TOKEN`, `AWS_*`.

## Runtime notes

- Bind **`0.0.0.0:$PORT`**. Control plane skips port fallback when `DEPLOYMENT_PROFILE=cloud-api` or `CLOUD_BIND_EXACT_PORT=1`.
- Isolated stacks use `ADMIN_AUTH_MODE=hybrid` and `ALLOW_ADMIN_API_KEY_IN_PROD=true` so hub Apply can authenticate with the bootstrap key.
- Cloud STT modes: `openai_whisper`, `deepgram` (**chunked** PCM → WAV → vendor). Streaming Deepgram is out of scope.
- Ephemeral disks: do not rely on local WAV volumes; use object storage for recordings on cloud hosts.
