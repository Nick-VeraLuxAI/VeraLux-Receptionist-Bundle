# LLM provider implementation report

**Date:** 2026-05-09

## Root cause (historical)

`generateAssistantReply` routed to **`brain_http`** whenever `BRAIN_USE_LOCAL` was false and **`BRAIN_URL`** was set, **ignoring** control-plane `LLM_PROVIDER=openai` and any tenant intent. Example `.env` shipped `BRAIN_URL=http://brain:3001` without the `llm` profile → live calls failed.

## What changed

### Voice runtime (`veralux-voice-runtime`)

- **`PLATFORM_LLM_PROVIDER`** (default `brain_local`), optional **`LLM_PROVIDER`** legacy alias, **`OPENAI_API_KEY`**, **`OPENAI_MODEL`**, **`OPENAI_BASE_URL`** in `src/env.ts`.
- **`src/ai/llmProviderResolve.ts`**: deterministic platform + tenant precedence.
- **`src/ai/brainClient.ts`**: resolution-driven routing; **OpenAI direct** path; streaming only for **`brain_http`** plan.
- **`src/controlPlaneTenantSecrets.ts`**: fetch tenant OpenAI key from control plane (Bearer admin key).
- **`src/calls/callSession.ts`**: passes **`tenantConfig`** into LLM calls.
- **`src/routes/health.ts`**: strict readiness adds **`openai_platform`** when platform OpenAI is selected with an invalid key.
- **`src/healthBrainGate.ts`**: `voiceStrictPlaneReady` accepts optional **`platformOpenaiOk`**.

### Shared contract (`@veralux/shared`)

- **`llmRouting`** on `RuntimeTenantConfig` + **`TENANT_LLM_OPENAI_SECRET_KEY`**.

### Control plane

- **`src/tenantLlmHandlers.ts`**: admin/owner CRUD + test + runtime secret GET; **`applyTenantLlmPortalPatch`** clears secrets when switching to **platform default**.
- **`src/runtime/buildTenantRuntimeConfig.ts`**: publishes `llmRouting` from `operator_state.llmPortal`.
- **`src/server.ts`**: registers routes after `ensureTenantAccess` exists.
- **`public/owner.html`**: optional tenant key UI.
- **`tests/runtimeContract.test.js`**: optional `llmRouting` parse.

### Ops

- **`docker-compose.yml`**: runtime env for `PLATFORM_LLM_PROVIDER`, `OPENAI_BASE_URL`.
- **`scripts/preflight.sh`**: checks `PLATFORM_LLM_PROVIDER` vs `BRAIN_URL` / `OPENAI_API_KEY`.

### Tests / docs

- `veralux-voice-runtime/tests/llmProviderResolve.test.ts`, `tests/brainClientPrompts.test.ts` (`PLATFORM_LLM_PROVIDER=brain_http`), `tests/testEnv.ts` default `brain_local`, `tests/healthBrainGate.test.ts` platform OpenAI gate.
- This report plus `docs/LLM_PROVIDER_ARCHITECTURE.md` and `docs/TENANT_LLM_API_KEYS.md`.

## Validation (local)

```bash
npm run build -w @veralux/shared
npm run build -w veralux-voice-runtime
npm test -w veralux-voice-runtime
npm run build -w control-plane
npm test -w control-plane
npm run test:production-readiness
```

All completed with **exit code 0** on 2026-05-09.

## Manual smoke

1. Set **`PLATFORM_LLM_PROVIDER=brain_local`** (default) → place a call; confirm answers for hours/pricing-style prompts without a brain container.
2. With **`PLATFORM_LLM_PROVIDER=brain_http`** and a running brain → confirm HTTP path still works.
3. Configure **tenant API key** via owner UI → confirm GET never returns raw key; call uses tenant OpenAI when `llmRouting.mode=tenant_api_key`.
4. `curl -s http://localhost:4001/health/voice` with `PLATFORM_LLM_PROVIDER=openai` and `OPENAI_API_KEY=CHANGE_ME` → expect **`not_ready`** and `openai_platform` failure.

## Rollback

- Revert to prior runtime image/sha **or** set `PLATFORM_LLM_PROVIDER=brain_local` and remove `llmRouting` from Redis tenant JSON, then republish from control plane.
