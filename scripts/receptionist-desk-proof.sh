#!/usr/bin/env bash
set -euo pipefail

# Day + night receptionist proof. Night-desk checks first, then Call Board matrix.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/night-desk-demo-proof.sh"

echo "6/10 call-board FAQ hours"
api POST /api/admin/call-board/plan \
  '{"utterance":"What are your hours today?","quickReply":"We are open Monday through Friday 9 to 5."}' |
  assert_json 'v.plan && v.plan.intent === "faq" && v.plan.skipLlm === true'

echo "7/10 call-board transfer-or-message (transfers off)"
api POST /api/admin/call-board/plan \
  '{"utterance":"Can you transfer me to Nick?","transfersAllowed":false,"callerId":"+15095550100"}' |
  assert_json 'v.plan && (v.plan.intent === "message" || v.plan.intent === "transfer") && v.plan.skipLlm === true'

echo "8/10 call-board existing customer status"
api POST /api/admin/call-board/plan \
  '{"utterance":"Where is my technician?","existing":{"name":"Pat","openJobs":[{"id":"j1","title":"No heat"}]}}' |
  assert_json 'v.plan && v.plan.intent === "status" && /open work/i.test(v.plan.speak || "")'

echo "9/10 call-board after-hours emergency still shop-law"
api POST /api/admin/call-board/plan \
  '{"utterance":"I smell gas in the kitchen","afterHours":true}' |
  assert_json 'v.plan && (v.plan.intent === "emergency" || v.plan.shop.decision === "escalate") && v.plan.skipLlm === true'

echo "10/10 call-board quote or hold"
api POST /api/admin/call-board/plan \
  '{"utterance":"How much for a water heater?"}' |
  assert_json 'v.plan && v.plan.intent === "quote" && /hold it for the owner/i.test(v.plan.speak || "")'

echo "receptionist desk proof checks passed"
