# Production Hardening Report

## Scope

This pass implemented targeted production hardening without changing core architecture or public API contracts.
This update extends the first security pass with resilience, circuit-breakers, redaction enforcement, and launch-test scaffolding.

## Implemented Changes

### P0 Security

1. **Webhook signature hardening**
   - Added explicit failure reasons in Telnyx signature verification.
   - Added configurable timestamp tolerance (`TELNYX_SIGNATURE_MAX_SKEW_SECONDS`).
   - Enforced startup fail-fast in production if signature verification is disabled.
   - Files:
     - `veralux-voice-runtime/src/telnyx/telnyxVerify.ts`
     - `veralux-voice-runtime/src/env.ts`
     - `veralux-voice-runtime/.env.example`

2. **Replay protection + idempotency**
   - Added durable Redis-backed replay protection for:
     - signature+timestamp replay
     - webhook event-id dedupe
   - Added TTL-based replay/idempotency keys.
   - Files:
     - `veralux-voice-runtime/src/telnyx/webhookReplayGuard.ts`
     - `veralux-voice-runtime/src/routes/telnyxWebhook.ts`

3. **Runtime voice-control endpoint authentication**
   - Added auth guard to `/v1/calls/:callControlId/voice` (GET/POST).
   - Accepts bearer or `x-admin-key` style token, validated against `VOICE_CONTROL_API_KEY` (fallback `CONTROL_PLANE_API_KEY`).
   - Production startup now fails if no voice-control key is configured.
   - Files:
     - `veralux-voice-runtime/src/security/voiceControlAuth.ts`
     - `veralux-voice-runtime/src/server.ts`
     - `veralux-voice-runtime/src/env.ts`

4. **Sensitive log redaction improvement**
   - Removed unredacted stream URL token logging on Telnyx streaming start event.
   - File:
     - `veralux-voice-runtime/src/telnyx/telnyxClient.ts`

5. **Credential hashing upgrade path**
   - Replaced owner passcode SHA-256-only flow with modern hashing strategy:
     - prefers Argon2id if module available
     - falls back to bcrypt
   - Added automatic migration: legacy SHA-256 hash is upgraded on successful auth.
   - Added timing-safe compare for legacy hash verification.
   - Files:
     - `control-plane/src/ownerAuth.ts`
     - `control-plane/package.json`

6. **Authentication brute-force hardening**
   - Added IP-based rate limiting to:
     - `/admin-auth`
     - `/api/owner/login`
   - Replaced plain string compare with timing-safe compare in `/admin-auth`.
   - File:
     - `control-plane/src/server.ts`

7. **Production auth-default tightening**
   - Changed control-plane entrypoint default:
     - `ALLOW_ADMIN_API_KEY_IN_PROD` now defaults to `false`.
   - File:
     - `control-plane/scripts/docker-entrypoint.sh`

### Test Additions

1. Runtime tests
   - `veralux-voice-runtime/tests/telnyxVerify.test.ts`
     - valid signature accepted
     - invalid signature rejected
     - timestamp drift rejected
   - `veralux-voice-runtime/tests/webhookReplayGuard.test.ts`
     - signature replay rejected
     - duplicate event-id deduped
   - `veralux-voice-runtime/tests/voiceControlAuth.test.ts`
     - missing auth rejected at token extraction layer
     - valid token accepted at token extraction layer

2. Control-plane tests
   - `control-plane/tests/ownerAuth.test.js`
     - legacy SHA-256 credentials migrate safely
     - malformed hashes rejected
     - legacy mismatch path remains safe

3. Existing test script updated
   - `control-plane/package.json` now includes `tests/ownerAuth.test.js` in `npm test`.

### Wave 2 Reliability + Observability

1. **Provider circuit-breaker framework**
   - Added runtime circuit-breaker utility with open/half-open/closed transitions.
   - Integrated into:
     - brain HTTP reply path
     - brain streaming path
     - Telnyx call-control API path
   - Files:
     - `veralux-voice-runtime/src/providers/circuitBreaker.ts`
     - `veralux-voice-runtime/src/ai/brainClient.ts`
     - `veralux-voice-runtime/src/telnyx/telnyxClient.ts`

2. **Centralized redaction utility**
   - Added redaction for tokens, signatures, query-token URLs, phone-like data, emails, and transcript fields (configurable).
   - Integrated at logger hook level so object payload logs default to redacted.
   - Files:
     - `veralux-voice-runtime/src/observability/redaction.ts`
     - `veralux-voice-runtime/src/log.ts`

3. **Degraded-mode and security metrics expansion**
   - Added counters for:
     - `provider_timeout_total`
     - `provider_circuit_open_total`
     - `dependency_unavailable_total`
     - `webhook_signature_failure_total`
     - `webhook_replay_rejected_total`
     - `tenant_auth_failure_total`
   - Wired into health checks, webhook verifier path, and voice-control auth.
   - Files:
     - `veralux-voice-runtime/src/metrics.ts`
     - `veralux-voice-runtime/src/routes/health.ts`
     - `veralux-voice-runtime/src/routes/telnyxWebhook.ts`
     - `veralux-voice-runtime/src/security/voiceControlAuth.ts`

4. **Production debug-capture guardrail**
   - Added production fail-fast when debug capture flags are enabled unless explicitly allowed.
   - Files:
     - `veralux-voice-runtime/src/env.ts`

5. **Stress/edge-case test expansions**
   - Added:
     - circuit-breaker behavior tests
     - redaction safety tests
     - webhook duplicate event-id dedupe integration test
     - webhook reorder tolerance integration test
   - Files:
     - `veralux-voice-runtime/tests/circuitBreaker.test.ts`
     - `veralux-voice-runtime/tests/redaction.test.ts`
     - `veralux-voice-runtime/tests/callFlow.integration.test.ts`

6. **Pilot acceptance harness scaffold**
   - Added runnable pilot acceptance webhook harness (duplicate replay, invalid/stale signature, baseline initiated flow).
   - Files:
     - `veralux-voice-runtime/scripts/pilot-acceptance-harness.ts`
     - `veralux-voice-runtime/package.json` (`pilot:acceptance`)

## Risks Fixed

- Publicly exploitable webhook replay path reduced via Redis replay keys.
- Signature verification disable-by-default risk removed for production.
- Runtime voice hot-swap control endpoint no longer unauthenticated.
- Owner passcode hash storage upgraded from weak SHA-256.
- Installer/owner login brute-force surface reduced with explicit rate limits.
- Stream token leakage in logs reduced.
- Production default now avoids silent admin-key enablement.

## Remaining Known Risks (Not Fully Resolved in This Pass)

- Full cross-provider failover orchestration (STT/TTS/LLM) remains partial (circuit breaker present, provider switching still limited).
- Some Redis outage paths still fail closed; degraded service policies need explicit product decisions.
- Full webhook ordering chaos suite and large-scale concurrency stress suite are still incomplete.
- End-to-end tenant isolation penetration tests are still incomplete.
- Control-plane log redaction centralization is still incomplete.

## Migration Notes

- Legacy `owner_passcodes.passcode_hash` values are upgraded on first successful login.
- No schema migration required for passcode hash format change.
- Production operators must set:
  - `VOICE_CONTROL_API_KEY` (or `CONTROL_PLANE_API_KEY`)
  - `TELNYX_VERIFY_SIGNATURES=true`
  - `TELNYX_SKIP_SIGNATURE=false`

## Rollout Considerations

1. Deploy to staging with Redis available.
2. Validate webhook verification + replay behavior against Telnyx test events.
3. Monitor for `replay_rejected` and `invalid_signature` spikes post rollout.
4. Inform support teams that first owner login may trigger hash migration.

## Operational Recommendations

- Add alerts on:
  - `provider_circuit_open_total`
  - `provider_timeout_total`
  - `dependency_unavailable_total`
  - `webhook_signature_failure_total`
  - `webhook_replay_rejected_total`
- Run quarterly credential hash policy review to keep work factors current.

## Validation Commands

```bash
# Runtime targeted reliability/security tests
cd veralux-voice-runtime
npm test -- --test tests/telnyxVerify.test.ts tests/webhookReplayGuard.test.ts tests/voiceControlAuth.test.ts tests/redaction.test.ts tests/circuitBreaker.test.ts tests/sessionManager.test.ts

# Runtime build validation
npm run build

# Control-plane full tests
cd ../control-plane
npm test

# Pilot acceptance harness
cd ../veralux-voice-runtime
RUNTIME_BASE_URL=http://localhost:4001 TELNYX_WEBHOOK_SECRET=<secret> npm run pilot:acceptance
```

## Deterministic Test Infrastructure

- Added isolated test compose stack: `docker-compose.test.yml`
- Added orchestration script: `scripts/test-infra.sh` (`up|wait|reset|status|logs|down`)
- Added test env template: `.env.test.example`
- Default test ports avoid production defaults:
  - Postgres `55432`
  - Redis `56379`

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation is established by repo evidence alone.
- Provider failover still cannot be claimed zero-impact for all outage classes.
- Redis HA/replication is required for stronger SLA commitments.
- Tenant isolation is validated to SMB depth but should receive third-party penetration testing before enterprise.
- First three paid pilots should keep conservative SLA language and explicit upstream-provider exclusions.
