#!/usr/bin/env bash
# Seeds a dev tenant + owner passcode so /portal can sign in locally.
# Admin + Owner UIs use ADMIN_API_KEY from .env (not this script).
#
# After running: docker compose (or deploy) restart control — or restart veralux-control.
#
# Portal login (after seed + control restart) — passcode is per tenant (same for all numbers on it):
#   Phone:    +12085551234  or  +15092193928
#   Passcode: fuzzyone

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CONTAINER="${POSTGRES_CONTAINER:-veralux-postgres}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Postgres container '$CONTAINER' is not running. Start the stack first." >&2
  exit 1
fi

# SHA256 hex of UTF-8 "fuzzyone" — must match control-plane/src/ownerAuth.ts hashPasscode()
PASS_HASH="a4c62b1d8cce1c33f3513a6d02308d356c7e6d79904af820214f5a43151175b8"

docker exec "$CONTAINER" sh -ec "
  psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO tenants (id, name, created_at, updated_at)
VALUES ('default', 'Dev Demo Business', now(), now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO tenant_numbers (number, tenant_id)
VALUES ('+12085551234', 'default')
ON CONFLICT (number) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

INSERT INTO tenant_numbers (number, tenant_id)
VALUES ('+15092193928', 'default')
ON CONFLICT (number) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

INSERT INTO owner_passcodes (tenant_id, passcode_hash)
VALUES ('default', '$PASS_HASH')
ON CONFLICT (tenant_id) DO UPDATE SET passcode_hash = EXCLUDED.passcode_hash;
SQL
"

echo "[OK] Seeded tenant 'default', numbers +12085551234 and +15092193928, owner passcode 'fuzzyone'."
echo "     Restart the control plane container to reload tenants:  docker restart veralux-control"
