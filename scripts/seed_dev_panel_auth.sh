#!/usr/bin/env bash
# Seeds a dev tenant + owner passcode so /portal can sign in locally.
# Admin + Owner UIs use ADMIN_API_KEY from .env (not this script).
#
# After running: docker compose (or deploy) restart control — or restart veralux-control.
#
# Portal login (after seed + control restart):
#   Phone:    +12085551234
#   Passcode: devportal

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CONTAINER="${POSTGRES_CONTAINER:-veralux-postgres}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Postgres container '$CONTAINER' is not running. Start the stack first." >&2
  exit 1
fi

# SHA256 hex of UTF-8 "devportal" — must match control-plane/src/ownerAuth.ts hashPasscode()
PASS_HASH="3ad6b96f0b5f661f34ecb257b5bdd6dea4923c21a121d432ed09507af03b5c90"

docker exec "$CONTAINER" sh -ec "
  psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO tenants (id, name, created_at, updated_at)
VALUES ('default', 'Dev Demo Business', now(), now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO tenant_numbers (number, tenant_id)
VALUES ('+12085551234', 'default')
ON CONFLICT (number) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

INSERT INTO owner_passcodes (tenant_id, passcode_hash)
VALUES ('default', '$PASS_HASH')
ON CONFLICT (tenant_id) DO UPDATE SET passcode_hash = EXCLUDED.passcode_hash;
SQL
"

echo "[OK] Seeded tenant 'default', number +12085551234, owner passcode 'devportal'."
echo "     Restart the control plane container to reload tenants:  docker restart veralux-control"
