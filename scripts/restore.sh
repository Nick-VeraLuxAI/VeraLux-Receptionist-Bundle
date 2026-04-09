#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist — PostgreSQL restore (destructive)
# =============================================================================
# Restores a gzip-compressed SQL dump (from scripts/backup.sh) into the running
# Postgres container. Read BACKUP_RESTORE.md before use.
#
# Usage:
#   ./scripts/restore.sh ./backups/veralux_2026-04-06_120000.sql.gz
#   ./scripts/restore.sh /path/to/dump.sql.gz --yes   # skip confirmation
#
# Safety:
#   Without --yes, you must type RESTORE to confirm. Stops if container not ready.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

CONTAINER_NAME="veralux-postgres"
SKIP_CONFIRM=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[RESTORE]${NC} $*"; }
success() { echo -e "${GREEN}[RESTORE]${NC} $*"; }
warn()    { echo -e "${YELLOW}[RESTORE]${NC} $*"; }
error()   { echo -e "${RED}[RESTORE]${NC} $*" >&2; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

DUMP_FILE="${1:-}"
if [[ -z "$DUMP_FILE" ]]; then
  error "Usage: $0 <backup.sql.gz> [--yes]"
  exit 1
fi
shift || true
if [[ "${1:-}" == "--yes" ]]; then
  SKIP_CONFIRM=true
  shift || true
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  error "File not found: $DUMP_FILE"
  exit 1
fi

for _vl_env_f in .env .env.internal; do
  if [[ -f "$_vl_env_f" ]]; then
    # shellcheck disable=SC2046
    export $(grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' "$_vl_env_f" | xargs)
  fi
done
unset _vl_env_f

DB_USER="${POSTGRES_USER:-veralux}"
DB_NAME="${POSTGRES_DB:-veralux}"

if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
  error "Container '$CONTAINER_NAME' not found. Start the stack first (e.g. ./deploy.sh up)."
  exit 1
fi

if ! docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null; then
  error "Postgres is not ready in '$CONTAINER_NAME'."
  exit 1
fi

warn "This will replace data in database '$DB_NAME' (user '$DB_USER') using:"
warn "  $DUMP_FILE"
warn "Redis, audio, and control-upload volumes are NOT modified by this script."
echo ""

if [[ "$SKIP_CONFIRM" != true ]]; then
  read -r -p "Type RESTORE to continue: " confirm
  if [[ "$confirm" != "RESTORE" ]]; then
    info "Aborted."
    exit 1
  fi
fi

info "Restoring (this may take several minutes)..."
gunzip -c "$DUMP_FILE" | docker exec -i "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"

success "Restore finished."
warn "Recycle runtime + control if tenant/runtime state in Redis is out of sync with the restored DB:"
warn "  ./deploy.sh restart runtime"
warn "  ./deploy.sh restart control"
info "See BACKUP_RESTORE.md for Redis and cold-cache notes."
