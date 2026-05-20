# VeraLux internal tenant — Receptionist bundle

This document describes the **product-side** Postgres tenant for VeraLux’s own Receptionist deployment (`deploymentId: receptionist-veratitan-prod` in VeraLux OS). It does **not** change OS telemetry, deployment IDs, or repo layout.

## Tenant / business id

- **`veralux`** — matches Solomon’s slug for operator mental model (`tenants.id` + `tenant_configs.tenant_id`).

## Reference URLs & purpose

| Field | Value |
|--------|--------|
| Business name | VeraLux AI |
| Public URL | https://voice.veralux.ai |
| Purpose | VeraLux AI phone receptionist |

## Idempotent setup

From **`VeraLux-Receptionist-Bundle/control-plane`** (with `DATABASE_URL` in `.env`):

```bash
npm run seed:veralux-internal
```

Script: `scripts/seed-veralux-internal-tenant.cjs`

- Upserts **`tenants`** row `veralux` / **VeraLux AI**.
- Upserts **`tenant_configs`**: merges **prompts**, **business_hours** (weekly placeholder), **operator_state** (handoff placeholder), and **forwarding_profiles** (only if none exist — otherwise leaves your real profiles).
- **STT/TTS/config** are copied from the existing **`veralux`** config if present, else from **`default`**, else from `scripts/seed-default-runtime-config.json` (Docker-style hostnames in that JSON may need aligning with your stack).

## OS “not_ready” vs product readiness

The Receptionist OS reporter calls the control plane **`/ready`** and treats **`status` of `ok` or `ready`** as healthy (`control-plane/src/veraluxOsReporter.ts`). That is **independent** of whether the **`veralux`** tenant row exists.

## Human follow-ups

1. **DID / Telnyx**: map a real inbound number to tenant `veralux` via operator admin (`tenant_numbers` / DID sync) — the seed script does **not** assign phone numbers.
2. **Secrets**: OpenAI / webhooks live in the secret store or env — not written by this script.
3. **Forwarding**: replace the placeholder forwarding profile with real **E.164** targets when known.
4. **Business hours / timezone**: edit the merged `business_hours` JSON to match real operations (placeholder uses `America/Los_Angeles` Mon–Fri 09:00–17:00).
5. **Restart control-plane** (or your normal reload path) so tenant registry + Redis-published runtime config pick up DB changes.

## Verification

```sql
select id, name from tenants where id = 'veralux';
select tenant_id, updated_at from tenant_configs where tenant_id = 'veralux';
```

Smoke: place a test call only after DID + secrets are configured.

## Risk notes

- Re-running the seed **re-applies** prompt text and placeholder hours/operator_state via merge rules in the script; review script if you customize those in DB and want different merge semantics.
- `forwarding_profiles`: if you already have profiles, the script **keeps** them and does **not** append duplicates.
