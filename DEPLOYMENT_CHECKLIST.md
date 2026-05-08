# Deployment Checklist

## Production hosts (Ubuntu / managed)

- [ ] Tree installed at `/opt/veralux/veralux-voice-runtime` and kept in sync with this repository.
- [ ] Secrets and tunables live only in **`/etc/veralux/voice-runtime.env`** (never a random Git clone `.env`).
- [ ] Run **systemd** `cloudflared` with `/etc/cloudflared/config.yml` (no duplicate Docker tunnel for the same hostnames).
- [ ] Bring-up: `scripts/start-production.sh` — validate: `./scripts/validate-voice-topology.sh $VERALUX_COMPOSE_ENV_FILE`
- [ ] See **PRODUCTION_TOPOLOGY.md**, **PRODUCTION_HARDENING_REPORT.md**, **.env.production.example**.

## Pre-Deploy

- [ ] Set production env vars (minimum):
  - [ ] `NODE_ENV=production`
  - [ ] `VOICE_CONTROL_API_KEY` (or `CONTROL_PLANE_API_KEY`)
  - [ ] `TELNYX_VERIFY_SIGNATURES=true`
  - [ ] `TELNYX_SKIP_SIGNATURE=false`
  - [ ] `TELNYX_SIGNATURE_MAX_SKEW_SECONDS=300` (or approved value)
  - [ ] `TELNYX_SIGNATURE_REPLAY_TTL_SECONDS`
  - [ ] `TELNYX_WEBHOOK_IDEMPOTENCY_TTL_SECONDS`
  - [ ] `ALLOW_PROD_DEBUG_CAPTURE=false` (default; keep false unless emergency)
- [ ] Confirm Redis and Postgres are healthy.
- [ ] Confirm backups are current and restorable.
- [ ] Confirm admin API key production policy (`ALLOW_ADMIN_API_KEY_IN_PROD=false` unless explicitly approved).
- [ ] Confirm tenant limits migration has run (`0012_tenant_limits_usage.sql`).
- [ ] Confirm each onboarded tenant has reviewed limits and billing status:
  - [ ] `GET /api/admin/tenants/:tenantId/limits`
  - [ ] `GET /api/admin/tenants/:tenantId/usage`
  - [ ] `GET /api/admin/tenants/:tenantId/billing-summary?month=YYYY-MM`

## Build + Test Validation Commands

### Runtime

```bash
cd veralux-voice-runtime
npm test -- --test tests/telnyxVerify.test.ts tests/webhookReplayGuard.test.ts tests/voiceControlAuth.test.ts tests/redaction.test.ts tests/circuitBreaker.test.ts tests/sessionManager.test.ts
npm test -- --test tests/tenantUsageLimits.test.ts
npm run build
```

### Control-plane

```bash
cd control-plane
npm test
npm run test:production-readiness
```

### Test Infrastructure (local/CI)

```bash
./scripts/test-infra.sh up
./scripts/test-infra.sh wait
./scripts/test-infra.sh reset
```

## Local Smoke Test Commands

```bash
# from repo root
docker compose up -d redis postgres
cd veralux-voice-runtime && npm run dev
```

In another shell:

```bash
curl -i http://localhost:4001/health/live
curl -i http://localhost:4001/health/ready

# Should reject unauthenticated voice-control
curl -i http://localhost:4001/v1/calls/test-call/voice
```

## Production Verification Commands

```bash
# Runtime health
curl -fsS https://<runtime-host>/health/live
curl -fsS https://<runtime-host>/health/ready

# Control-plane health
curl -fsS https://<control-plane-host>/health
curl -fsS https://<control-plane-host>/ready
```

## Webhook Security Verification

- [ ] Send valid signed webhook => expect `200 { ok: true }`.
- [ ] Re-send exact same signed webhook => expect replay rejection/dedupe behavior.
- [ ] Send stale timestamp webhook => expect `401 invalid_signature`.
- [ ] Check logs for structured `verify_reason` on failures.

## Outage Simulation Commands

```bash
# Simulate Redis outage (local docker compose)
docker compose stop redis
curl -i http://localhost:4001/health
curl -i http://localhost:4001/health/ready

# Restore Redis
docker compose start redis
```

```bash
# Simulate provider timeout path by pointing BRAIN_URL to non-routable endpoint
export BRAIN_URL=http://127.0.0.1:9/reply
# Then place a test call and verify fallback + provider_timeout metric
curl -fsS http://localhost:4001/metrics | rg "provider_timeout_total|provider_circuit_open_total"
```

## Rollback Checklist

- [ ] Restore previous image tags.
- [ ] Confirm DB backup point available.
- [ ] Validate health endpoints after rollback.
- [ ] Confirm webhook verification policy remains secure after rollback.

## Remaining Risks Before Enterprise Readiness

- [ ] No SOC2/HIPAA/enterprise compliance attestation yet.
- [ ] Provider failover is improved but not zero-impact for all outage classes.
- [ ] Redis HA topology is required for stronger SLA posture.
- [ ] Tenant isolation has SMB-grade validation and still needs third-party pen testing before enterprise tier.
- [ ] Keep conservative SLA language for first three paid pilots.
