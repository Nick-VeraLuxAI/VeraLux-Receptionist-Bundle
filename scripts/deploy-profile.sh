#!/usr/bin/env bash
# Deploy VeraLux Receptionist using an explicit DEPLOYMENT_PROFILE.
# Does not print secrets, API keys, tokens, or raw provider URLs.
#
# Usage:
#   ./scripts/deploy-profile.sh --profile local-gpu
#   ./scripts/deploy-profile.sh --profile cloud-api
#   ./scripts/deploy-profile.sh --profile hybrid
#   ./scripts/deploy-profile.sh --profile cloud-api --env-file /etc/veralux/voice-runtime.env
#   ./scripts/deploy-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env --fragment-env path/to/redis-fragment.env
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE=""
EXTRA_ENV_FILES=()
EXTRA_FRAGMENT_ENVS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --env-file)
      EXTRA_ENV_FILES+=("${2:-}")
      shift 2
      ;;
    --fragment-env)
      [[ -n "${2:-}" ]] || { echo "[error] --fragment-env requires a path" >&2; exit 2; }
      [[ -f "$2" ]] || { echo "[error] fragment env file not found: $2" >&2; exit 1; }
      EXTRA_FRAGMENT_ENVS+=("${2:-}")
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --profile local-gpu|cloud-api|hybrid [--env-file PATH] ... [--fragment-env PATH] ..."
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  echo "[error] --profile is required (local-gpu | cloud-api | hybrid)" >&2
  exit 2
fi

if ! docker compose version &>/dev/null; then
  echo "[error] docker compose (v2) is required" >&2
  exit 1
fi

COMPOSE_CMD=(docker compose)
ENV_ARGS=()
if [[ -f "$ROOT/.env" ]]; then
  ENV_ARGS+=(--env-file "$ROOT/.env")
fi
if [[ -f "$ROOT/.env.internal" ]]; then
  ENV_ARGS+=(--env-file "$ROOT/.env.internal")
fi
for ef in "${EXTRA_ENV_FILES[@]}"; do
  if [[ -n "$ef" ]]; then
    if [[ ! -f "$ef" ]]; then
      echo "[error] env file not found: $ef" >&2
      exit 1
    fi
    ENV_ARGS+=(--env-file "$ef")
  fi
done

COMPOSE_FILES=(-f "$ROOT/docker-compose.yml")
case "$PROFILE" in
  local-gpu)
    COMPOSE_FILES+=(-f "$ROOT/docker-compose.local-gpu.yml")
    ;;
  cloud-api)
    COMPOSE_FILES+=(-f "$ROOT/docker-compose.cloud-api.yml")
    ;;
  hybrid)
    COMPOSE_FILES+=(-f "$ROOT/docker-compose.hybrid.yml")
    ;;
  *)
    echo "[error] invalid profile: $PROFILE" >&2
    exit 2
    ;;
esac

PROFILE_ARGS=()
if [[ "$PROFILE" == "local-gpu" ]]; then
  if docker info 2>/dev/null | grep -qi nvidia || command -v nvidia-smi &>/dev/null; then
    PROFILE_ARGS=(--profile gpu)
    echo "[info] local-gpu: NVIDIA detected — using compose --profile gpu"
  else
    PROFILE_ARGS=(--profile cpu)
    echo "[info] local-gpu: no NVIDIA — using compose --profile cpu (CPU audio stack)"
  fi
elif [[ "$PROFILE" == "cloud-api" ]]; then
  echo "[info] cloud-api: starting core stack only (do not pass gpu/cpu profiles)"
elif [[ "$PROFILE" == "hybrid" ]]; then
  echo "[warn] hybrid: compose overlay is a skeleton — verify Redis, public URLs, and GPU reachability manually (docs/HYBRID_DEPLOYMENT.md)"
fi

echo "[info] Running preflight-profile.sh …"
pf_args=(--profile "$PROFILE")
for ef in "${EXTRA_ENV_FILES[@]}"; do
  pf_args+=(--env-file "$ef")
done
for ff in "${EXTRA_FRAGMENT_ENVS[@]}"; do
  pf_args+=(--fragment-env "$ff")
done
bash "$ROOT/scripts/preflight-profile.sh" "${pf_args[@]}"

echo "[info] Validating compose config …"
"${COMPOSE_CMD[@]}" "${ENV_ARGS[@]}" "${COMPOSE_FILES[@]}" -p veralux "${PROFILE_ARGS[@]}" config >/dev/null

echo "[info] docker compose up -d …"
"${COMPOSE_CMD[@]}" "${ENV_ARGS[@]}" "${COMPOSE_FILES[@]}" -p veralux "${PROFILE_ARGS[@]}" up -d

echo "[info] Running validate-profile.sh …"
vf_args=(--profile "$PROFILE")
for ef in "${EXTRA_ENV_FILES[@]}"; do
  vf_args+=(--env-file "$ef")
done
for ff in "${EXTRA_FRAGMENT_ENVS[@]}"; do
  vf_args+=(--fragment-env "$ff")
done
bash "$ROOT/scripts/validate-profile.sh" "${vf_args[@]}"

CONTROL_PORT="${CONTROL_PORT:-4000}"
RUNTIME_PORT="${RUNTIME_PORT:-4001}"

echo ""
echo "=== Deploy profile summary ==="
echo "Active profile:     $PROFILE"
echo "Admin / control URL: http://localhost:${CONTROL_PORT}/"
echo "Voice runtime URL:   http://localhost:${RUNTIME_PORT}/"
echo "Health endpoints:"
echo "  Control GET http://localhost:${CONTROL_PORT}/health"
echo "  Control GET http://localhost:${CONTROL_PORT}/ready"
echo "  Runtime GET http://localhost:${RUNTIME_PORT}/health/live"
echo "  Runtime GET http://localhost:${RUNTIME_PORT}/health/voice"
echo "AI providers (local vs external): inferred from compose profiles —"
echo "  local-gpu: STT/TTS containers local when gpu/cpu profile used"
echo "  cloud-api: STT/TTS/LLM must be external URLs in env (no gpu profile)"
echo "  hybrid:    operator-defined (see docs)"
echo ""
echo "Secrets and raw provider URLs are never printed by this script."
