#!/bin/bash
#
# Quox Platform Load Test Script
# ==============================
# Basic load testing using curl and Apache Bench (ab)
#
# Usage:
#   ./load-test.sh                    # Run all tests
#   ./load-test.sh --health-only      # Test health endpoints only
#   ./load-test.sh --inbox-only       # Test inbox endpoints only
#   ./load-test.sh --full             # Run comprehensive tests
#   ./load-test.sh --help             # Show help
#
# Requirements:
#   - curl (usually pre-installed)
#   - ab (Apache Bench): apt-get install apache2-utils
#   - jq (optional, for JSON parsing): apt-get install jq
#
# Created: 2026-02-04
# See: docs/LOAD_TEST_PLAN.md for full testing documentation

set -e

# =============================================================================
# Configuration
# =============================================================================

# Default values
BASE_URL="${BASE_URL:-http://localhost:3000}"
AUTH_URL="${AUTH_URL:-http://localhost:3101}"
COLLECTOR_URL="${COLLECTOR_URL:-http://localhost:9848}"
N8N_URL="${N8N_URL:-http://localhost:5678}"

CONCURRENCY="${CONCURRENCY:-10}"
REQUESTS="${REQUESTS:-100}"
TIMEOUT="${TIMEOUT:-30}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Results storage
RESULTS_DIR="/tmp/quox-load-test-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_header() {
    echo ""
    echo "=============================================================================="
    echo " $1"
    echo "=============================================================================="
    echo ""
}

check_dependencies() {
    log_info "Checking dependencies..."

    local missing=()

    if ! command -v curl &> /dev/null; then
        missing+=("curl")
    fi

    if ! command -v ab &> /dev/null; then
        log_warning "Apache Bench (ab) not found. Install with: apt-get install apache2-utils"
        log_warning "Some tests will be skipped."
        AB_AVAILABLE=false
    else
        AB_AVAILABLE=true
    fi

    if ! command -v jq &> /dev/null; then
        log_warning "jq not found. Install with: apt-get install jq"
        log_warning "JSON parsing will be limited."
        JQ_AVAILABLE=false
    else
        JQ_AVAILABLE=true
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required dependencies: ${missing[*]}"
        exit 1
    fi

    log_success "Dependencies OK"
}

check_services() {
    log_info "Checking service availability..."

    local all_ok=true

    # Dashboard
    if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
        log_success "Dashboard (${BASE_URL}) - OK"
    else
        log_error "Dashboard (${BASE_URL}) - UNREACHABLE"
        all_ok=false
    fi

    # Auth
    if curl -sf "${AUTH_URL}/health" > /dev/null 2>&1; then
        log_success "Auth Service (${AUTH_URL}) - OK"
    else
        log_error "Auth Service (${AUTH_URL}) - UNREACHABLE"
        all_ok=false
    fi

    # Collector
    if curl -sf "${COLLECTOR_URL}/health" > /dev/null 2>&1; then
        log_success "Collector (${COLLECTOR_URL}) - OK"
    else
        log_error "Collector (${COLLECTOR_URL}) - UNREACHABLE"
        all_ok=false
    fi

    # n8n
    if curl -sf "${N8N_URL}/healthz" > /dev/null 2>&1; then
        log_success "n8n (${N8N_URL}) - OK"
    else
        log_warning "n8n (${N8N_URL}) - UNREACHABLE (some tests may fail)"
    fi

    if [ "$all_ok" = false ]; then
        log_error "Not all services are available. Please start services first:"
        log_info "  cd /opt/quoxcore && docker compose up -d"
        exit 1
    fi

    echo ""
}

# =============================================================================
# Test Functions
# =============================================================================

test_health_endpoints() {
    log_header "Test 1: Health Endpoints"

    local endpoints=(
        "${BASE_URL}/health:Dashboard"
        "${AUTH_URL}/health:Auth"
        "${COLLECTOR_URL}/health:Collector"
    )

    for endpoint_info in "${endpoints[@]}"; do
        IFS=':' read -r url name <<< "$endpoint_info"

        log_info "Testing ${name} health endpoint..."

        if [ "$AB_AVAILABLE" = true ]; then
            # Use Apache Bench for concurrent testing
            ab -n "$REQUESTS" -c "$CONCURRENCY" -q "$url" 2>&1 | tee "$RESULTS_DIR/health-${name,,}.txt" | \
                grep -E "(Requests per second|Time per request|Failed requests|Percentage.*served)"

            # Check for failures
            local failed=$(grep "Failed requests" "$RESULTS_DIR/health-${name,,}.txt" | awk '{print $3}')
            if [ "$failed" = "0" ]; then
                log_success "${name}: All ${REQUESTS} requests succeeded"
            else
                log_error "${name}: ${failed} requests failed"
            fi
        else
            # Fallback to sequential curl testing
            local success=0
            local fail=0
            local total_time=0

            for i in $(seq 1 20); do
                start_time=$(date +%s%N)
                if curl -sf "$url" > /dev/null 2>&1; then
                    ((success++))
                else
                    ((fail++))
                fi
                end_time=$(date +%s%N)
                elapsed=$(( (end_time - start_time) / 1000000 ))
                total_time=$((total_time + elapsed))
            done

            avg_time=$((total_time / 20))
            log_info "${name}: ${success}/20 successful, avg ${avg_time}ms"

            if [ $fail -eq 0 ]; then
                log_success "${name}: All requests succeeded"
            else
                log_warning "${name}: ${fail} requests failed"
            fi
        fi

        echo ""
    done
}

test_health_latency() {
    log_header "Test 2: Health Endpoint Latency Distribution"

    log_info "Collecting latency samples for ${BASE_URL}/health..."

    local samples=()
    for i in $(seq 1 50); do
        # Get response time in milliseconds
        time_ms=$(curl -sf -o /dev/null -w '%{time_total}' "${BASE_URL}/health" 2>/dev/null)
        time_ms=$(echo "$time_ms * 1000" | bc 2>/dev/null || echo "0")
        samples+=("${time_ms%.*}")

        # Show progress
        if [ $((i % 10)) -eq 0 ]; then
            echo -n "."
        fi
    done
    echo ""

    # Sort samples for percentile calculation
    sorted=($(printf '%s\n' "${samples[@]}" | sort -n))

    # Calculate percentiles
    p50_idx=$((50 * 50 / 100))
    p95_idx=$((95 * 50 / 100))
    p99_idx=$((99 * 50 / 100))

    p50="${sorted[$p50_idx]}"
    p95="${sorted[$p95_idx]}"
    p99="${sorted[$p99_idx]}"
    min="${sorted[0]}"
    max="${sorted[-1]}"

    echo ""
    echo "Latency Distribution (50 samples):"
    echo "  Min:  ${min}ms"
    echo "  p50:  ${p50}ms"
    echo "  p95:  ${p95}ms"
    echo "  p99:  ${p99}ms"
    echo "  Max:  ${max}ms"
    echo ""

    # Evaluate against targets
    if [ "${p99:-0}" -lt 100 ]; then
        log_success "p99 latency (${p99}ms) is under 100ms target"
    elif [ "${p99:-0}" -lt 200 ]; then
        log_warning "p99 latency (${p99}ms) is marginal (target: <100ms)"
    else
        log_error "p99 latency (${p99}ms) exceeds target (100ms)"
    fi
}

test_concurrent_connections() {
    log_header "Test 3: Concurrent Connection Handling"

    if [ "$AB_AVAILABLE" != true ]; then
        log_warning "Skipping concurrent connection test (requires ab)"
        return
    fi

    local concurrency_levels=(10 25 50 100)

    for c in "${concurrency_levels[@]}"; do
        log_info "Testing with ${c} concurrent connections..."

        # Run 500 requests at this concurrency level
        local output=$(ab -n 500 -c "$c" -q "${BASE_URL}/health" 2>&1)

        local rps=$(echo "$output" | grep "Requests per second" | awk '{print $4}')
        local time_per_req=$(echo "$output" | grep "Time per request.*\(mean\)" | head -1 | awk '{print $4}')
        local failed=$(echo "$output" | grep "Failed requests" | awk '{print $3}')

        echo "  Concurrency: ${c}"
        echo "  Requests/sec: ${rps}"
        echo "  Avg time/req: ${time_per_req}ms"
        echo "  Failed: ${failed}"

        if [ "$failed" = "0" ]; then
            log_success "Concurrency ${c}: No failures"
        else
            log_error "Concurrency ${c}: ${failed} failures"
        fi

        echo ""
    done
}

test_inbox_api() {
    log_header "Test 4: Inbox API Endpoints"

    # Note: Inbox endpoints require authentication
    # This test checks if they respond correctly (even if 401)

    log_info "Testing inbox endpoint accessibility..."

    # Test without auth (should get 401)
    local status=$(curl -sf -o /dev/null -w '%{http_code}' "${AUTH_URL}/api/orgs/test-org/inbox" 2>/dev/null || echo "000")

    if [ "$status" = "401" ]; then
        log_success "Inbox API correctly requires authentication (HTTP 401)"
    elif [ "$status" = "200" ]; then
        log_warning "Inbox API returned 200 without auth (check security)"
    else
        log_error "Inbox API returned unexpected status: ${status}"
    fi

    # Test health-like endpoints that don't require auth
    log_info "Testing public endpoints..."

    local public_endpoints=(
        "${AUTH_URL}/health"
        "${COLLECTOR_URL}/health"
        "${COLLECTOR_URL}/metrics"
    )

    for endpoint in "${public_endpoints[@]}"; do
        local status=$(curl -sf -o /dev/null -w '%{http_code}' "$endpoint" 2>/dev/null || echo "000")
        if [ "$status" = "200" ]; then
            log_success "${endpoint} - OK (HTTP 200)"
        else
            log_warning "${endpoint} - HTTP ${status}"
        fi
    done
}

test_sse_connections() {
    log_header "Test 5: SSE Connection Capacity"

    log_info "Testing SSE endpoint accessibility..."

    # Test SSE endpoint (without auth, expect 401)
    local status=$(curl -sf -o /dev/null -w '%{http_code}' \
        -H "Accept: text/event-stream" \
        "${AUTH_URL}/api/orgs/test-org/inbox/stream" 2>/dev/null || echo "000")

    if [ "$status" = "401" ]; then
        log_success "SSE endpoint correctly requires authentication"
    else
        log_info "SSE endpoint returned: HTTP ${status}"
    fi

    log_info "Simulating multiple short-lived connections..."

    # Simulate connection establishment (without auth, we'll get 401s but connection works)
    local success=0
    local fail=0

    for i in $(seq 1 20); do
        # Try to establish connection (will fail auth but tests connectivity)
        if timeout 2 curl -sf \
            -H "Accept: text/event-stream" \
            "${AUTH_URL}/api/orgs/test/inbox/stream" > /dev/null 2>&1; then
            ((success++))
        else
            # 401 is expected, still counts as "reachable"
            local code=$(curl -sf -o /dev/null -w '%{http_code}' \
                -H "Accept: text/event-stream" \
                "${AUTH_URL}/api/orgs/test/inbox/stream" 2>/dev/null || echo "000")
            if [ "$code" = "401" ]; then
                ((success++))
            else
                ((fail++))
            fi
        fi
    done

    log_info "Connection attempts: ${success} reachable, ${fail} unreachable"

    if [ $fail -eq 0 ]; then
        log_success "All connection attempts reached the server"
    else
        log_warning "Some connections failed"
    fi
}

test_sustained_load() {
    log_header "Test 6: Sustained Load Test (2 minutes)"

    if [ "$AB_AVAILABLE" != true ]; then
        log_warning "Skipping sustained load test (requires ab)"
        return
    fi

    log_info "Running sustained load: ${CONCURRENCY} concurrent users, ~100 req/s target"
    log_info "This test runs for approximately 2 minutes..."

    # 12000 requests at ~100/s = 2 minutes
    local requests=12000

    ab -n $requests -c "$CONCURRENCY" -q "${BASE_URL}/health" 2>&1 | tee "$RESULTS_DIR/sustained-load.txt" | \
        grep -E "(Requests per second|Time per request|Failed requests|Percentage.*served|Complete requests)"

    echo ""

    local failed=$(grep "Failed requests" "$RESULTS_DIR/sustained-load.txt" | awk '{print $3}')
    local rps=$(grep "Requests per second" "$RESULTS_DIR/sustained-load.txt" | awk '{print $4}')

    if [ "$failed" = "0" ]; then
        log_success "Sustained load test completed with no failures"
        log_info "Achieved ${rps} requests/second"
    else
        log_error "Sustained load test had ${failed} failures"
    fi
}

test_resource_usage() {
    log_header "Test 7: Resource Usage Check"

    log_info "Checking container resource usage..."

    if ! command -v docker &> /dev/null; then
        log_warning "Docker not available, skipping resource check"
        return
    fi

    echo ""
    echo "Container Resource Usage:"
    echo "--------------------------"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>/dev/null | \
        grep -E "(NAME|quox)" || log_warning "Could not get container stats"

    echo ""

    # Check memory usage
    log_info "Evaluating memory usage against targets..."

    local auth_mem=$(docker stats --no-stream --format "{{.MemUsage}}" quox-auth 2>/dev/null | cut -d'/' -f1 | tr -d ' ')
    if [ -n "$auth_mem" ]; then
        log_info "Auth service memory: ${auth_mem}"
    fi

    local collector_mem=$(docker stats --no-stream --format "{{.MemUsage}}" quox-collector 2>/dev/null | cut -d'/' -f1 | tr -d ' ')
    if [ -n "$collector_mem" ]; then
        log_info "Collector memory: ${collector_mem}"
    fi
}

generate_report() {
    log_header "Load Test Report"

    local report_file="$RESULTS_DIR/report.md"

    cat > "$report_file" << EOF
# Quox Load Test Report

**Date:** $(date -Iseconds)
**Configuration:**
- Base URL: ${BASE_URL}
- Concurrency: ${CONCURRENCY}
- Requests per test: ${REQUESTS}

## Results Summary

EOF

    # Append any captured results
    if [ -f "$RESULTS_DIR/health-dashboard.txt" ]; then
        echo "### Dashboard Health Test" >> "$report_file"
        echo '```' >> "$report_file"
        grep -E "(Requests per second|Time per request|Failed requests)" "$RESULTS_DIR/health-dashboard.txt" >> "$report_file"
        echo '```' >> "$report_file"
        echo "" >> "$report_file"
    fi

    if [ -f "$RESULTS_DIR/sustained-load.txt" ]; then
        echo "### Sustained Load Test" >> "$report_file"
        echo '```' >> "$report_file"
        grep -E "(Requests per second|Time per request|Failed requests|Complete requests)" "$RESULTS_DIR/sustained-load.txt" >> "$report_file"
        echo '```' >> "$report_file"
        echo "" >> "$report_file"
    fi

    log_success "Report saved to: ${report_file}"
    echo ""
    echo "Full results directory: ${RESULTS_DIR}"
    echo ""
}

show_help() {
    cat << EOF
Quox Platform Load Test Script
==============================

Usage: $0 [OPTIONS]

Options:
  --health-only      Run only health endpoint tests
  --inbox-only       Run only inbox API tests
  --full             Run all tests including sustained load
  --quick            Run quick sanity tests only
  --report           Generate report from last run

  --concurrency N    Set concurrent connections (default: ${CONCURRENCY})
  --requests N       Set total requests per test (default: ${REQUESTS})
  --timeout N        Set request timeout in seconds (default: ${TIMEOUT})

  --base-url URL     Set dashboard base URL (default: ${BASE_URL})
  --auth-url URL     Set auth service URL (default: ${AUTH_URL})
  --collector-url URL Set collector URL (default: ${COLLECTOR_URL})

  --help             Show this help message

Examples:
  $0                          # Run all basic tests
  $0 --health-only            # Quick health check
  $0 --concurrency 50         # Test with 50 concurrent users
  $0 --full --concurrency 100 # Full test suite with 100 users

Requirements:
  - curl (required)
  - ab (Apache Bench) - install with: apt-get install apache2-utils
  - jq (optional) - install with: apt-get install jq
  - docker (optional) - for resource monitoring

EOF
}

# =============================================================================
# Main Execution
# =============================================================================

main() {
    # Parse arguments
    local run_health=true
    local run_inbox=true
    local run_sse=true
    local run_sustained=false
    local run_resources=true

    while [[ $# -gt 0 ]]; do
        case $1 in
            --health-only)
                run_inbox=false
                run_sse=false
                run_sustained=false
                run_resources=false
                shift
                ;;
            --inbox-only)
                run_health=false
                run_sse=false
                run_sustained=false
                run_resources=false
                shift
                ;;
            --full)
                run_sustained=true
                shift
                ;;
            --quick)
                run_inbox=false
                run_sse=false
                run_sustained=false
                run_resources=false
                shift
                ;;
            --concurrency)
                CONCURRENCY="$2"
                shift 2
                ;;
            --requests)
                REQUESTS="$2"
                shift 2
                ;;
            --timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            --base-url)
                BASE_URL="$2"
                shift 2
                ;;
            --auth-url)
                AUTH_URL="$2"
                shift 2
                ;;
            --collector-url)
                COLLECTOR_URL="$2"
                shift 2
                ;;
            --report)
                generate_report
                exit 0
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    log_header "Quox Platform Load Test"

    echo "Configuration:"
    echo "  Dashboard URL:  ${BASE_URL}"
    echo "  Auth URL:       ${AUTH_URL}"
    echo "  Collector URL:  ${COLLECTOR_URL}"
    echo "  Concurrency:    ${CONCURRENCY}"
    echo "  Requests/test:  ${REQUESTS}"
    echo "  Results dir:    ${RESULTS_DIR}"
    echo ""

    check_dependencies
    check_services

    # Run selected tests
    if [ "$run_health" = true ]; then
        test_health_endpoints
        test_health_latency
        test_concurrent_connections
    fi

    if [ "$run_inbox" = true ]; then
        test_inbox_api
    fi

    if [ "$run_sse" = true ]; then
        test_sse_connections
    fi

    if [ "$run_sustained" = true ]; then
        test_sustained_load
    fi

    if [ "$run_resources" = true ]; then
        test_resource_usage
    fi

    generate_report

    log_header "Load Test Complete"
    log_info "See ${RESULTS_DIR}/report.md for full results"
}

# Run main
main "$@"
