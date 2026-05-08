#!/usr/bin/env bash
# Install Docker Compose v2 as a docker CLI plugin when `apt install docker-compose-plugin`
# is unavailable (e.g. Docker not installed from Docker’s official apt repo).
#
# Usage:
#   sudo ./scripts/install-docker-compose-plugin.sh
#
# Afterward: docker compose version
set -euo pipefail

if docker compose version &>/dev/null 2>&1; then
  echo "[ok] docker compose already works:"
  docker compose version
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) COMPOSE_ARCH="x86_64" ;;
  aarch64 | arm64) COMPOSE_ARCH="aarch64" ;;
  *)
    echo "[error] Unsupported machine: $ARCH (need x86_64 or aarch64)"
    exit 1
    ;;
esac

VERSION="${COMPOSE_V2_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(curl -sfL https://api.github.com/repos/docker/compose/releases/latest \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")" || {
    echo "[error] Could not resolve latest Compose release tag (network?)"
    exit 1
  }
fi

URL="https://github.com/docker/compose/releases/download/${VERSION}/docker-compose-linux-${COMPOSE_ARCH}"
TMP="$(mktemp)"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  DEST_DIR="${DOCKER_CLI_PLUGINS:-/usr/local/lib/docker/cli-plugins}"
else
  DEST_DIR="${DOCKER_CLI_PLUGINS:-$HOME/.docker/cli-plugins}"
  mkdir -p "$DEST_DIR"
fi

echo "[info] Installing Compose ${VERSION} for linux-${COMPOSE_ARCH} → ${DEST_DIR}/docker-compose"
curl -fSL "$URL" -o "$TMP"
chmod +x "$TMP"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  mkdir -p "$DEST_DIR"
  install -m0755 "$TMP" "${DEST_DIR}/docker-compose"
else
  install -m0755 "$TMP" "${DEST_DIR}/docker-compose"
fi
rm -f "$TMP"

echo "[ok] Plugin installed. Verifying:"
docker compose version
