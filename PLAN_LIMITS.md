# Plan Limits

## Plan Tiers

- `starter`: single-location starter footprint, strict caps, no advanced workflows/integrations.
- `professional` (recommended paid pilot default): balanced SMB limits with overage support.
- `premium`: higher concurrency/capacity and broader feature access.
- `enterprise`: high-cap, high-scale configuration.

## Hard vs Soft Limits

- Hard limits:
  - `maxConcurrentCalls`
  - `maxDailyCalls`
  - `maxMonthlyCalls`
  - `maxMonthlyMinutesHardCap`
  - feature flags (`smsFollowup`, `calendarIntegration`, `crmIntegration`, `advancedAnalytics`, `callRecording`, `multiLocation`, `customWorkflows`)
  - suspended/canceled `billingStatus`
- Soft limits:
  - `includedMonthlyMinutes` when `overageMode=allow_and_bill` (call is allowed, overage is tracked)

## Overage Behavior

- `allow_and_bill`: calls continue beyond included minutes; overage minutes/charge are reported.
- `throttle`: usage beyond included minutes is blocked with a deterministic throttle response.
- `hard_stop`: usage beyond included minutes is blocked.

## Validation

- All limit fields are validated server-side by schema and DB constraints.
- Negative values are rejected.
- Invalid plan tiers/billing statuses are rejected.
- `transcriptRetention=false` is rejected for safety baseline.

## Enforcement Path

- Runtime inbound call gate checks:
  - tenant billing status
  - daily/monthly call caps
  - monthly hard cap
  - overage mode behavior
- Concurrency is enforced by runtime capacity guard using published per-tenant caps.
- Phone number ownership remains enforced by DID-to-tenant mapping.

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation yet.
- Provider failover still not guaranteed zero-impact.
- Redis HA is required for stronger SLA targets.
- Tenant isolation is validated for SMB scope and should still be third-party pen tested before enterprise.
- First three pilots should maintain conservative SLA language.

