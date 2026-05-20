#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Deployment Script
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"
PROJECT_NAME="veralux"
ENV_INTERNAL_FILE=".env.internal"

# Compose file args (default: base only). When a host voice env file is resolved,
# docker-compose.production.yml is merged so `control` / `runtime` / Postgres / Redis
# receive env_file (e.g. ADMIN_AUTH_MODE from /etc/veralux/voice-runtime.env).
COMPOSE_FILES=( -f "$SCRIPT_DIR/docker-compose.yml" )

# -----------------------------------------------------------------------------
# Optional production overlay: inject VERALUX_COMPOSE_ENV_FILE into containers
# -----------------------------------------------------------------------------
resolve_compose_voice_env_overlay() {
    if [[ "${VERALUX_SKIP_VOICE_ENV_OVERLAY:-}" == "1" ]]; then
        return 0
    fi

    local candidate=""
    if [[ -n "${VERALUX_COMPOSE_ENV_FILE:-}" ]]; then
        candidate="$VERALUX_COMPOSE_ENV_FILE"
    elif [[ -n "${VERALUX_VOICE_ENV_FILE:-}" ]]; then
        candidate="$VERALUX_VOICE_ENV_FILE"
        export VERALUX_COMPOSE_ENV_FILE="$VERALUX_VOICE_ENV_FILE"
    elif [[ -f /etc/veralux/voice-runtime.env ]]; then
        candidate="/etc/veralux/voice-runtime.env"
        export VERALUX_COMPOSE_ENV_FILE="/etc/veralux/voice-runtime.env"
    fi

    if [[ -z "$candidate" ]]; then
        return 0
    fi

    if [[ ! -f "$candidate" ]]; then
        warn "VERALUX_COMPOSE_ENV_FILE / voice env path set but not a file: $candidate — skipping env_file overlay"
        unset VERALUX_COMPOSE_ENV_FILE
        return 0
    fi

    export VERALUX_COMPOSE_ENV_FILE="$candidate"
    COMPOSE_FILES=( -f "$SCRIPT_DIR/docker-compose.yml" -f "$SCRIPT_DIR/docker-compose.production.yml" )
    info "Merging docker-compose.production.yml — container env_file: VERALUX_COMPOSE_ENV_FILE=$VERALUX_COMPOSE_ENV_FILE"
}

# -----------------------------------------------------------------------------
# Docker Compose: optional second env file (operator .env + overrides in .env.internal)
# -----------------------------------------------------------------------------
dc() {
    if [[ -f "$SCRIPT_DIR/$ENV_INTERNAL_FILE" ]]; then
        $COMPOSE_CMD --env-file "$SCRIPT_DIR/$ENV_INTERNAL_FILE" "$@"
    else
        $COMPOSE_CMD "$@"
    fi
}

# Last file wins (for TTS_MODE, tokens, etc.)
read_merged_env_value() {
    local key="$1"
    local val="" line f
    for f in "$ENV_FILE" "$ENV_INTERNAL_FILE"; do
        [[ -f "$SCRIPT_DIR/$f" ]] || continue
        line=$(grep "^${key}=" "$SCRIPT_DIR/$f" 2>/dev/null | tail -n1) || true
        if [[ -n "$line" ]]; then
            val="${line#${key}=}"
        fi
    done
    echo "$val" | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | xargs
}

cloudflare_token_configured() {
    grep -q "CLOUDFLARE_TUNNEL_TOKEN=." "$SCRIPT_DIR/$ENV_FILE" 2>/dev/null && return 0
    [[ -f "$SCRIPT_DIR/$ENV_INTERNAL_FILE" ]] && grep -q "CLOUDFLARE_TUNNEL_TOKEN=." "$SCRIPT_DIR/$ENV_INTERNAL_FILE" 2>/dev/null
}

ngrok_token_configured() {
    [[ -n "${NGROK_AUTHTOKEN:-}" ]] && return 0
    grep -q "NGROK_AUTHTOKEN=." "$SCRIPT_DIR/$ENV_FILE" 2>/dev/null && return 0
    [[ -f "$SCRIPT_DIR/$ENV_INTERNAL_FILE" ]] && grep -q "NGROK_AUTHTOKEN=." "$SCRIPT_DIR/$ENV_INTERNAL_FILE" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Colors & Output Helpers
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# -----------------------------------------------------------------------------
# Dependency Checks
# -----------------------------------------------------------------------------
check_docker() {
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed or not in PATH."
        echo "  Install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        error "Docker daemon is not running or you don't have permission."
        echo "  Try: sudo systemctl start docker"
        echo "  Or ensure your user is in the docker group."
        exit 1
    fi
    
    success "Docker is available."
}

check_compose() {
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        warn "Using legacy docker-compose. Consider upgrading to Docker Compose V2."
    else
        error "Docker Compose is not installed."
        echo "  Install: https://docs.docker.com/compose/install/"
        exit 1
    fi
    
    success "Docker Compose is available."
}

check_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        warn ".env file not found."
        if [[ -f "$ENV_EXAMPLE" ]]; then
            info "Creating .env from .env.example..."
            cp "$ENV_EXAMPLE" "$ENV_FILE"
            echo ""
            warn "Please edit .env with your configuration, then run this script again."
            echo "  Required changes:"
            echo "    - POSTGRES_PASSWORD: Set a strong password"
            echo "    - JWT_SECRET: Generate with 'openssl rand -base64 32'"
            echo "    - REGISTRY: Set to your container registry"
            echo "  Optional: cp .env.internal.example .env.internal for advanced tuning (see CONFIG_MATRIX.md)."
            echo ""
            exit 0
        else
            error ".env.example not found. Cannot create .env file."
            exit 1
        fi
    fi
    
    success ".env file found."
    if [[ -f "$SCRIPT_DIR/$ENV_INTERNAL_FILE" ]]; then
        info "Found $ENV_INTERNAL_FILE — Docker Compose will merge it (overrides .env for duplicate keys)."
    fi
}

# Helper: detect audio profile based on TTS_MODE and hardware
# Qwen3 TTS is only in the gpu/cpu profiles; plain `docker compose up -d` (without profiles) does not start them.
# Missing TTS_MODE in .env: treat as coqui_xtts so we always pass --profile gpu|cpu (matches compose defaults for runtime).
detect_audio_profile() {
    local tts_mode
    tts_mode=$(read_merged_env_value TTS_MODE)
    if [[ -z "$tts_mode" ]]; then
        tts_mode="coqui_xtts"
    fi
    if [[ "$tts_mode" == "coqui_xtts" || "$tts_mode" == "kokoro_http" || "$tts_mode" == "qwen3_tts_http" || "$tts_mode" == "chatterbox_http" ]]; then
        if docker info 2>/dev/null | grep -qi nvidia || command -v nvidia-smi &>/dev/null; then
            echo "--profile gpu"
            return
        else
            echo "--profile cpu"
            return
        fi
    fi
    echo ""
}

# Warn when operators use non-reproducible tags (managed fleets should pin VERSION).
warn_release_pinning() {
    [[ "${VERALUX_SKIP_VERSION_WARN:-}" == "1" ]] && return 0
    local v r vl
    v=$(read_merged_env_value VERSION)
    r=$(read_merged_env_value REGISTRY)
    if [[ -z "$r" ]]; then
        warn "REGISTRY is not set in merged .env — Compose uses the default registry in docker-compose.yml. Set REGISTRY explicitly for predictable upgrades (see RELEASE_CHANNELS.md)."
    fi
    if [[ -z "$v" ]]; then
        warn "VERSION is not set in merged .env — Compose interpolates its own default (see docker-compose.yml). Set VERSION explicitly so fleet upgrades are predictable."
    fi
    vl=$(echo "$v" | tr '[:upper:]' '[:lower:]')
    if [[ "$vl" == "latest" ]]; then
        warn "VERSION=latest drifts between hosts and over time — not recommended for managed production. Pin an immutable tag (semver or digest). See RELEASE_CHANNELS.md."
    fi
}

# Map a running container name to its Compose service (gpu/cpu/llm aware).
compose_audio_svc_for_container() {
    local cname="$1"
    local envdump
    envdump=$(docker inspect "$cname" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
    case "$cname" in
        veralux-whisper)
            if echo "$envdump" | grep -q '^WHISPER_DEVICE=cpu$'; then echo "whisper-cpu"; else echo "whisper-gpu"; fi
            ;;
        veralux-kokoro)
            if echo "$envdump" | grep -qE '^CUDA_VISIBLE_DEVICES=$|^CUDA_VISIBLE_DEVICES=""$'; then echo "kokoro-cpu"; else echo "kokoro-gpu"; fi
            ;;
        veralux-xtts)
            if echo "$envdump" | grep -q '^XTTS_USE_GPU=false$'; then echo "xtts-cpu"; else echo "xtts-gpu"; fi
            ;;
        veralux-chatterbox)
            echo "chatterbox-gpu"
            ;;
        veralux-qwen3-tts)
            if echo "$envdump" | grep -q '^QWEN3_TTS_DEVICE=cpu$'; then echo "qwen3-tts-cpu"; else echo "qwen3-tts-gpu"; fi
            ;;
        veralux-vllm-qwen)
            echo "vllm-qwen"
            ;;
        veralux-brain)
            echo "brain"
            ;;
        *)
            echo ""
            ;;
    esac
}

record_image_snapshot() {
    local reason="${1:-snapshot}"
    local ts out dir
    ts=$(date +"%Y-%m-%d_%H%M%S")
    dir="$SCRIPT_DIR/backups"
    mkdir -p "$dir"
    out="$dir/veralux-images_${reason}_${ts}.txt"
    {
        echo "# Veralux image snapshot — $reason — $ts"
        echo "# VERSION=$(read_merged_env_value VERSION) REGISTRY=$(read_merged_env_value REGISTRY)"
        echo ""
        for c in veralux-control veralux-runtime veralux-postgres veralux-redis \
                 veralux-whisper veralux-kokoro veralux-xtts veralux-chatterbox veralux-qwen3-tts \
                 veralux-cloudflared veralux-ngrok veralux-vllm-qwen veralux-brain; do
            if docker inspect "$c" &>/dev/null; then
                echo "--- $c ---"
                docker inspect "$c" --format 'Image={{.Config.Image}} Id={{.Image}}' 2>/dev/null || true
            fi
        done
    } > "$out"
    info "Recorded container images to $out"
}

cmd_versions() {
    info "Env pin (merged): VERSION=$(read_merged_env_value VERSION) REGISTRY=$(read_merged_env_value REGISTRY)"
    echo ""
    local c
    for c in veralux-control veralux-runtime veralux-postgres veralux-redis \
             veralux-whisper veralux-kokoro veralux-xtts veralux-chatterbox veralux-qwen3-tts \
             veralux-cloudflared veralux-ngrok veralux-vllm-qwen veralux-brain; do
        if docker inspect "$c" &>/dev/null; then
            docker inspect "$c" --format "{{printf '%-22s' \"${c}\"}} {{.Config.Image}}  id={{.Image}}" 2>/dev/null
        fi
    done
}

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------
cmd_up() {
    info "Starting Veralux Receptionist (official path: ./deploy.sh up or ./up — not plain docker compose up)..."
    
    if [[ -f "scripts/preflight.sh" ]]; then
        bash scripts/preflight.sh || exit 1
    elif [[ -f "scripts/validate-voice-deploy.sh" ]]; then
        bash scripts/validate-voice-deploy.sh || exit 1
    fi
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    warn_release_pinning
    if [[ "$audio_profile" == *gpu* ]]; then
        info "NVIDIA GPU detected — running audio services with GPU acceleration"
    elif [[ -n "$audio_profile" ]]; then
        info "No NVIDIA GPU detected — running audio services in CPU mode (slower but functional)"
    fi
    
    # Remove any leftover containers to avoid name conflicts
    docker rm -f veralux-control veralux-runtime veralux-redis veralux-postgres \
        veralux-cloudflared veralux-whisper veralux-kokoro veralux-xtts veralux-qwen3-tts veralux-ngrok 2>/dev/null || true
    
    # Best-effort pull (don't fail if offline)
    info "Pulling latest images (if available)..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile pull --ignore-pull-failures 2>/dev/null || true
    
    # Start services
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile up -d "$@"
    
    # `docker rm` above drops veralux-cloudflared; plain compose omits profile `docker-cloudflared-legacy`.
    # Production: use systemd cloudflared + /etc/cloudflared/config.yml (see PRODUCTION_TOPOLOGY.md).
    if cloudflare_token_configured; then
        info "Restarting Docker Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN is set; legacy profile)..."
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile --profile docker-cloudflared-legacy up -d --no-deps cloudflared 2>/dev/null || \
            warn "Docker cloudflared did not start — use systemd tunnel on production, or set CLOUDFLARED_TAG and verify the tunnel token."
    fi
    
    echo ""
    success "Services started!"
    echo ""
    info "Useful commands:"
    echo "  View status:  ./deploy.sh status"
    echo "  View logs:    ./deploy.sh logs"
    echo "  Stop:         ./deploy.sh down"
}

cmd_down() {
    info "Stopping Veralux Receptionist..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" down "$@"
    success "Services stopped."
}

cmd_restart() {
    info "Restarting Veralux Receptionist..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" restart "$@"
    success "Services restarted."
}

cmd_status() {
    info "Service Status:"
    echo ""
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" ps
}

cmd_logs() {
    if [[ $# -gt 0 ]]; then
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" logs -f "$@"
    else
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" logs -f
    fi
}

# Docker caches the control-plane layer that runs `sed` on admin.html. A stale ADMIN_UI_BUILD_STAMP
# in the shell (or from an old export) can bake the wrong "Build …" text. The Dockerfile's date
# fallback is also cached until COPY public/ changes. Always set the stamp from git HEAD for
# ./deploy.sh build so each commit gets a matching UI fingerprint (overrides prior env).
# To force a custom stamp: ADMIN_UI_BUILD_STAMP_NO_GIT=1 ADMIN_UI_BUILD_STAMP=mytag ./deploy.sh build control
ensure_admin_ui_build_stamp() {
    if [[ "${ADMIN_UI_BUILD_STAMP_NO_GIT:-}" == "1" ]]; then
        info "ADMIN_UI_BUILD_STAMP_NO_GIT=1 — using ADMIN_UI_BUILD_STAMP=${ADMIN_UI_BUILD_STAMP:-}(unset)"
        export ADMIN_UI_BUILD_STAMP
        return
    fi
    if git rev-parse --short HEAD &>/dev/null; then
        ADMIN_UI_BUILD_STAMP="$(git rev-parse --short HEAD)"
        export ADMIN_UI_BUILD_STAMP
        info "ADMIN_UI_BUILD_STAMP=${ADMIN_UI_BUILD_STAMP} (git HEAD; use ADMIN_UI_BUILD_STAMP_NO_GIT=1 to skip)"
    fi
}

cmd_build() {
    info "Building Veralux Receptionist from source..."
    ensure_admin_ui_build_stamp

    local audio_profile
    audio_profile=$(detect_audio_profile)

    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile build "$@"

    success "Build complete!"
}

cmd_update() {
    info "Updating Veralux Receptionist (rolling restart)..."
    warn_release_pinning
    info "Upgrade contract: UPGRADE_RUNBOOK.md — rollback: ROLLBACK_RUNBOOK.md — tagging: RELEASE_CHANNELS.md"
    
    if [[ -f "scripts/preflight.sh" ]]; then
        bash scripts/preflight.sh || exit 1
    elif [[ -f "scripts/validate-voice-deploy.sh" ]]; then
        bash scripts/validate-voice-deploy.sh || exit 1
    fi
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    
    if [[ "${UPDATE_SNAPSHOT_PRE:-1}" != "0" ]]; then
        record_image_snapshot "pre-update"
    fi
    
    # 1. Pull images (strict by default so partial tag drift is visible; airgap: UPDATE_IGNORE_PULL_FAILURES=1)
    if [[ "${UPDATE_IGNORE_PULL_FAILURES:-}" == "1" ]]; then
        warn "UPDATE_IGNORE_PULL_FAILURES=1 — pull errors will be ignored (not recommended for online managed upgrades)."
        info "Pulling images (best-effort)..."
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile pull --ignore-pull-failures 2>/dev/null || true
    else
        info "Pulling images for VERSION=$(read_merged_env_value VERSION) (set UPDATE_IGNORE_PULL_FAILURES=1 only for offline/airgap hosts)..."
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile pull
    fi
    
    # Pull optional-profile images when those containers are in use (main pull above omits llm/tunnel profiles).
    _update_pull_profile() {
        local prof="$1"
        shift
        if [[ "${UPDATE_IGNORE_PULL_FAILURES:-}" == "1" ]]; then
            dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" --profile "$prof" pull --ignore-pull-failures "$@" 2>/dev/null || true
        else
            dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" --profile "$prof" pull "$@"
        fi
    }
    if [[ "$(docker inspect -f '{{.State.Running}}' veralux-vllm-qwen 2>/dev/null)" == "true" ]] || [[ "$(docker inspect -f '{{.State.Running}}' veralux-brain 2>/dev/null)" == "true" ]]; then
        info "Pulling profile llm images (vLLM / brain)..."
        _update_pull_profile llm vllm-qwen brain
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' veralux-cloudflared 2>/dev/null)" == "true" ]]; then
        info "Pulling cloudflared image..."
        _update_pull_profile docker-cloudflared-legacy cloudflared
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' veralux-ngrok 2>/dev/null)" == "true" ]]; then
        info "Pulling ngrok image..."
        _update_pull_profile ngrok ngrok
    fi
    
    # 2. Backup database before updating
    if [[ "${UPDATE_SKIP_BACKUP:-}" == "1" ]]; then
        warn "UPDATE_SKIP_BACKUP=1 — skipping pre-update Postgres backup."
    elif [[ -x "scripts/backup.sh" ]]; then
        info "Creating pre-update database backup..."
        bash scripts/backup.sh || warn "Backup failed — continuing with update."
    fi
    
    # 3. Rolling restart: infrastructure first, then services one at a time
    # Infrastructure (Redis/Postgres) — these hold state, restart only if image changed
    info "Updating infrastructure services..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" up -d --no-deps redis postgres
    
    # Wait for infrastructure to be healthy
    info "Waiting for infrastructure health checks..."
    local retries=30
    while [[ $retries -gt 0 ]]; do
        local pg_healthy redis_healthy
        pg_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-postgres 2>/dev/null || echo "unknown")
        redis_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-redis 2>/dev/null || echo "unknown")
        if [[ "$pg_healthy" == "healthy" && "$redis_healthy" == "healthy" ]]; then
            break
        fi
        sleep 2
        retries=$((retries - 1))
    done
    
    if [[ $retries -eq 0 ]]; then
        warn "Infrastructure health check timed out — proceeding anyway."
    else
        success "Infrastructure healthy."
    fi
    
    # 4. Update control plane (runtime depends on it)
    info "Updating control plane..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" up -d --no-deps control
    
    # Wait for control plane to be healthy before updating runtime
    info "Waiting for control plane health check..."
    retries=30
    while [[ $retries -gt 0 ]]; do
        local ctrl_healthy
        ctrl_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-control 2>/dev/null || echo "unknown")
        if [[ "$ctrl_healthy" == "healthy" ]]; then
            break
        fi
        sleep 3
        retries=$((retries - 1))
    done
    
    if [[ $retries -eq 0 ]]; then
        warn "Control plane health check timed out — proceeding anyway."
    else
        success "Control plane healthy."
    fi
    
    # 5. Update voice runtime
    info "Updating voice runtime..."
    dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" up -d --no-deps runtime
    
    # 6. Update audio + optional LLM services (if running)
    local ac c compose_svc
    for ac in veralux-whisper veralux-kokoro veralux-xtts veralux-chatterbox veralux-qwen3-tts veralux-vllm-qwen veralux-brain; do
        if [[ "$(docker inspect -f '{{.State.Running}}' "$ac" 2>/dev/null)" == "true" ]]; then
            compose_svc=$(compose_audio_svc_for_container "$ac")
            if [[ -z "$compose_svc" ]]; then
                continue
            fi
            info "Updating $ac (compose: $compose_svc)..."
            if [[ "$compose_svc" == "vllm-qwen" || "$compose_svc" == "brain" ]]; then
                dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" --profile llm up -d --no-deps "$compose_svc" 2>/dev/null || \
                    warn "  Could not update $compose_svc (check profile llm and image pull)."
            else
                dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile up -d --no-deps "$compose_svc" 2>/dev/null || \
                    warn "  Could not update $compose_svc (check gpu/cpu profile)."
            fi
        fi
    done
    
    # 7. Update tunnels if active (both profiles are used in the wild)
    if [[ "$(docker inspect -f '{{.State.Running}}' veralux-cloudflared 2>/dev/null)" == "true" ]]; then
        info "Updating Cloudflare Tunnel..."
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile --profile docker-cloudflared-legacy up -d --no-deps cloudflared
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' veralux-ngrok 2>/dev/null)" == "true" ]]; then
        info "Updating ngrok..."
        dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile --profile ngrok up -d --no-deps ngrok
    fi
    
    if [[ "${UPDATE_SNAPSHOT_POST:-1}" != "0" ]]; then
        record_image_snapshot "post-update"
    fi
    
    echo ""
    success "Rolling update complete!"
    info "Verify: ./scripts/healthcheck.sh  —  image report: ./deploy.sh versions"
    echo ""
    cmd_status
}

cmd_backup() {
    if [[ ! -x "scripts/backup.sh" ]]; then
        error "Backup script not found at scripts/backup.sh"
        exit 1
    fi
    bash scripts/backup.sh "$@"
}

cmd_restore() {
    if [[ ! -x "scripts/restore.sh" ]]; then
        error "Restore script not found at scripts/restore.sh"
        exit 1
    fi
    bash scripts/restore.sh "$@"
}

cmd_tunnel() {
    local tunnel_type="${1:-cloudflare}"
    
    if [[ -f "scripts/preflight.sh" ]]; then
        bash scripts/preflight.sh || exit 1
    elif [[ -f "scripts/validate-voice-deploy.sh" ]]; then
        bash scripts/validate-voice-deploy.sh || exit 1
    fi
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    if [[ "$audio_profile" == *gpu* ]]; then
        info "NVIDIA GPU detected — running audio services with GPU acceleration"
    elif [[ -n "$audio_profile" ]]; then
        info "No NVIDIA GPU detected — running audio services in CPU mode (slower but functional)"
    fi
    
    case "$tunnel_type" in
        cloudflare|cf)
            if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] && ! cloudflare_token_configured; then
                error "CLOUDFLARE_TUNNEL_TOKEN not set in .env or .env.internal"
                echo ""
                echo "  To get a token:"
                echo "    1. Go to Cloudflare Zero Trust dashboard"
                echo "    2. Networks → Tunnels → Create tunnel"
                echo "    3. Copy the token and add to .env:"
                echo "       CLOUDFLARE_TUNNEL_TOKEN=your_token_here"
                exit 1
            fi
            info "Starting with Cloudflare Tunnel..."
            # Remove any leftover containers to avoid name conflicts
            docker rm -f veralux-control veralux-runtime veralux-redis veralux-postgres \
                veralux-cloudflared veralux-whisper veralux-kokoro veralux-xtts veralux-qwen3-tts veralux-ngrok 2>/dev/null || true
            dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile --profile docker-cloudflared-legacy up -d
            success "Cloudflare Tunnel started!"
            echo ""
            info "Your public URL is configured in the Cloudflare dashboard."
            ;;
        ngrok)
            if [[ -z "${NGROK_AUTHTOKEN:-}" ]] && ! ngrok_token_configured; then
                error "NGROK_AUTHTOKEN not set in .env or .env.internal"
                echo "  Get your token at: https://dashboard.ngrok.com"
                exit 1
            fi
            info "Starting with ngrok tunnel..."
            dc "${COMPOSE_FILES[@]}" -p "$PROJECT_NAME" $audio_profile --profile ngrok up -d
            success "ngrok started!"
            echo ""
            info "View your public URL at: http://localhost:4040"
            ;;
        *)
            error "Unknown tunnel type: $tunnel_type"
            echo "  Use: cloudflare (or cf) | ngrok"
            exit 1
            ;;
    esac
}

cmd_help() {
    echo "Veralux Receptionist - Deployment Script"
    echo ""
    echo "Usage: ./deploy.sh <command> [options]"
    echo ""
    echo "Production-like start: ./deploy.sh up   or   ./up   (do not use plain docker compose up for voice)"
    echo "Preflight only:        ./scripts/preflight.sh"
    echo ""
    echo "Commands:"
    echo "  up [services...]     Start services (pulls images first)"
    echo "  down                 Stop and remove containers"
    echo "  restart [services...] Restart services"
    echo "  status               Show service status"
    echo "  logs [service]       Follow service logs"
    echo "  build [services...]  Build images from local source (sets ADMIN_UI_BUILD_STAMP=git HEAD if unset)"
    echo "  update               Rolling update (pull + restart one at a time)"
    echo "  versions             Show running container image refs + env VERSION/REGISTRY pin"
    echo "  backup [dir] [opts]  Backup the database"
    echo "  restore <file.sql.gz> [--yes]  Restore Postgres from backup (destructive)"
    echo "  tunnel [type]        Start with tunnel (cloudflare or ngrok)"
    echo "  help                 Show this help message"
    echo ""
    echo "Tunnel Options:"
    echo "  ./deploy.sh tunnel cloudflare   # Start with Cloudflare Tunnel (recommended)"
    echo "  ./deploy.sh tunnel ngrok        # Start with ngrok (for testing)"
    echo ""
    echo "Build & Update:"
    echo "  ./deploy.sh build                 # Build all images from source"
    echo "  ./deploy.sh build control         # Build just the control plane"
    echo "  ./deploy.sh update                # Rolling update (strict pull; see UPGRADE_RUNBOOK.md)"
    echo "  ./deploy.sh versions              # After update: verify images match intended VERSION"
    echo ""
    echo "Backup & Restore:"
    echo "  ./deploy.sh backup                # Backup to ./backups/"
    echo "  ./deploy.sh backup --s3 s3://b    # Backup + upload to S3"
    echo "  ./deploy.sh restore ./backups/veralux_*.sql.gz   # Restore (see BACKUP_RESTORE.md)"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh up                    # Start all core services"
    echo "  ./deploy.sh build && ./deploy.sh up  # Build from source, then start"
    echo "  ./deploy.sh tunnel cloudflare     # Start with Cloudflare Tunnel"
    echo "  ./deploy.sh logs control          # Follow control service logs"
    echo "  ./deploy.sh restart runtime       # Restart only the runtime service"
    echo ""
    echo "Host voice env (optional): if /etc/veralux/voice-runtime.env exists, this script merges"
    echo "  docker-compose.production.yml so containers load it (e.g. ADMIN_AUTH_MODE). Override with"
    echo "  VERALUX_COMPOSE_ENV_FILE=/path/to.env or VERALUX_VOICE_ENV_FILE=… ; skip with VERALUX_SKIP_VOICE_ENV_OVERLAY=1"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    # Always check dependencies first
    check_docker
    check_compose
    check_env
    resolve_compose_voice_env_overlay
    
    echo ""
    
    case "${1:-help}" in
        up)
            shift
            cmd_up "$@"
            ;;
        down)
            shift
            cmd_down "$@"
            ;;
        restart)
            shift
            cmd_restart "$@"
            ;;
        status)
            cmd_status
            ;;
        logs)
            shift
            cmd_logs "$@"
            ;;
        build)
            shift
            cmd_build "$@"
            ;;
        update)
            cmd_update
            ;;
        versions)
            cmd_versions
            ;;
        backup)
            shift
            cmd_backup "$@"
            ;;
        restore)
            shift
            cmd_restore "$@"
            ;;
        tunnel)
            shift
            cmd_tunnel "$@"
            ;;
        help|--help|-h)
            cmd_help
            ;;
        *)
            error "Unknown command: $1"
            echo ""
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"
