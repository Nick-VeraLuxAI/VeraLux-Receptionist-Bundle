#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "assert-receptionist-desk-source: FAIL: $*" >&2; exit 1; }

grep -q "export function planReceptionistTurn" "$ROOT/shared/src/callBoard.ts" || fail "missing planReceptionistTurn"
grep -q "export function applySpeakPolicy" "$ROOT/shared/src/callBoard.ts" || fail "missing applySpeakPolicy"
grep -q "export function ingestDtmfDigit" "$ROOT/shared/src/callBoard.ts" || fail "missing ingestDtmfDigit"
grep -q "intakeProfile" "$ROOT/shared/src/runtimeContract.ts" || fail "missing intakeProfile on runtime contract"
grep -q "faq_hours" "$ROOT/shared/src/shopPlaybook.ts" || fail "missing faq_hours cutover row"
grep -q "quote_or_hold" "$ROOT/shared/src/shopPlaybook.ts" || fail "missing quote_or_hold cutover row"
grep -q "planDeskTurn" "$ROOT/veralux-voice-runtime/src/calls/callSession.ts" || fail "missing planDeskTurn"
grep -q "await this.cidLookupPromise" "$ROOT/veralux-voice-runtime/src/calls/callSession.ts" || fail "missing CID await"
grep -q "onDemoShopDtmf" "$ROOT/veralux-voice-runtime/src/calls/callSession.ts" || fail "missing DTMF merge on CallSession"
grep -q "normalizeIntakeProfile" "$ROOT/control-plane/src/runtime/buildTenantRuntimeConfig.ts" || fail "missing intakeProfile publish"
grep -q "bookingMissingFields" "$ROOT/control-plane/src/nightDesk/evaluate.ts" || fail "missing intake-profile bookingMissing"
grep -q "transfersOn" "$ROOT/patches/callSession.js" || fail "MUSTBOOK handoff rewrite must no-op when transfers are on"
grep -q "planReceptionistTurn" "$ROOT/patches/callSession.js" || fail "live mount missing Call Board plan hook"
[[ -x "$ROOT/scripts/receptionist-desk-proof.sh" ]] || fail "receptionist-desk-proof.sh not executable"
echo "assert-receptionist-desk-source: OK"
