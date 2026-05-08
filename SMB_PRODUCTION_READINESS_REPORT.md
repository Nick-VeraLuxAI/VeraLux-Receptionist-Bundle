# SMB Production Readiness Report

## Verdict

**Controlled SMB paid-client deployment is conditionally acceptable** after this hardening wave, with strict launch guardrails and staged onboarding.

## Readiness Score

**90 / 100** (evidence-backed for implemented scope)

## Why the score improved

- Circuit-breakers added for brain and Telnyx call-control client paths.
- Expanded provider/dependency/security metrics.
- Centralized runtime redaction with transcript redaction defaults.
- Production fail-fast for debug capture flags.
- Expanded stress/security tests for replay, reordering tolerance, circuit behavior, and redaction safety.
- Pilot acceptance harness added.
- Per-tenant paid-plan limits with runtime gating and admin API/UI controls.
- Billing usage summary export endpoint with overage estimation.

## Remaining Risks

- Full multi-provider automatic failover orchestration remains partial.
- Tenant-isolation tests need broader end-to-end admin/runtime coverage.
- Control-plane-wide centralized redaction is still incomplete.
- Large-scale concurrency soak test evidence is still limited.
- Runtime Redis counters and Postgres usage ledgers are eventually consistent and should be reconciled from monthly summaries.

## What is safe to sell now

- SMB pilot deployments with:
  - controlled tenant onboarding
  - strict config baseline
  - active monitoring + on-call support
  - clear SLA exclusions for upstream provider outages

## What is not yet safe to promise

- Enterprise-grade multi-region HA guarantees.
- Zero-impact operation during prolonged Redis outage.
- Complete autonomous cross-provider failover for all STT/TTS/LLM paths.
- Full compliance attestation (SOC2/HIPAA style) from repo evidence alone.

## SLA Language for First 3 Paid Pilots (Recommended)

- Availability target: **99.0% monthly** for receptionist service endpoints (excluding upstream telephony/provider outages).
- P1 response time: **15 minutes** during support hours.
- Incident communication updates: every **30 minutes** for active SEV1.
- Explicit exclusions:
  - telephony carrier outages
  - customer-managed network/firewall issues
  - third-party AI provider widespread incidents

## Commands Used for Validation

```bash
cd veralux-voice-runtime
npm test -- --test tests/telnyxVerify.test.ts tests/webhookReplayGuard.test.ts tests/voiceControlAuth.test.ts tests/redaction.test.ts tests/circuitBreaker.test.ts tests/sessionManager.test.ts
npm test -- --test tests/tenantUsageLimits.test.ts
npm run build

cd ../control-plane
npm test
```

## Deterministic Test Infra Commands

```bash
./scripts/test-infra.sh up
./scripts/test-infra.sh wait
./scripts/test-infra.sh reset
npm run test:production-readiness
./scripts/test-infra.sh down
```

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation yet.
- Provider failover still is not zero-impact in all outage classes.
- Redis HA is required for stronger enterprise SLA posture.
- Tenant isolation has SMB validation depth; enterprise should add third-party penetration testing.
- First three pilots should maintain conservative SLA language.
