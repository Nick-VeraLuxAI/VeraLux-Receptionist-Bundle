# Admin Limits Guide

## Admin APIs

- `GET /api/admin/tenants/:tenantId/limits`
- `PATCH /api/admin/tenants/:tenantId/limits`
- `GET /api/admin/tenants/:tenantId/usage`
- `POST /api/admin/tenants/:tenantId/limits/reset-to-plan-defaults`
- `POST /api/admin/tenants/:tenantId/billing-status`
- `GET /api/admin/tenants/:tenantId/billing-summary?month=YYYY-MM`

All routes require admin authentication and tenant authorization.

## Admin Panel Workflow

1. Open **Settings → Tenant Plan & Limits**.
2. Select `planTier`, `billingStatus`, and `overageMode`.
3. Edit numeric caps and feature toggles.
4. Save limits (effective immediately; runtime config sync is automatic).
5. Review **Current Usage** for overage/hard-cap status.

## Safety UX Behavior

- Lowering concurrency below active usage prompts a warning.
- Setting billing status to `suspended`/`canceled` requires confirmation.
- Validation errors are surfaced directly from server responses.
- Last updated metadata is shown in the limits status text.

## Pre-Launch Verification

```bash
cd control-plane
npm test
```

```bash
cd veralux-voice-runtime
npm test -- --test tests/tenantUsageLimits.test.ts
npm run build
```

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" -H "X-Tenant-ID: default" \
  http://localhost:4000/api/admin/tenants/default/limits
curl -s -H "X-Admin-Key: $ADMIN_KEY" -H "X-Tenant-ID: default" \
  http://localhost:4000/api/admin/tenants/default/usage
```

## Remaining Risks Before Enterprise Readiness

- No SOC2/HIPAA/enterprise compliance attestation yet.
- Provider failover is not zero-impact for all dependency failures.
- Redis HA is still required for stronger SLA commitments.
- Tenant isolation is validated to SMB scope but should undergo third-party pen testing before enterprise rollout.
- First three pilots should retain conservative SLA language.

