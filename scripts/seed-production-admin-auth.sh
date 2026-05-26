#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${VERALUX_VOICE_ENV_FILE:-/etc/veralux/voice-runtime.env}"
RESTART_CONTROL=1
EMAIL_VALUE="${ADMIN_CONSOLE_EMAIL:-}"
PASSWORD_FROM_STDIN=0

usage() {
  cat <<'EOF'
Seed production admin auth into the production voice env.

Usage:
  ./scripts/seed-production-admin-auth.sh [options]

Options:
  --env-file PATH         Target env file (default: /etc/veralux/voice-runtime.env)
  --email EMAIL           Set ADMIN_CONSOLE_EMAIL to this value
  --password-from-stdin   Read password from stdin instead of secure prompt
  --no-restart            Update env only; do not recreate veralux-control
  -h, --help              Show this help

Notes:
  - Password is written to INSTALLER_PASSWORD in the target env file.
  - If the env file is not writable, the script uses sudo to install the update.
  - By default, the script recreates the control-plane container so the new login
    takes effect immediately.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?missing path for --env-file}"
      shift 2
      ;;
    --email)
      EMAIL_VALUE="${2:?missing value for --email}"
      shift 2
      ;;
    --password-from-stdin)
      PASSWORD_FROM_STDIN=1
      shift
      ;;
    --no-restart)
      RESTART_CONTROL=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] Unknown option: $1" >&2
      echo "" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[error] Env file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ $PASSWORD_FROM_STDIN -eq 1 ]]; then
  IFS= read -r INSTALLER_PASSWORD_VALUE
else
  read -r -s -p "Admin console password: " INSTALLER_PASSWORD_VALUE
  echo ""
  read -r -s -p "Confirm password: " INSTALLER_PASSWORD_CONFIRM
  echo ""
  if [[ "$INSTALLER_PASSWORD_VALUE" != "$INSTALLER_PASSWORD_CONFIRM" ]]; then
    echo "[error] Passwords did not match." >&2
    exit 1
  fi
fi

if [[ -z "${INSTALLER_PASSWORD_VALUE:-}" ]]; then
  echo "[error] Password cannot be empty." >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

SEED_INSTALLER_PASSWORD="$INSTALLER_PASSWORD_VALUE" \
SEED_ADMIN_CONSOLE_EMAIL="$EMAIL_VALUE" \
python3 - "$ENV_FILE" "$TMP_FILE" <<'PY'
import os
import re
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
tmp_path = Path(sys.argv[2])
password = os.environ["SEED_INSTALLER_PASSWORD"]
email = os.environ.get("SEED_ADMIN_CONSOLE_EMAIL", "")

lines = env_path.read_text(encoding="utf-8").splitlines()

def upsert(lines, key, value):
    pattern = re.compile(rf"^\s*{re.escape(key)}=")
    out = []
    replaced = False
    for line in lines:
        if pattern.match(line):
            if not replaced:
                out.append(f"{key}={value}")
                replaced = True
            continue
        out.append(line)
    if not replaced:
        if out and out[-1] != "":
            out.append("")
        out.append(f"{key}={value}")
    return out

lines = upsert(lines, "INSTALLER_PASSWORD", password)
if email:
    lines = upsert(lines, "ADMIN_CONSOLE_EMAIL", email)

tmp_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

if [[ -w "$ENV_FILE" ]]; then
  cat "$TMP_FILE" > "$ENV_FILE"
else
  mode="$(stat -c '%a' "$ENV_FILE")"
  owner="$(stat -c '%u' "$ENV_FILE")"
  group="$(stat -c '%g' "$ENV_FILE")"
  sudo install -m "$mode" -o "$owner" -g "$group" "$TMP_FILE" "$ENV_FILE"
fi

echo "[ok] Updated $ENV_FILE with INSTALLER_PASSWORD."
if [[ -n "$EMAIL_VALUE" ]]; then
  echo "[ok] Set ADMIN_CONSOLE_EMAIL=$EMAIL_VALUE"
fi

if [[ $RESTART_CONTROL -eq 0 ]]; then
  echo "[info] Skipping control-plane recreate (--no-restart)."
  exit 0
fi

if [[ ! -f "${SCRIPT_DIR}/veralux-compose-helper.sh" ]]; then
  echo "[warn] Missing ${SCRIPT_DIR}/veralux-compose-helper.sh — env updated, but control plane was not restarted." >&2
  exit 0
fi

# shellcheck source=veralux-compose-helper.sh
source "${SCRIPT_DIR}/veralux-compose-helper.sh"
PROD_ROOT="$ROOT"
veralux_compose_prepare_env "$ENV_FILE"

echo "[info] Recreating veralux-control so the new login takes effect..."
veralux_compose up -d --force-recreate control

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:4000/ready" >/dev/null 2>&1; then
    echo "[ok] Control plane is ready."
    exit 0
  fi
  sleep 2
done

echo "[warn] Control plane restart triggered, but /ready did not return 200 within the wait window." >&2
exit 0
