# Tenant LLM API keys (OpenAI)

## Storage

- Secret key in the encrypted store: **`llm_openai_api_key`** (constant `TENANT_LLM_OPENAI_SECRET_KEY` in `@veralux/shared`).
- Portal metadata (mode, model, fingerprint, last test) lives in **`tenant_configs.operator_state.llmPortal`** and is merged into published Redis config as **`llmRouting`** (no raw key).

## Control plane HTTP API

All responses avoid raw secrets.

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| `GET` | `/api/admin/tenants/:tenantId/llm-config` | Admin | Summary for assigned tenant. |
| `POST` | `/api/admin/tenants/:tenantId/llm-config` | Admin | Body: `mode`, `tenantProvider`, `tenantModel`, optional `apiKey`, `removeApiKey`, `tenantKeyErrorPolicy`. |
| `POST` | `/api/admin/tenants/:tenantId/llm-config/test` | Admin | Body: `apiKey`, optional `model` — validates key against OpenAI; updates `lastTestedAt` / `lastStatus`. |
| `GET` | `/api/owner/llm-config` | Owner session | Same summary shape for the logged-in tenant. |
| `POST` | `/api/owner/llm-config` | Owner session | Same as admin POST for own tenant. |
| `POST` | `/api/owner/llm-config/test` | Owner session | Same as admin test. |
| `GET` | `/api/runtime/tenants/:tenantId/secrets/llm_openai_api_key` | Admin (service) | **Server-to-server only.** Returns `{ apiKey: string \| null }` for the voice runtime. |

## Runtime retrieval

- `veralux-voice-runtime` calls the runtime secret endpoint when **`CONTROL_PLANE_URL`** + **`CONTROL_PLANE_API_KEY`** are set and the tenant is in **`tenant_api_key`** mode with `tenantApiKeyConfigured`.
- Short TTL in-memory cache (45s) per tenant id to limit control-plane load.

## Owner UI

- `control-plane/public/owner.html` includes an **optional OpenAI API key** card wired to the owner routes above.

## Rollback

1. Set owner/admin LLM mode to **platform default** (clears stored tenant secret in the normal flow).
2. Set `PLATFORM_LLM_PROVIDER=brain_local` on the voice runtime.
3. Republish tenant config from the control plane if Redis still carried `llmRouting`.
