# Billing Usage Model

Stripe subscriptions and the live catalog: see [`docs/STRIPE_BILLING.md`](docs/STRIPE_BILLING.md).

## Source of Truth

- `tenant_limits` stores plan metadata and enforceable limits.
- `tenant_usage_daily` stores daily call count/minutes.
- `tenant_usage_monthly` stores monthly call count/minutes and provider usage JSON.

## Usage Calculation

- Billable minutes are rounded up per call: `ceil(durationMs / 60000)`.
- Calls are counted at call start.
- Minutes/fallback usage are recorded at call end.
- Monthly overage:
  - `overageMinutes = max(0, billableMinutes - includedMonthlyMinutes)`
  - `estimatedOverageChargeCents = overageMinutes * monthlyMinuteOverageRateCents`

## Export Primitive

- Endpoint: `GET /api/admin/tenants/:tenantId/billing-summary?month=YYYY-MM`
- Response includes:
  - `planTier`
  - `billingStatus`
  - `includedMinutes`
  - `billableMinutes`
  - `overageMinutes`
  - `estimatedOverageChargeCents`
  - `callsCount`

## Validation Commands

```bash
cd control-plane
npm test
```

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" -H "X-Tenant-ID: default" \
  "http://localhost:4000/api/admin/tenants/default/billing-summary?month=$(date +%Y-%m)"
```

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation yet.
- Provider failover cannot be considered zero-impact in all conditions.
- Redis HA architecture is required for stronger SLA guarantees.
- Tenant isolation is validated for SMB scope; enterprise readiness still requires third-party penetration testing.
- First three pilots should use conservative SLA commitments.

