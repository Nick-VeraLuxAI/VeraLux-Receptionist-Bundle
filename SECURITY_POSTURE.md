# Security Posture

## Current Security Controls (Implemented)

### Webhook Trust Boundary

- Telnyx webhook signatures are verified with timestamp tolerance.
- Production startup fails if signature verification is disabled.
- Replay protection:
  - signature+timestamp replay cache
  - event-id idempotency cache

### Runtime Control Surface

- `/v1/calls/:callControlId/voice` now requires API token auth.
- Production requires configured voice-control token.

### Credential Protection

- Owner passcodes now use modern hashing:
  - Argon2id when available
  - bcrypt fallback
- Legacy SHA-256 hashes are auto-migrated on successful login.
- Legacy compare path uses timing-safe comparison.

### Authentication Abuse Protection

- Rate limiting applied to:
  - `/admin-auth`
  - `/api/owner/login`

### Secret/Token Exposure Reduction

- Stream URL token redaction improved in Telnyx streaming start logs.
- Centralized object log redaction added for:
  - tokens/bearer credentials/signatures/secrets
  - phone-like values and emails
  - transcript-like fields by default

### Production Debug Safety

- Runtime now fails startup in production when debug-capture flags are enabled unless explicitly overridden with `ALLOW_PROD_DEBUG_CAPTURE=true`.

## Residual Risks

- Control-plane log redaction is not yet fully centralized.
- Cross-provider AI failover strategy is still partial.
- Chaos/fault-injection coverage is still expanding.

## Security Baseline Requirements

- `NODE_ENV=production`
- `TELNYX_VERIFY_SIGNATURES=true`
- `TELNYX_SKIP_SIGNATURE=false`
- `ALLOW_ADMIN_API_KEY_IN_PROD=false` unless explicit exception
- `VOICE_CONTROL_API_KEY` configured
- `ALLOW_PROD_DEBUG_CAPTURE=false` in normal production operations

## Recommended Next Security Milestones

1. Add security-focused integration tests for all sensitive admin/provisioning routes.
2. Add account lockout and anomaly alerts for owner/admin login abuse.
3. Add centralized redaction middleware for logs (phone/transcript/token classes).
4. Add periodic key rotation and secret provenance checks.

## Targeted Security Test Commands

```bash
cd veralux-voice-runtime
npm test -- --test tests/telnyxVerify.test.ts tests/webhookReplayGuard.test.ts tests/voiceControlAuth.test.ts tests/redaction.test.ts
```

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation yet.
- Provider failover is still not guaranteed zero-impact in all scenarios.
- Redis HA is required for stronger high-availability/SLA guarantees.
- Tenant isolation has SMB-grade validation but still needs third-party pen testing before enterprise rollout.
- First three pilots should retain conservative SLA language with upstream outage exclusions.
