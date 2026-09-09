#!/usr/bin/env bash
set -euo pipefail

CONTROL_URL="${CONTROL_URL:-http://127.0.0.1:4000}"
TENANT_ID="${TENANT_ID:?Set TENANT_ID}"
ADMIN_API_KEY="${ADMIN_API_KEY:?Set ADMIN_API_KEY}"

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" \
      -H "Authorization: Bearer $ADMIN_API_KEY" \
      -H "X-Tenant-ID: $TENANT_ID" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$CONTROL_URL$path"
  else
    curl -fsS -X "$method" \
      -H "Authorization: Bearer $ADMIN_API_KEY" \
      -H "X-Tenant-ID: $TENANT_ID" \
      "$CONTROL_URL$path"
  fi
}

assert_json() {
  local expression="$1"
  node -e '
    let body = "";
    process.stdin.on("data", (chunk) => (body += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      const check = new Function("v", `return (${process.argv[1]})`);
      if (!check(value)) {
        console.error("Assertion failed:", process.argv[1], value);
        process.exit(1);
      }
      console.log(JSON.stringify(value));
    });
  ' "$expression"
}

echo "1/5 out-of-area refusal"
api POST /api/admin/shop-playbook/evaluate \
  '{"intent":"book","zip":"00000","utterance":"Please book service at 00000"}' |
  assert_json 'v.evaluation && v.evaluation.decision === "refuse"'

echo "2/5 gas emergency classifier"
api POST /api/admin/shop-playbook/evaluate \
  '{"intent":"other","utterance":"I smell gas in the kitchen"}' |
  assert_json 'v.evaluation && v.evaluation.decision === "escalate"'

echo "3/5 quote hold"
api POST /api/admin/shop-playbook/evaluate \
  '{"intent":"quote","quoteCents":99999999,"utterance":"The quote is very large"}' |
  assert_json 'v.evaluation && v.evaluation.decision === "hold"'

echo "4/5 completion and orphan metrics"
api GET /api/admin/completions |
  assert_json 'v.metrics && Number(v.orphanPromise) === 0'

echo "5/5 morning digest data"
api GET /api/admin/digest |
  assert_json 'v.metrics && Array.isArray(v.items)'

if [[ "${RUN_LIVE_ONCALL_DRILL:-0}" == "1" ]]; then
  echo "live on-call SMS + voice drill"
  api POST /api/admin/oncall/drill '{}' |
    assert_json 'v.smsSent === true && v.voiceDialed === true'
fi

if [[ "${RUN_LIVE_FSM_WRITE:-0}" == "1" ]]; then
  : "${DEMO_CALLER_PHONE:?Set DEMO_CALLER_PHONE}"
  : "${DEMO_CALLER_ADDRESS:?Set DEMO_CALLER_ADDRESS}"
  echo "live FSM board write"
  api POST /api/admin/fsm/write \
    "{\"callId\":\"demo-proof-$(date +%s)\",\"customer\":{\"name\":\"Demo Proof\",\"phone\":\"$DEMO_CALLER_PHONE\",\"address\":\"$DEMO_CALLER_ADDRESS\"},\"jobType\":\"VeraLux demo proof\",\"notes\":\"AI booked demo proof\"}" |
    assert_json 'v.result && v.result.ok === true && !v.result.dryRun && !!v.result.jobId'
fi

echo "night-desk demo proof checks passed"
