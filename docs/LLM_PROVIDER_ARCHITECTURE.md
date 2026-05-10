# LLM provider architecture (voice runtime)

## Goals

- **Platform default** is predictable and does **not** route to a missing HTTP brain just because `BRAIN_URL` is set.
- **Tenant override** can use an **OpenAI API key** stored encrypted in the control plane; the runtime never receives that key via Redis.
- **Secrets** are never returned to browsers after save; logs must not print raw keys.

## Resolution order (live call)

1. **Tenant `llmRouting`** (published in Redis on `RuntimeTenantConfig.llmRouting`):
   - `mode: tenant_api_key` + `tenantApiKeyConfigured: true` → runtime loads the key from the control plane (`GET /api/runtime/tenants/:tenantId/secrets/llm_openai_api_key` with service auth) and uses **OpenAI Chat Completions** directly (`openai_direct`).
   - If the secret is missing/invalid and `tenantKeyErrorPolicy` is `platform_default`, fall back to the platform plan.
   - If `tenantKeyErrorPolicy` is `fail`, the call returns the configured voice LLM error fallback.

2. **Platform** (`PLATFORM_LLM_PROVIDER`, optional legacy `LLM_PROVIDER` when platform unset):
   - **`brain_local`** (aliases `brain`, `local`, empty): in-process **keyword brain** (`defaultBrainReply`). **Ignores** `BRAIN_URL` for routing.
   - **`brain_http`**: POST to **`BRAIN_URL`** (`/reply` normalization unchanged). Use when the brain sidecar (`docker compose --profile llm`) is running.
   - **`openai`**: **Direct OpenAI** using `OPENAI_API_KEY` / `OPENAI_MODEL` / optional `OPENAI_BASE_URL`. Placeholder keys are rejected and the resolver falls back to `brain_local` with a warning log.

3. **Streaming**: SSE streaming remains **HTTP-brain only** when the resolved plan is `brain_http` and `BRAIN_STREAMING_ENABLED` is true. Other routes use non-streaming completion paths.

## Health (`/health/voice` strict)

- Existing **Redis / STT / TTS** checks unchanged.
- **Brain HTTP** gating still controlled by **`BRAIN_HEALTH_REQUIRED`** (see `HEALTH_MODEL.md`).
- **`openai_platform`**: when `PLATFORM_LLM_PROVIDER` normalizes to `openai`, readiness fails if `OPENAI_API_KEY` is missing or a known placeholder (`CHANGE_ME`, etc.).

## Related docs

- `docs/TENANT_LLM_API_KEYS.md` — owner/admin APIs and storage.
- `docs/LLM_PROVIDER_IMPLEMENTATION_REPORT.md` — change list and validation.
