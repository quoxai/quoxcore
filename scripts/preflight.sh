#!/bin/bash
# QuoxCORE Preflight Check Script
# Verifies system requirements before installation
#
# Usage:
#   ./scripts/preflight.sh         # Full check for Docker Compose deployment
#   ./scripts/preflight.sh --dev   # Development mode (skips Docker daemon check)
#   ./scripts/preflight.sh --help  # Show help
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

# Don't use set -e as we need to continue after failed checks

# Parse arguments
DEV_MODE=false
SHOW_HELP=false

for arg in "$@"; do
    case $arg in
        --dev)
            DEV_MODE=true
            ;;
        --help|-h)
            SHOW_HELP=true
            ;;
    esac
done

if [ "$SHOW_HELP" = true ]; then
    echo "QuoxCORE Preflight Check"
    echo ""
    echo "Usage:"
    echo "  ./scripts/preflight.sh         Full check for Docker Compose deployment"
    echo "  ./scripts/preflight.sh --dev   Development mode check"
    echo "  ./scripts/preflight.sh --help  Show this help"
    echo ""
    echo "Options:"
    echo "  --dev   Skip Docker daemon check (for dev mode where you run"
    echo "          support services like postgres/quoxflow/qdrant separately)"
    echo ""
    exit 0
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
WARNED=0
FAILED=0

# Minimum requirements
MIN_RAM_GB=4
MIN_DISK_GB=10
REQUIRED_PORTS="80 3000 3101 3104 3200 5432 6333"

echo ""
if [ "$DEV_MODE" = true ]; then
    echo "QuoxCORE Preflight Check (Development Mode)"
else
    echo "QuoxCORE Preflight Check"
fi
echo "========================================"
echo ""

# Function to print status
check_pass() {
    echo -e "  ${GREEN}✓${NC} $1"
    PASSED=$((PASSED + 1))
}

check_warn() {
    echo -e "  ${YELLOW}!${NC} $1"
    WARNED=$((WARNED + 1))
}

check_fail() {
    echo -e "  ${RED}✗${NC} $1"
    FAILED=$((FAILED + 1))
}

# ---------------------------------------------
# OS Check
# ---------------------------------------------
echo "Operating System:"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        check_pass "$NAME $VERSION_ID"
    else
        check_pass "Linux (unknown distribution)"
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    check_pass "macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
else
    check_warn "Unknown OS: $OSTYPE (may work but untested)"
fi
echo ""

# ---------------------------------------------
# Docker Check
# ---------------------------------------------
echo "Docker:"
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if [ -n "$DOCKER_VERSION" ]; then
        if [ "$DEV_MODE" = true ]; then
            # In dev mode, just check Docker is installed
            check_pass "Docker $DOCKER_VERSION (installed)"
            echo -e "  ${YELLOW}!${NC} Dev mode: Start support services such as postgres, quoxflow, qdrant, and optional n8n separately"
        else
            # Full mode: check if Docker daemon is running
            # Try multiple methods - docker info may fail without sudo but Docker still works
            if docker info &> /dev/null; then
                check_pass "Docker $DOCKER_VERSION (running)"
            elif docker ps &> /dev/null; then
                # docker ps works even when docker info doesn't
                check_pass "Docker $DOCKER_VERSION (running)"
            elif sudo -n docker ps &> /dev/null 2>&1; then
                # Try with passwordless sudo
                check_pass "Docker $DOCKER_VERSION (running with sudo)"
            else
                check_fail "Docker $DOCKER_VERSION (not running or needs sudo - try: sudo docker ps)"
            fi
        fi
    else
        check_fail "Docker installed but version unknown"
    fi
else
    if [ "$DEV_MODE" = true ]; then
        check_warn "Docker not installed (needed for n8n and Qdrant)"
    else
        check_fail "Docker not installed (install from https://docs.docker.com/engine/install/)"
    fi
fi

# Docker Compose check
if command -v docker &> /dev/null; then
    if docker compose version &> /dev/null; then
        COMPOSE_VERSION=$(docker compose version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        check_pass "Docker Compose v$COMPOSE_VERSION"
    elif command -v docker-compose &> /dev/null; then
        check_warn "docker-compose (legacy) - recommend upgrading to Compose v2"
    else
        if [ "$DEV_MODE" = false ]; then
            check_fail "Docker Compose not available"
        else
            check_warn "Docker Compose not available"
        fi
    fi
fi
echo ""

# ---------------------------------------------
# Node.js Check (required for development mode)
# ---------------------------------------------
echo "Node.js:"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version 2>/dev/null | tr -d 'v')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 20 ]; then
        check_pass "Node.js v$NODE_VERSION"
    else
        if [ "$DEV_MODE" = true ]; then
            check_fail "Node.js v$NODE_VERSION (v20+ required for development)"
        else
            check_warn "Node.js v$NODE_VERSION (v20+ recommended)"
        fi
    fi
else
    if [ "$DEV_MODE" = true ]; then
        check_fail "Node.js not installed (required for development mode)"
    else
        check_warn "Node.js not installed (only needed for development mode)"
    fi
fi
echo ""

# ---------------------------------------------
# QuoxMCP Dependency Check
# ---------------------------------------------
echo "Dependencies:"
QUOXFLOW_CHECK_PATH="${QUOXFLOW_PATH:-../quoxflow}"
if [ ! -d "$QUOXFLOW_CHECK_PATH" ]; then
    for p in "../quoxflow" "/opt/quoxcore/quoxflow" "/opt/quoxcore/quoxflow"; do
        if [ -d "$p" ]; then
            QUOXFLOW_CHECK_PATH="$p"
            break
        fi
    done
fi

if [ -d "$QUOXFLOW_CHECK_PATH" ]; then
    if [ -f "$QUOXFLOW_CHECK_PATH/package.json" ]; then
        check_pass "QuoxFlow found at $QUOXFLOW_CHECK_PATH"
    else
        check_warn "QuoxFlow directory exists but package.json missing at $QUOXFLOW_CHECK_PATH"
    fi
else
    check_warn "QuoxFlow not found at ${QUOXFLOW_PATH:-../quoxflow}"
    echo -e "    Workflows, approvals, policies, and automation depend on QuoxFlow."
    echo -e "    Clone it alongside this repo or set QUOXFLOW_PATH:"
    echo -e "    git clone git@github.com:quoxai/quoxflow.git ../quoxflow"
fi

QUOXMCP_CHECK_PATH="${QUOXMCP_PATH:-/opt/quoxcore/quoxmcp}"
if [ -d "$QUOXMCP_CHECK_PATH" ]; then
    if [ -f "$QUOXMCP_CHECK_PATH/server.js" ]; then
        check_pass "QuoxMCP found at $QUOXMCP_CHECK_PATH"
    else
        check_warn "QuoxMCP directory exists but server.js missing at $QUOXMCP_CHECK_PATH"
    fi
else
    check_warn "QuoxMCP not found at $QUOXMCP_CHECK_PATH"
    echo -e "    Collector MCP tools require quoxmcp. Clone it:"
    echo -e "    git clone git@github.com:quoxai/quoxmcp.git $QUOXMCP_CHECK_PATH"
fi
echo ""

# ---------------------------------------------
# Terminal / CLI Runtime Check
# ---------------------------------------------
echo "Terminal Runtime:"
if [ -f "./cli/package.json" ]; then
    check_pass "QuoxCLI package present at ./cli"
    if [ -d "./cli/node_modules" ]; then
        check_pass "QuoxCLI dependencies installed"
    else
        check_warn "QuoxCLI dependencies missing at ./cli/node_modules"
        echo -e "    Run: (cd cli && npm install)"
    fi
else
    check_warn "QuoxCLI package missing at ./cli"
fi

if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1)
    check_pass "Claude CLI available${CLAUDE_VERSION:+ ($CLAUDE_VERSION)}"
else
    check_warn "Claude CLI not installed"
    echo -e "    Claude terminal OAuth will be unavailable until Claude Code CLI is installed."
fi
echo ""

# ---------------------------------------------
# Files Service Runtime Check
# ---------------------------------------------
echo "Files Service:"
if [ -f "services/files/package.json" ]; then
    check_pass "Files service package present at ./services/files"
    if [ -d "services/files/node_modules" ]; then
        check_pass "Files service dependencies installed"
    else
        check_warn "Files service dependencies missing (run: cd services/files && npm ci)"
    fi
else
    check_warn "Files service package missing from services/files"
fi

if command -v curl &> /dev/null; then
    if curl -sf http://127.0.0.1:3102/health >/dev/null 2>&1; then
        check_pass "Files service responding on :3102"
    else
        check_warn "Files service not responding on :3102"
        echo -e "    Uploads, attachments, and artifact-backed workflows require the files service."
        echo -e "    In dev mode, install deps and start it alongside auth + collector."
    fi
else
    check_warn "curl not available - cannot verify Files service health"
fi
echo ""

# ---------------------------------------------
# QuoxFlow Runtime Check
# ---------------------------------------------
echo "Workflow Engine:"
if command -v curl &> /dev/null; then
    if curl -sf http://127.0.0.1:3200/health >/dev/null 2>&1; then
        check_pass "QuoxFlow responding on :3200"
    else
        check_warn "QuoxFlow not responding on :3200"
        echo -e "    Workflows, Workflow Builder, approvals, policies, and automation require QuoxFlow."
        echo -e "    In dev mode, start QuoxFlow and PostgreSQL alongside auth + collector."
    fi
else
    check_warn "curl not available - cannot verify QuoxFlow health"
fi
echo ""

# ---------------------------------------------
# Development runtime tooling check
# ---------------------------------------------
if [ "$DEV_MODE" = true ]; then
    echo "Development Runtime Tooling:"

    if command -v make &> /dev/null; then
        check_pass "make available"
    else
        check_warn "make missing (collector optional dependencies like node-pty may fail to build)"
    fi

    if command -v gcc &> /dev/null; then
        check_pass "gcc available"
    else
        check_warn "gcc missing (collector optional dependencies like node-pty may fail to build)"
    fi

    if command -v g++ &> /dev/null; then
        check_pass "g++ available"
    else
        check_warn "g++ missing (collector optional dependencies like node-pty may fail to build)"
    fi

    if command -v claude &> /dev/null; then
        check_pass "Claude CLI installed"
    else
        check_warn "Claude CLI not installed (terminal-based Claude OAuth will be unavailable)"
    fi

    if [ -f "services/tasks/package.json" ]; then
        if [ -d "services/tasks/node_modules" ]; then
            check_pass "Tasks service dependencies installed"
        else
            check_warn "Tasks service dependencies missing (run: cd services/tasks && npm ci)"
        fi
    else
        check_warn "Tasks service package missing from services/tasks"
    fi

    if [ -f "services/files/package.json" ]; then
        if [ -d "services/files/node_modules" ]; then
            check_pass "Files service dependencies installed"
        else
            check_warn "Files service dependencies missing (run: cd services/files && npm ci)"
        fi
    else
        check_warn "Files service package missing from services/files"
    fi
    echo ""
fi

# ---------------------------------------------
# Task Service Runtime Check
# ---------------------------------------------
echo "Task Service:"
if command -v curl &> /dev/null; then
    if curl -sf http://127.0.0.1:3104/health >/dev/null 2>&1; then
        check_pass "Task service responding on :3104"
    else
        check_warn "Task service not responding on :3104"
        echo -e "    Objectives, Mission Control, and Agentic Teams require the task service."
        echo -e "    In dev mode, start it alongside auth + collector."
    fi
else
    check_warn "curl not available - cannot verify task service health"
fi
echo ""

# ---------------------------------------------
# Memory Check
# ---------------------------------------------
echo "Memory:"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
    AVAIL_RAM_KB=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
    AVAIL_RAM_GB=$((AVAIL_RAM_KB / 1024 / 1024))
elif [[ "$OSTYPE" == "darwin"* ]]; then
    TOTAL_RAM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    TOTAL_RAM_GB=$((TOTAL_RAM_BYTES / 1024 / 1024 / 1024))
    AVAIL_RAM_GB=$TOTAL_RAM_GB  # macOS doesn't have easy available memory
fi

if [ "$TOTAL_RAM_GB" -ge "$MIN_RAM_GB" ]; then
    check_pass "Total: ${TOTAL_RAM_GB}GB (minimum: ${MIN_RAM_GB}GB)"
else
    check_fail "Total: ${TOTAL_RAM_GB}GB (minimum: ${MIN_RAM_GB}GB required)"
fi
echo ""

# ---------------------------------------------
# Disk Space Check
# ---------------------------------------------
echo "Disk Space:"
if [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "darwin"* ]]; then
    DISK_AVAIL_KB=$(df -k . | tail -1 | awk '{print $4}')
    DISK_AVAIL_GB=$((DISK_AVAIL_KB / 1024 / 1024))

    if [ "$DISK_AVAIL_GB" -ge "$MIN_DISK_GB" ]; then
        check_pass "Available: ${DISK_AVAIL_GB}GB (minimum: ${MIN_DISK_GB}GB)"
    else
        check_fail "Available: ${DISK_AVAIL_GB}GB (minimum: ${MIN_DISK_GB}GB required)"
    fi
fi
echo ""

# ---------------------------------------------
# Port Availability Check
# ---------------------------------------------
echo "Required Ports:"

# Map ports to expected services
get_expected_service() {
    case $1 in
        3000) echo "dashboard" ;;
        3100) echo "orchestrator" ;;
        3101) echo "auth" ;;
        3102) echo "files" ;;
        3103) echo "memory" ;;
        5678) echo "n8n" ;;
        6333) echo "qdrant" ;;
        9848) echo "collector" ;;
        *) echo "" ;;
    esac
}

# Check if port is used by expected QuoxCORE service
is_quoxcore_service() {
    local PORT=$1
    local EXPECTED=$(get_expected_service $PORT)

    if [ -z "$EXPECTED" ]; then
        return 1
    fi

    # Check Docker containers for the port (most reliable when QuoxCORE runs in Docker)
    if command -v docker &> /dev/null && docker ps &> /dev/null; then
        # Match port in Ports column (handles 127.0.0.1:3101->3101/tcp, 0.0.0.0:9848->9848/tcp etc.)
        local CONTAINER=$(docker ps --format '{{.Names}}:{{.Ports}}' 2>/dev/null | grep -E ":${PORT}->" | cut -d: -f1 | head -1)
        if [ -n "$CONTAINER" ]; then
            case $EXPECTED in
                n8n) [[ "$CONTAINER" == *"n8n"* ]] && return 0 ;;
                qdrant) [[ "$CONTAINER" == *"qdrant"* ]] && return 0 ;;
                dashboard) [[ "$CONTAINER" == *"dashboard"* ]] && return 0 ;;
                auth) [[ "$CONTAINER" == *"auth"* ]] && return 0 ;;
                collector) [[ "$CONTAINER" == *"collector"* ]] && return 0 ;;
                memory) [[ "$CONTAINER" == *"memory"* ]] && return 0 ;;
                orchestrator) [[ "$CONTAINER" == *"orchestrator"* ]] && return 0 ;;
                files) [[ "$CONTAINER" == *"files"* ]] && return 0 ;;
                postgres) [[ "$CONTAINER" == *"postgres"* ]] && return 0 ;;
                quoxflow) [[ "$CONTAINER" == *"quoxflow"* ]] && return 0 ;;
            esac
        fi
    fi

    # Fallback: check process name via lsof (for non-Docker setups or docker-proxy)
    if command -v lsof &> /dev/null; then
        local PROCESS=$(lsof -i ":${PORT}" 2>/dev/null | tail -1 | awk '{print tolower($1)}')
        # docker-proxy means a Docker container owns this port — likely QuoxCORE
        [[ "$PROCESS" == *"docker"* ]] && return 0
        case $EXPECTED in
            n8n) [[ "$PROCESS" == *"node"* ]] || [[ "$PROCESS" == *"n8n"* ]] && return 0 ;;
            qdrant) [[ "$PROCESS" == *"qdrant"* ]] && return 0 ;;
            dashboard) [[ "$PROCESS" == *"node"* ]] || [[ "$PROCESS" == *"nginx"* ]] && return 0 ;;
            auth) [[ "$PROCESS" == *"node"* ]] && return 0 ;;
            collector) [[ "$PROCESS" == *"node"* ]] && return 0 ;;
            memory) [[ "$PROCESS" == *"node"* ]] && return 0 ;;
            postgres) [[ "$PROCESS" == *"postgres"* ]] && return 0 ;;
        esac
    fi

    return 1
}

for PORT in $REQUIRED_PORTS; do
    if command -v ss &> /dev/null; then
        IN_USE=$(ss -tuln 2>/dev/null | grep -c ":${PORT} " || true)
    elif command -v netstat &> /dev/null; then
        IN_USE=$(netstat -tuln 2>/dev/null | grep -c ":${PORT} " || true)
    elif command -v lsof &> /dev/null; then
        IN_USE=$(lsof -i ":${PORT}" 2>/dev/null | wc -l || true)
    else
        IN_USE=0
        check_warn "Port $PORT (cannot verify - ss/netstat/lsof not available)"
        continue
    fi

    if [ "$IN_USE" -eq 0 ]; then
        check_pass "Port $PORT available"
    else
        EXPECTED=$(get_expected_service $PORT)
        if is_quoxcore_service $PORT; then
            check_pass "Port $PORT in use by $EXPECTED (expected)"
        else
            check_fail "Port $PORT in use by another process (check with: lsof -i :$PORT)"
        fi
    fi
done
echo ""

# ---------------------------------------------
# Summary
# ---------------------------------------------
echo "========================================"
echo "Summary"
echo "========================================"
echo -e "  Passed:   ${GREEN}$PASSED${NC}"
echo -e "  Warnings: ${YELLOW}$WARNED${NC}"
echo -e "  Failed:   ${RED}$FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}All critical checks passed!${NC}"
    echo ""
    if [ "$DEV_MODE" = true ]; then
        echo "Next steps (Development Mode):"
        echo "  1. docker compose up -d postgres quoxflow tasks qdrant  # Start required services"
        echo "  2. npm install                       # Install dependencies"
        echo "  3. cd services/auth && npm install   # Install auth deps"
        echo "  4. cd services/auth && npm run init-db  # Initialize database"
        echo "  5. npm run dev                       # Start development server"
        echo ""
        echo "See docs/SETUP.md for detailed instructions."
    else
        echo "Next steps:"
        echo "  1. ./scripts/generate-secrets.sh  # Generate secure secrets"
        echo "  2. docker compose up -d            # Start services"
        echo "  3. Open https://localhost:3000     # Complete setup wizard"
    fi
    echo ""
    exit 0
else
    echo -e "${RED}Some checks failed. Please fix the issues above before proceeding.${NC}"
    echo ""
    exit 1
fi
