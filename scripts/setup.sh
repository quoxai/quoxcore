#!/bin/bash
# QuoxCORE First-Time Setup
# Single entry point for deploying QuoxCORE on a fresh server.
#
# Usage:
#   ./scripts/setup.sh              # Interactive setup
#   ./scripts/setup.sh --yes        # Non-interactive (accept defaults)
#   ./scripts/setup.sh --reset      # Wipe volumes and start fresh
#
# What this script does:
#   1. Preflight checks (Docker, disk, ports)
#   2. Generate .env with secrets (if needed)
#   3. Generate SSL certs (if needed)
#   4. Locate or clone quoxflow + quoxmcp
#   5. Clean up stale containers/volumes (if any)
#   6. Build and start the stack
#   7. Wait for health checks
#   8. Print access URL

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }
err()  { echo -e "${RED}[setup]${NC} $1"; }
info() { echo -e "${CYAN}[setup]${NC} $1"; }

# Parse args
AUTO_YES=false
RESET=false
for arg in "$@"; do
    case $arg in
        --yes|-y) AUTO_YES=true ;;
        --reset)  RESET=true ;;
        --help|-h)
            echo "QuoxCORE Setup"
            echo ""
            echo "Usage: ./scripts/setup.sh [options]"
            echo ""
            echo "Options:"
            echo "  --yes, -y    Accept all defaults (non-interactive)"
            echo "  --reset      Wipe all data volumes and start fresh"
            echo "  --help, -h   Show this help"
            exit 0
            ;;
    esac
done

confirm() {
    if [ "$AUTO_YES" = true ]; then return 0; fi
    read -p "$1 [Y/n] " -n 1 -r
    echo
    [[ -z "$REPLY" || "$REPLY" =~ ^[Yy]$ ]]
}

echo ""
echo -e "${BOLD}QuoxCORE Setup${NC}"
echo "=============="
echo ""

# ─── Step 1: Preflight ─────────────────────────────────────
log "Step 1/7: Preflight checks"

FAIL=false

# Docker
if ! command -v docker &>/dev/null; then
    err "Docker not installed. Install from https://docs.docker.com/engine/install/"
    FAIL=true
elif ! docker info &>/dev/null 2>&1; then
    err "Docker daemon not running, or current user not in docker group"
    err "Fix: sudo usermod -aG docker \$USER && newgrp docker"
    FAIL=true
else
    log "  Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# Docker Compose
if ! docker compose version &>/dev/null 2>&1; then
    err "Docker Compose (v2) not found. Install the compose plugin."
    FAIL=true
else
    log "  Compose: $(docker compose version --short)"
fi

# openssl
if ! command -v openssl &>/dev/null; then
    err "openssl not installed (needed for secrets + SSL certs)"
    FAIL=true
fi

# Disk space (need at least 5GB free)
FREE_GB=$(df -BG "$PROJECT_ROOT" | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "$FREE_GB" -lt 5 ] 2>/dev/null; then
    warn "  Disk: ${FREE_GB}GB free (recommend 5GB+)"
else
    log "  Disk: ${FREE_GB}GB free"
fi

# Port conflicts
for port in 80 3000 9848; do
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
        # Check if it's our own container
        if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${port}->"; then
            continue  # Our own container, fine
        fi
        warn "  Port $port already in use (may conflict)"
    fi
done

if [ "$FAIL" = true ]; then
    err "Preflight failed. Fix the above issues and re-run."
    exit 1
fi
log "  All checks passed"
echo ""

# ─── Step 2: Generate secrets + .env ───────────────────────
log "Step 2/7: Environment configuration"

# Z2H-3c: remember whether this is a re-run (an owner may already exist) for the final banner.
if [ -f .env ]; then SETUP_RERUN=1; else SETUP_RERUN=0; fi
if [ -f .env ]; then
    # Check if .env has placeholder values
    if grep -qE "CHANGE_ME|change-this" .env 2>/dev/null; then
        warn "  .env exists but has placeholder values"
        if confirm "  Regenerate secrets?"; then
            bash "$SCRIPT_DIR/generate-secrets.sh"
        fi
    elif ! grep -q "^JWT_SECRET=" .env 2>/dev/null; then
        warn "  .env exists but is missing required variables"
        if confirm "  Run secret generator to fill missing values?"; then
            bash "$SCRIPT_DIR/generate-secrets.sh"
        fi
    else
        log "  .env exists and looks complete"
    fi
else
    log "  No .env found — generating from template"
    bash "$SCRIPT_DIR/generate-secrets.sh"
fi

# Validate critical vars exist
MISSING_VARS=()
for var in JWT_SECRET POSTGRES_PASSWORD INTERNAL_SERVICE_KEY DOCKER_GID; do
    val=$(grep "^${var}=" .env 2>/dev/null | cut -d= -f2-)
    if [ -z "$val" ] || [[ "$val" == *"CHANGE_ME"* ]]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    err "  Missing or placeholder values: ${MISSING_VARS[*]}"
    err "  Run: ./scripts/generate-secrets.sh"
    exit 1
fi
log "  .env validated (JWT_SECRET, POSTGRES_PASSWORD, INTERNAL_SERVICE_KEY, DOCKER_GID)"
echo ""

# ─── Matrix is optional (quox#801) ─────────────────────────
# docker-compose.yml attaches dashboard + auth to the external network created by the separate
# quox-matrix stack. On a machine without it, `docker compose up` refuses to create anything, so
# add the no-matrix override (persisted in .env so later `docker compose ...` calls agree).
if ! grep -q "^COMPOSE_FILE=" .env 2>/dev/null; then
    if docker network inspect quox-matrix_default &>/dev/null; then
        log "  Matrix network found: dashboard and auth will attach to it"
    else
        info "  No Matrix stack on this machine: using docker-compose.nomatrix.yml"
        echo "COMPOSE_FILE=docker-compose.yml:docker-compose.nomatrix.yml" >> .env
    fi
fi
echo ""

# ─── Step 3: SSL certificates ──────────────────────────────
log "Step 3/7: SSL certificates"

if [ -f ssl/quox.crt ] && [ -f ssl/quox.key ]; then
    CERT_EXPIRY=$(openssl x509 -in ssl/quox.crt -noout -enddate 2>/dev/null | cut -d= -f2)
    log "  Certificate exists (expires: $CERT_EXPIRY)"
else
    log "  No certificate found — generating self-signed cert"
    mkdir -p ssl

    LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

    openssl req -x509 -nodes -newkey rsa:2048 -days 730 \
        -keyout ssl/quox.key \
        -out ssl/quox.crt \
        -subj "/CN=QuoxCORE" \
        -addext "subjectAltName=IP:127.0.0.1,IP:${LOCAL_IP},DNS:localhost" \
        2>/dev/null

    chmod 600 ssl/quox.key
    chmod 644 ssl/quox.crt
    log "  Generated ssl/quox.crt (covers: localhost, 127.0.0.1, ${LOCAL_IP})"
fi
echo ""

# ─── Step 4: Dependencies (quoxflow, quoxmcp) ──────────────
log "Step 4/7: Dependencies"

# QuoxFlow
QUOXFLOW_PATH=$(grep "^QUOXFLOW_PATH=" .env 2>/dev/null | cut -d= -f2-)
# QuoxFlow ships inside this repository as ./quoxflow, so no locate/clone is needed.
if [ -z "$QUOXFLOW_PATH" ] && [ -d "./quoxflow" ]; then
    QUOXFLOW_PATH="./quoxflow"
fi
if [ -z "$QUOXFLOW_PATH" ]; then
    # Check common locations
    if [ -d "../quoxflow" ]; then
        QUOXFLOW_PATH="../quoxflow"
    elif [ -d "/opt/quoxcore/quoxflow" ]; then
        QUOXFLOW_PATH="/opt/quoxcore/quoxflow"
    fi
fi

if [ -n "$QUOXFLOW_PATH" ] && [ -d "$QUOXFLOW_PATH" ]; then
    log "  QuoxFlow: $QUOXFLOW_PATH"
    # Ensure it's set in .env for docker-compose
    if ! grep -q "^QUOXFLOW_PATH=" .env 2>/dev/null; then
        echo "QUOXFLOW_PATH=$QUOXFLOW_PATH" >> .env
    fi
else
    err "  QuoxFlow not found. It ships in this repository as ./quoxflow; re-clone the repository or set QUOXFLOW_PATH in .env."
    exit 1
fi

# QuoxMCP
QUOXMCP_PATH="${QUOXMCP_PATH:-../quoxmcp}"
if [ ! -d "$QUOXMCP_PATH" ]; then
    # Check common locations
    for p in "../quoxmcp" "/opt/quoxcore/quoxmcp" "/opt/quoxcore/quoxmcp"; do
        if [ -d "$p" ]; then QUOXMCP_PATH="$p"; break; fi
    done
fi

if [ -d "$QUOXMCP_PATH" ]; then
    log "  QuoxMCP: $QUOXMCP_PATH"
    # Ensure it's set in .env for docker-compose (else compose falls back to a
    # baked-in default path that only exists on the origin dev box)
    if ! grep -q "^QUOXMCP_PATH=" .env 2>/dev/null; then
        echo "QUOXMCP_PATH=$QUOXMCP_PATH" >> .env
    fi
    # Install dependencies if missing
    if [ ! -d "$QUOXMCP_PATH/node_modules" ]; then
        info "  Installing QuoxMCP dependencies..."
        if command -v npm &>/dev/null; then
            (cd "$QUOXMCP_PATH" && npm install --production --silent 2>&1 | tail -1)
        else
            # No Node on host — use Docker
            docker run --rm -v "$QUOXMCP_PATH":/app -w /app node:20-slim npm install --production --silent 2>&1 | tail -1
        fi
        log "  QuoxMCP dependencies installed"
    fi
else
    warn "  QuoxMCP not found. Cloning from GitHub..."
    CLONE_TARGET="../quoxmcp"
    if git clone git@github.com:quoxai/quoxmcp.git "$CLONE_TARGET" 2>/dev/null; then
        log "  Cloned QuoxMCP to $CLONE_TARGET"
    elif git clone https://github.com/quoxai/quoxmcp.git "$CLONE_TARGET" 2>/dev/null; then
        log "  Cloned QuoxMCP to $CLONE_TARGET (HTTPS)"
    else
        warn "  Failed to clone QuoxMCP. Chat will work but without infrastructure tools."
        warn "  Clone manually: git clone git@github.com:quoxai/quoxmcp.git $CLONE_TARGET"
    fi
    # Install deps after clone
    if [ -d "$CLONE_TARGET" ] && [ ! -d "$CLONE_TARGET/node_modules" ]; then
        info "  Installing QuoxMCP dependencies..."
        if command -v npm &>/dev/null; then
            (cd "$CLONE_TARGET" && npm install --production --silent 2>&1 | tail -1)
        else
            docker run --rm -v "$(cd "$CLONE_TARGET" && pwd)":/app -w /app node:20-slim npm install --production --silent 2>&1 | tail -1
        fi
        log "  QuoxMCP dependencies installed"
    fi
fi

# QuoxCLI
QUOXCLI_PATH="$PROJECT_ROOT/cli"
if [ -f "$QUOXCLI_PATH/package.json" ]; then
    log "  QuoxCLI: $QUOXCLI_PATH"
    if [ ! -d "$QUOXCLI_PATH/node_modules" ]; then
        info "  Installing QuoxCLI dependencies..."
        if command -v npm &>/dev/null; then
            (cd "$QUOXCLI_PATH" && npm install --silent 2>&1 | tail -1)
        else
            docker run --rm -v "$QUOXCLI_PATH":/app -w /app node:20-slim npm install --silent 2>&1 | tail -1
        fi
        log "  QuoxCLI dependencies installed"
    fi
else
    warn "  QuoxCLI package not found at $QUOXCLI_PATH"
fi

# Files service
FILES_SERVICE_PATH="$PROJECT_ROOT/services/files"
if [ -f "$FILES_SERVICE_PATH/package.json" ]; then
    log "  Files Service: $FILES_SERVICE_PATH"
    if [ ! -d "$FILES_SERVICE_PATH/node_modules" ]; then
        info "  Installing Files service dependencies..."
        if command -v npm &>/dev/null; then
            (cd "$FILES_SERVICE_PATH" && npm ci --silent 2>&1 | tail -1)
        else
            docker run --rm -v "$FILES_SERVICE_PATH":/app -w /app node:20-slim npm ci --silent 2>&1 | tail -1
        fi
        log "  Files service dependencies installed"
    fi
else
    warn "  Files service package not found at $FILES_SERVICE_PATH"
fi

if command -v claude &>/dev/null; then
    log "  Claude CLI: $(claude --version 2>/dev/null | head -1)"
else
    warn "  Claude CLI not found on host. Terminal OAuth login will be unavailable until Claude Code CLI is installed."
fi

# SSH keys directory
SSH_KEYS_PATH=$(grep "^SSH_KEYS_PATH=" .env 2>/dev/null | cut -d= -f2-)
SSH_KEYS_PATH="${SSH_KEYS_PATH:-./ssh-keys}"
if [ ! -d "$SSH_KEYS_PATH" ]; then
    mkdir -p "$SSH_KEYS_PATH"
    log "  Created $SSH_KEYS_PATH (add SSH keys for bastion access)"
fi
echo ""

# ─── Step 5: Clean up stale state ──────────────────────────
log "Step 5/7: Cleaning up stale state"

if [ "$RESET" = true ]; then
    warn "  --reset flag: removing all QuoxCORE containers and volumes"
    SETUP_RERUN=0 # the owner account goes with the volumes: the banner gives first-run guidance
    docker compose -p quox down -v 2>/dev/null || true
    docker compose down -v 2>/dev/null || true
    log "  Volumes and containers removed"
else
    # Check for old containers with conflicting names
    STALE_CONTAINERS=()
    for name in quox-dashboard quox-collector quox-auth quox-memory quox-tasks quox-files quox-orchestrator quox-postgres quox-qdrant quox-quoxflow; do
        if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"; then
            STALE_CONTAINERS+=("$name")
        fi
    done

    if [ ${#STALE_CONTAINERS[@]} -gt 0 ]; then
        warn "  Found ${#STALE_CONTAINERS[@]} existing QuoxCORE containers"
        if confirm "  Stop and remove them?"; then
            # Try project-based removal first
            docker compose -p quox down 2>/dev/null || true
            docker compose -p quox-dashboard down 2>/dev/null || true
            # Force remove any remaining
            for c in "${STALE_CONTAINERS[@]}"; do
                docker rm -f "$c" 2>/dev/null || true
            done
            log "  Old containers removed"
        fi
    else
        log "  No stale containers found"
    fi
fi
echo ""

# ─── Step 6: Build and start ───────────────────────────────
log "Step 6/7: Building and starting services"

# Source DOCKER_GID from .env for the build
export DOCKER_GID=$(grep "^DOCKER_GID=" .env | cut -d= -f2-)
if [ -z "$DOCKER_GID" ]; then
    DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3 || echo "988")
    export DOCKER_GID
fi

# quox#801: this step used to pipe into `tail -3`; a pipeline's status is the LAST command's,
# so a failed build read as success. Keep the full log in a file and test the BUILD's own exit
# status via PIPESTATUS (a global pipefail would break the `grep | cut` pipelines elsewhere in
# this script that legitimately have no match).
LOG_DIR="${QUOX_DIR:-$HOME/quox-install}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="${TMPDIR:-/tmp}"
BUILD_LOG="$LOG_DIR/build-$(date +%Y%m%d-%H%M%S).log"
# Z2H-R4: stamp the images with this checkout's short commit (the same form `quox server update` uses), so
# `quox server status` and the update health check can match the running build to the checkout. Without it
# every fresh install reported "Running 0.0.0 · differs from the checkout". A caller-set value wins.
if [ -z "${QUOXCORE_VERSION:-}" ]; then
    QUOXCORE_VERSION="$(git rev-parse --short HEAD 2>/dev/null || true)"
    [ -n "$QUOXCORE_VERSION" ] && export QUOXCORE_VERSION || unset QUOXCORE_VERSION
fi
# Z2H-R4: end stamp
# Z2H-R2: parallel buildx targets on a small box hit transient registry resets (ECONNRESET) on 3 of 4
# fresh-VM runs. Build one-at-a-time on <=2 cores, and retry (max 3 attempts) ONLY when the log shows
# a transient network error or a containerd/buildkit restart mid-build (Z2H-R3: unattended-upgrades); any other failure stops at once.
if [ -z "${COMPOSE_PARALLEL_LIMIT:-}" ]; then
    CORES=$(nproc 2>/dev/null || echo 4)
    if [ "$CORES" -le 2 ]; then export COMPOSE_PARALLEL_LIMIT=1; fi
fi
TRANSIENT_RE='ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND|TLS handshake timeout|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|unexpected HTTP status: 50[234]|error reading from server: EOF|failed to extract layer|rpc error: code = Unavailable|connection reset by peer|failed to solve:.*EOF'
BUILD_MAX="${QUOX_BUILD_ATTEMPTS:-3}"
BUILD_TRY=1
# Z2H-IMAGES: prefer prebuilt images from GHCR (ghcr.io/quoxai/quoxcore-<service>:<release tag>) and
# build locally only as a fallback. QUOX_IMAGES=build forces the local build; QUOX_IMAGES=prebuilt (the
# default whenever docker-compose.images.yml ships in this tree, i.e. public installs) tries the pull first.
IMAGE_SERVICES="dashboard auth files collector tasks orchestrator memory quoxbrain quoxflow"
PULLED=0
if [ -z "${QUOX_IMAGES:-}" ]; then
    if [ -f docker-compose.images.yml ]; then QUOX_IMAGES=prebuilt; else QUOX_IMAGES=build; fi
fi
if [ "$QUOX_IMAGES" = "prebuilt" ] && [ ! -f docker-compose.images.yml ]; then
    warn "  QUOX_IMAGES=prebuilt but docker-compose.images.yml is missing: building locally instead"
    QUOX_IMAGES=build
fi
if [ "$QUOX_IMAGES" = "prebuilt" ]; then
    if [ -z "${QUOX_IMAGE_TAG:-}" ]; then
        QUOX_IMAGE_TAG="v$(tr -d '[:space:]' < VERSION 2>/dev/null)"
        [ "$QUOX_IMAGE_TAG" = "v" ] && QUOX_IMAGE_TAG=latest
    fi
    export QUOX_IMAGE_TAG
    # compose reads COMPOSE_FILE from .env (the no-Matrix step above may have set it); keep that base.
    IMG_BASE="${COMPOSE_FILE:-$(grep '^COMPOSE_FILE=' .env 2>/dev/null | head -1 | cut -d= -f2-)}"
    IMG_BASE="${IMG_BASE:-docker-compose.yml}"
    case ":$IMG_BASE:" in *:docker-compose.images.yml:*) ;; *) IMG_BASE="$IMG_BASE:docker-compose.images.yml" ;; esac
    info "  Downloading prebuilt images (ghcr.io/quoxai/quoxcore-*:$QUOX_IMAGE_TAG)..."
    PULL_START=$(date +%s)
    PULL_MAX="${QUOX_PULL_ATTEMPTS:-3}"
    PULL_TRY=1
    while :; do
        COMPOSE_FILE="$IMG_BASE" docker compose pull $IMAGE_SERVICES 2>&1 | tee -a "$BUILD_LOG" | tail -3
        PULL_RC=${PIPESTATUS[0]}
        [ "$PULL_RC" -eq 0 ] && break
        if [ "$PULL_TRY" -lt "$PULL_MAX" ] && tail -200 "$BUILD_LOG" | grep -qE "$TRANSIENT_RE"; then
            PULL_TRY=$((PULL_TRY + 1))
            warn "  network hiccup during pull, retrying $PULL_TRY/$PULL_MAX"
            sleep "${QUOX_BUILD_RETRY_SLEEP:-10}"
            continue
        fi
        break
    done
    if [ "$PULL_RC" -eq 0 ]; then
        PULLED=1
        # persist the image overlay so the later `up` and any `docker compose ...` call agree with this install
        export COMPOSE_FILE="$IMG_BASE"
        if [ -f .env ]; then
            if grep -q "^COMPOSE_FILE=" .env; then sed -i "s#^COMPOSE_FILE=.*#COMPOSE_FILE=$IMG_BASE#" .env; else echo "COMPOSE_FILE=$IMG_BASE" >> .env; fi
            grep -q "^QUOX_IMAGE_TAG=" .env || echo "QUOX_IMAGE_TAG=$QUOX_IMAGE_TAG" >> .env
        fi
        log "  pulled prebuilt images in $(( $(date +%s) - PULL_START ))s"
    else
        PULL_WHY=$(tail -200 "$BUILD_LOG" | grep -iE 'not found|manifest unknown|denied|unauthorized|no such host|timeout|EOF|reset' | tail -1 | cut -c1-120)
        warn "  prebuilt images unavailable for $QUOX_IMAGE_TAG (${PULL_WHY:-pull exit $PULL_RC}): building locally instead"
    fi
fi
if [ "$PULLED" -ne 1 ]; then
    info "  Building images (this takes a few minutes on first run)..."
fi
while :; do
    if [ "$PULLED" -eq 1 ]; then BUILD_RC=0; break; fi
    DOCKER_GID="$DOCKER_GID" docker compose build 2>&1 | tee -a "$BUILD_LOG" | tail -3
    BUILD_RC=${PIPESTATUS[0]}
    [ "$BUILD_RC" -eq 0 ] && break
    if [ "$BUILD_TRY" -lt "$BUILD_MAX" ] && tail -200 "$BUILD_LOG" | grep -qE "$TRANSIENT_RE"; then
        BUILD_TRY=$((BUILD_TRY + 1))
        warn "  network hiccup during build, retrying $BUILD_TRY/$BUILD_MAX"
        sleep "${QUOX_BUILD_RETRY_SLEEP:-10}"
        continue
    fi
    break
done
if [ "$BUILD_RC" -ne 0 ]; then
    err "  Build failed (exit $BUILD_RC). Last lines:"
    tail -25 "$BUILD_LOG" | sed 's/^/    /'
    err "  Full build log: $BUILD_LOG"
    exit 1
fi
log "  Build log: $BUILD_LOG"

info "  Starting services..."
# Z2H-R4: `up` pulls the third-party images on a fresh box; pull quietly (no per-layer progress bars in
# the log) and retry transient registry errors the same way as BUILD. Any other failure stops at once.
START_TRY=1
while :; do
    DOCKER_GID="$DOCKER_GID" docker compose up -d --quiet-pull 2>&1 | tee -a "$BUILD_LOG"
    START_RC=${PIPESTATUS[0]}
    [ "$START_RC" -eq 0 ] && break
    if [ "$START_TRY" -lt "$BUILD_MAX" ] && tail -200 "$BUILD_LOG" | grep -qE "$TRANSIENT_RE"; then
        START_TRY=$((START_TRY + 1))
        warn "  network hiccup while starting, retrying $START_TRY/$BUILD_MAX"
        sleep "${QUOX_BUILD_RETRY_SLEEP:-10}"
        continue
    fi
    break
done
if [ "$START_RC" -ne 0 ]; then
    err "  Failed to start. Check: docker compose logs  (start output is in $BUILD_LOG)"
    exit 1
fi
echo ""

# ─── Step 7: Wait for health and print URL ─────────────────
log "Step 7/7: Waiting for services to start"

MAX_WAIT=90
WAITED=0
CRITICAL_SERVICES=(
    "quox-dashboard"
    "quox-auth"
    "quox-collector"
    "quox-files"
    "quox-tasks"
    "quox-postgres"
    "quox-qdrant"
    "quox-quoxflow"
)

get_service_status() {
    local service_name="$1"
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$service_name" 2>/dev/null || echo "missing"
}

while [ $WAITED -lt $MAX_WAIT ]; do
    READY_COUNT=0
    NOT_READY=()
    for service in "${CRITICAL_SERVICES[@]}"; do
        status=$(get_service_status "$service")
        case "$status" in
            healthy|running)
                READY_COUNT=$((READY_COUNT + 1))
                ;;
            *)
                NOT_READY+=("${service}:${status}")
                ;;
        esac
    done

    if [ "$READY_COUNT" -eq "${#CRITICAL_SERVICES[@]}" ]; then
        break
    fi

    printf "\r  ${CYAN}Ready: %d/%d critical services (waiting...)${NC}  " "$READY_COUNT" "${#CRITICAL_SERVICES[@]}"
    sleep 3
    WAITED=$((WAITED + 3))
done
echo ""

# Final status
echo ""
echo -e "${BOLD}Service Status:${NC}"
docker ps --filter "name=quox-" --format "  {{.Names}}\t{{.Status}}" | sort
echo ""

# Detect any failures
FAILED=$(docker ps --filter "name=quox-" --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i "restarting\|exited" || true)
if [ -n "$FAILED" ]; then
    warn "Some services are not healthy:"
    echo "$FAILED" | while read line; do echo "  $line"; done
    warn "Check logs: docker compose logs <service-name>"
    echo ""
fi

CRITICAL_NOT_READY=()
for service in "${CRITICAL_SERVICES[@]}"; do
    status=$(get_service_status "$service")
    case "$status" in
        healthy|running)
            ;;
        *)
            CRITICAL_NOT_READY+=("${service} (${status})")
            ;;
    esac
done

# Z2H-3c: final banner (start)
# The address saved in CORS_ORIGINS is from the FIRST install; a DHCP change makes it stale. Print the
# current one, and say when it moved (the self-signed certificate still names the old address).
SAVED_IP=$(grep "^CORS_ORIGINS=" .env 2>/dev/null | grep -oE '([0-9]+\.){3}[0-9]+' | grep -v '^127\.' | head -1)
CUR_IP=$(ip route get 1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
LOCAL_IP="${CUR_IP:-${SAVED_IP:-localhost}}"

if [ ${#CRITICAL_NOT_READY[@]} -eq 0 ]; then
    echo -e "${GREEN}${BOLD}QuoxCORE full platform is ready!${NC}"
else
    echo -e "${YELLOW}${BOLD}QuoxCORE core shell is up, but platform features are degraded.${NC}"
    echo ""
    warn "Critical services still not ready:"
    for service in "${CRITICAL_NOT_READY[@]}"; do
        echo "  - $service"
    done
    echo ""
    warn "Workflows, approvals, policies, Objectives, Mission Control, and Agentic Teams may be unavailable until those services are healthy."
fi
echo ""
echo -e "  Open: ${BOLD}https://${LOCAL_IP}:3000${NC}"
if [ -n "$SAVED_IP" ] && [ -n "$CUR_IP" ] && [ "$SAVED_IP" != "$CUR_IP" ]; then
    warn "This machine's address changed since install (was ${SAVED_IP}, now ${CUR_IP})."
    warn "  The browser certificate still names ${SAVED_IP}. To reissue it: rm ssl/quox.crt ssl/quox.key && ./scripts/setup.sh"
fi
echo ""
if [ "${SETUP_RERUN:-0}" = "1" ]; then
    echo "  Sign in with your existing owner account; nothing about it changed."
    echo "  In a terminal: quox (or quox login if your session ended)."
else
    echo "  Complete the Setup Wizard to configure your API keys and create"
    echo "  your first admin account."
    echo "  Then confirm Web Terminal and Quox CLI health in Verify before"
    echo "  treating the install as fully ready."
fi
echo ""
# Z2H-3c: final banner (end)
echo "  Useful commands:"
echo "    ./scripts/post-install-smoke.sh https://${LOCAL_IP}:3000  # Verify platform proxies and critical services"
echo "    docker compose logs -f          # View all logs"
echo "    docker compose ps               # Service status"
echo "    docker compose down             # Stop everything"
echo "    ./scripts/setup.sh --reset      # Factory reset (wipes data)"
echo ""
