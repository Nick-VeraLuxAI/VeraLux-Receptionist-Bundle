# Call Quality Analytics — Implementation Report

Date: 2026-05-09

## 1. Files changed (high level)

| Area | Paths |
|------|--------|
| Shared contract | `shared/src/runtimeContract.ts` |
| Control plane | `control-plane/migrations/0014_call_quality.sql`, `control-plane/src/db.ts`, `control-plane/src/auth.ts`, `control-plane/src/server.ts`, `control-plane/src/runtime/buildTenantRuntimeConfig.ts`, `control-plane/src/runtime/runtimeContract.ts`, `control-plane/src/callQualityMaps.ts`, `control-plane/public/admin.html`, `control-plane/tests/sprint0Security.test.js`, `control-plane/tests/runtimeContract.test.js` |
| Voice runtime | `veralux-voice-runtime/src/observability/audioForensics.ts`, `callQualityPolicy.ts`, `callQualitySummary.ts`, `controlPlane.ts`, `calls/sessionManager.ts`, `calls/callSession.ts`, `calls/callAudioCoordinator.ts`, `server.ts`, `tests/callQualityPolicy.test.ts` |
| Scripts / docs | `scripts/cleanup-call-quality-artifacts.sh`, `docs/CALL_QUALITY_ANALYTICS.md`, `docs/AUDIO_FORENSICS.md`, this report |

## 2. Database changes

Migration `0014_call_quality.sql`:

- `tenant_call_quality_settings` — one row per tenant (PK `tenant_id`), booleans, `transcript_retention_days`, raw diagnostics mode/expires/reason/enabled-by, `raw_audio_diagnostics_next_call_pending`, client visibility flags.
- `call_quality_summaries` — `(tenant_id, call_control_id)` unique, `summary` JSONB.
- `admin_audit_logs.details` — optional JSONB for richer audit payloads.

## 3. API endpoints

| Method | Path | Auth | Notes |
|--------|------|------|------|
| GET | `/api/admin/tenants/:tenantId/call-quality-settings` | adminGuard(viewer) + tenant access | Viewer response omits raw diagnostics fields. |
| PATCH | `/api/admin/tenants/:tenantId/call-quality-settings` | adminGuard(admin) + tenant access | JWT tenant-admin cannot set raw diagnostics or client raw-artifacts flags. |
| POST | `/api/admin/tenants/:tenantId/raw-audio-diagnostics/enable-next-call` | admin + **super-admin** | Body: `reason`, `expiresAt`, optional `mode`. |
| POST | `/api/admin/tenants/:tenantId/raw-audio-diagnostics/disable` | admin + **super-admin** | Body: `reason`. |
| POST | `/api/runtime/call-quality-summary` | admin key / super-admin | Voice runtime upserts summary. |
| POST | `/api/runtime/tenants/:tenantId/diagnostics/consume-next-call-arm` | admin key | Clears one-shot arm + republishes Redis. |
| GET | `/api/owner/call-quality-summary/:callControlId` | owner JWT | Safe mapped labels only. |
| GET | `/api/owner/calls/:callId` | owner JWT | Adds `transcriptsDisabled`, optional `callQuality` if `lead.voiceCallControlId` is set. |

Existing `AUDIO_FORENSICS_*` env behavior is **unchanged**.

## 4. UI changes

- Admin **Call Quality** tab: general toggles, retention, client summary; super-admin raw diagnostics panel with warning, reason, expiration, enable/disable POSTs.

## 5. Runtime behavior

- `callQuality` is published on the Redis runtime tenant config (merged in `buildTenantRuntimeConfig`).
- `resolveRawForensicsCapture` gates WAV/timeline capture: env override **or** tenant raw diagnostics policy (`all_calls_temporary` with valid `expiresAt`, or `next_call_only` / `failed_calls_only` with `rawAudioDiagnosticsNextCallPending`).
- Forensics `manifest.jsonl` first line includes `rawAudioDiagnostics` metadata (mode, reason, expires, tenantId, operator override flags).
- On teardown, if analytics enabled, runtime sends **quality summary** JSON to the control plane **before** closing the forensics session (so `timeline.jsonl` can still be read).

## 6. Privacy safeguards

- Super-admin only for raw diagnostics enable/disable.
- Tenant JWT cannot escalate raw diagnostics or client raw-artifacts visibility.
- Owner portal mapping strips internal JSON; only human-readable labels.
- No provider URLs or secrets added to quality summaries.
- Operator env override is explicitly logged.

## 7. Tests added

- `veralux-voice-runtime/tests/callQualityPolicy.test.ts` — defaults and tenant pending arm.
- `control-plane/tests/runtimeContract.test.js` — optional `callQuality` in parsed config.
- `control-plane/tests/sprint0Security.test.js` — updated `buildTenantRuntimeConfig` arity.

## 8. Commands run

```bash
npm run build
npm test -w veralux-voice-runtime
cd control-plane && npm run build && node --test tests/auth.test.js … tests/callSanitizer.test.js   # excluding sprint1ClientReadiness when DB noisy
```

Full `npm test -w control-plane` may still run `sprint1ClientReadiness.test.js` against a shared Postgres instance (migration race); use a clean DB or exclude that file for green CI on a dirty dev DB.

## 9. Remaining limitations

- **Failed-calls-only** mode currently uses the same **one-shot pending + consume on first forensics session** behavior as next-call (documented in product doc); refining “only on failure” without capturing successful calls would need additional lifecycle hooks and optional post-success artifact deletion.
- Owner call detail links quality to Postgres `calls.lead.voiceCallControlId` when present; otherwise use the dedicated owner summary endpoint with Telnyx `call_control_id`.
- Cleanup script uses **directory mtime** heuristics under `AUDIO_FORENSICS_DIR`; tune `CUTOFF_SECS` in-script for your retention policy.

## 10. Recommended pilot defaults

Same as `docs/CALL_QUALITY_ANALYTICS.md` §7: analytics on, transcripts on, 30-day retention, client summary on, raw diagnostics off unless investigating, client raw artifacts never enabled.
