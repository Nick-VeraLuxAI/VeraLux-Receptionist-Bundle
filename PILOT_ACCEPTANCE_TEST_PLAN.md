# Pilot Acceptance Test Plan

## Objective

Validate that the platform is safe for first paid SMB pilots with deterministic fallback behavior, isolation checks, and security controls active.

## Test Matrix (30–50 Calls)

- 10x normal intake/booking calls
- 5x FAQ-only calls
- 5x after-hours flows
- 5x escalation/transfer flows
- 3x silence/dead-air calls
- 3x interruption/barge-in calls
- 3x hangup-mid-response calls
- 2x invalid signature attempts
- 2x duplicate webhook replay attempts
- 2x delayed/reordered webhook attempts
- 2x tenant isolation violation attempts (admin/runtime scopes)

## Required Pass Criteria

- No stuck call states.
- No duplicate AI responses from duplicate/reordered events.
- Signature failures and replays rejected deterministically.
- Fallback prompt path used on provider timeout; no silent hang.
- No cross-tenant read/write success in test probes.
- No secrets/tokens/PII exposed in standard logs.

## Execution Commands

```bash
# 1) Run security/reliability tests
cd veralux-voice-runtime
npm test -- --test tests/telnyxVerify.test.ts tests/webhookReplayGuard.test.ts tests/voiceControlAuth.test.ts tests/redaction.test.ts tests/circuitBreaker.test.ts tests/sessionManager.test.ts

# 2) Run integration flow tests (requires Redis + integration env)
npm test:integration

# 3) Run pilot webhook harness
RUNTIME_BASE_URL=http://localhost:4001 TELNYX_WEBHOOK_SECRET=<secret> npm run pilot:acceptance
```

## Output Artifacts

- Harness JSON output (pass/fail and failure summary)
- Runtime metrics snapshot (`/metrics`)
- Canary call transcript summary (redacted)
- Launch recommendation: `pilot_pass` or `pilot_blocked`

## Go/No-Go Checklist

- [ ] All required tests pass.
- [ ] No unresolved P0/P1 incidents in prior 7 days.
- [ ] Provider timeout/circuit metrics stable.
- [ ] Security baseline env vars validated.
- [ ] Rollback and incident contacts confirmed.
