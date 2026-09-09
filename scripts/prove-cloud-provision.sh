#!/usr/bin/env bash
# Operator proof for the cloud provision contract. No live customer, Telnyx, or host APIs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTRL="$ROOT/control-plane"

if grep -E "for \(const step of (STEPS|POST_CREATE|PROVISION)" "$CTRL/src/cloud/provisioner.ts"; then
  echo "FAIL: provisioner still auto-completes remaining steps" >&2
  exit 1
fi

if grep -nE "https://\$\{[^}]+\}\\.awsapprunner\\.com|awsapprunner\\.com\`" "$CTRL/src/cloud/hosts/aws.ts"; then
  echo "FAIL: aws adapter still invents App Runner hostnames" >&2
  exit 1
fi

if grep -n "attach later" "$CTRL/src/cloud/hosts/railway.ts"; then
  echo "FAIL: railway adapter still swallows attach failures" >&2
  exit 1
fi

cd "$CTRL"
npm run build
node --test \
  tests/cloudProvisionContract.test.js \
  tests/cloudHosts.test.js \
  tests/cloudApplyRemote.test.js

echo "prove-cloud-provision: mock path passed; no auto-completed inject/health/telnyx steps"
