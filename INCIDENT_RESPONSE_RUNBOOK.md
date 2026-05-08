# Incident Response Runbook

## Severity Definitions

- **SEV1:** Active client-facing outage (calls failing, no intake).
- **SEV2:** Partial degradation (increased latency/failures).
- **SEV3:** Non-critical error rates or isolated tenant impact.

## Immediate Triage

1. Check runtime and control-plane health endpoints.
2. Check Redis and Postgres connectivity.
3. Check webhook failure reasons (`invalid_signature`, `replay_rejected`, dedupe logs).
4. Identify tenant scope and blast radius.

## Common Incident Playbooks

### 1) Telnyx webhook failures

- Symptoms:
  - 401 on webhook endpoint
  - surge in `invalid_signature` or `replay_rejected`
- Actions:
  1. Verify system clocks are in sync (NTP).
  2. Verify webhook signing secrets/public key.
  3. Verify timestamp tolerance config.
  4. If replay rejects are excessive, inspect retries/duplicate deliveries.

### 1b) Circuit breaker opened (brain/telnyx)

- Symptoms:
  - `provider_circuit_open_total` increasing
  - sharp rise in provider fallback responses
- Actions:
  1. Inspect upstream provider latency/status.
  2. Validate timeout budgets (`BRAIN_TIMEOUT_MS`, Telnyx reachability).
  3. Confirm breaker recovery after `openMs` window.
  4. If persistent, switch to fallback provider path or reduce load.

### 2) Redis unavailable

- Symptoms:
  - replay/idempotency checks failing
  - capacity checks failing
- Actions:
  1. Restore Redis service.
  2. Validate ping from runtime.
  3. Confirm webhook guard and capacity recovery in logs.
  4. Re-run readiness checks.

### 3) Owner/admin auth anomalies

- Symptoms:
  - login failures or brute-force spikes
- Actions:
  1. Confirm rate limiter active.
  2. Check recent auth logs.
  3. Rotate compromised keys if suspected.
  4. Verify `ALLOW_ADMIN_API_KEY_IN_PROD` policy.

## Forensics Data to Collect

- Request IDs and call control IDs.
- Tenant ID and affected phone numbers.
- Relevant structured logs (webhook verify reason, replay decision, auth failure reason).
- Dependency health snapshots.

## Communication Template

- Current status:
- Impacted clients/tenants:
- Start time:
- Mitigation in progress:
- ETA / next update:

## Recovery Validation

1. Run health and readiness probes.
2. Send signed webhook smoke test.
3. Verify voice-control auth rejection for unauthenticated requests.
4. Verify successful owner login and call flow for a canary tenant.
5. Verify metrics stability:
   - no sustained growth in `provider_circuit_open_total`
   - `dependency_unavailable_total` returns to baseline
   - webhook failure counters flatten

## Useful Commands

```bash
# Runtime key counters
curl -fsS http://localhost:4001/metrics | rg "provider_timeout_total|provider_circuit_open_total|webhook_signature_failure_total|webhook_replay_rejected_total|dependency_unavailable_total"
```

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation is currently in place.
- Provider failover paths are improved but not fully zero-impact under all dependencies.
- Redis HA topology is still required for enterprise-level SLA targets.
- Tenant isolation has SMB-grade validation and should still undergo third-party pen testing before enterprise.
- First three pilots should keep conservative SLA terms and explicit third-party outage caveats.
