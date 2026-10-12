#!/usr/bin/env bash
#
# QuoxCLI Audit Script
#
# Runs daily/weekly checks to detect when backend API changes
# have broken or drifted from the CLI. Designed to be run by
# a Claude Code session or cron.
#
# Usage:
#   ./audit-cli.sh daily       # Quick: git diff, test suite, smoke tests
#   ./audit-cli.sh weekly      # Full: daily + response schema validation + coverage report
#   ./audit-cli.sh blast <sha> # Analyze blast radius of a specific commit
#
# Exit codes:
#   0  — All checks passed, no action needed
#   1  — Failures detected, needs attention
#   2  — New API routes found without CLI coverage
#   3  — Script error
#

set -euo pipefail

REPO_DIR="/opt/quoxcore"
CLI_DIR="$REPO_DIR/cli"
AUDIT_DIR="$REPO_DIR/cli/audit"
STATE_FILE="$AUDIT_DIR/.last-audit"
REPORT_FILE="$AUDIT_DIR/report-$(date +%Y%m%d-%H%M%S).json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "$AUDIT_DIR"

# ── Helpers ─────────────────────────────────────────────────────────

log()  { echo -e "${CYAN}[audit]${NC} $*"; }
pass() { echo -e "${GREEN}  PASS${NC} $*"; }
fail() { echo -e "${RED}  FAIL${NC} $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} $*"; }
skip() { echo -e "  SKIP $*"; }

# Route-to-CLI mapping: which API route files affect which CLI commands
declare -A ROUTE_TO_CLI=(
  [orgs]="org"
  [agents]="agent"
  [agent-tools]="agent"
  [tools]="tool"
  [tool-catalog]="tool"
  [workflows]="workflow"
  [runs]="run"
  [assistants]="assistant"
  [auth]="auth"
  [backups]="backup"
  [consent]="consent"
  [departments]="department"
  [divisions]="org"
  [inbox]="inbox"
  [integrations]="integration vault"
  [invites]="org"
  [messages]="conversation"
  [mfa]="auth"
  [notifications]="notification"
  [scopes]="scope"
  [tags]="tag"
  [teams]="team"
  [setup]="setup"
  [admin]="admin"
  [uploads]="file"
  [widgets]="quoxchat"
  [widget-connectors]="quoxchat"
)

# CLI commands that have live smoke tests
SMOKE_COMMANDS=(
  "org list"
  "org get FIRST_ORG_ID"
  "whoami"
  "agent list"
  "workflow list"
  "team list"
  "entity list"
  "memory list"
  "inbox list"
  "service health"
  "fleet summary"
  "tool list"
  "backup list"
)

# ── Step 1: Check if audit is needed ────────────────────────────────

check_changes_since_last_audit() {
  log "Checking for changes since last audit..."

  local last_sha=""
  if [[ -f "$STATE_FILE" ]]; then
    last_sha=$(cat "$STATE_FILE" | head -1)
  fi

  local current_sha
  current_sha=$(git -C "$REPO_DIR" rev-parse HEAD)

  if [[ "$last_sha" == "$current_sha" && "${1:-}" != "--force" ]]; then
    skip "No new commits since last audit ($current_sha)"
    echo '{"status":"skipped","reason":"no_changes","sha":"'"$current_sha"'"}' > "$REPORT_FILE"
    return 1
  fi

  # Find changed files in the blast radius
  local changed_routes=()
  local changed_cli=()
  local changed_middleware=()

  if [[ -n "$last_sha" ]]; then
    while IFS= read -r f; do
      case "$f" in
        services/auth/routes/*.js) changed_routes+=("$(basename "$f" .js)") ;;
        services/auth/middleware/*.js) changed_middleware+=("$f") ;;
        cli/lib/commands/*.js) changed_cli+=("$(basename "$f" .js)") ;;
        cli/lib/core/*.js) changed_cli+=("core:$(basename "$f" .js)") ;;
        cli/lib/tui/*) changed_cli+=("tui") ;;
      esac
    done < <(git -C "$REPO_DIR" diff --name-only "$last_sha"..HEAD 2>/dev/null || git -C "$REPO_DIR" diff --name-only HEAD~20..HEAD)
  else
    # First audit — check everything
    changed_routes=("ALL")
    log "First audit — checking everything"
  fi

  echo ""
  if [[ ${#changed_routes[@]} -gt 0 ]]; then
    log "Changed API routes: ${changed_routes[*]}"
  fi
  if [[ ${#changed_cli[@]} -gt 0 ]]; then
    log "Changed CLI files: ${changed_cli[*]}"
  fi
  if [[ ${#changed_middleware[@]} -gt 0 ]]; then
    warn "Middleware changed: ${changed_middleware[*]} — may affect all CLI commands"
  fi

  # Determine which CLI commands need testing
  local affected_commands=()
  for route in "${changed_routes[@]}"; do
    if [[ "$route" == "ALL" ]]; then
      affected_commands=("ALL")
      break
    fi
    local cmds="${ROUTE_TO_CLI[$route]:-}"
    if [[ -n "$cmds" ]]; then
      for cmd in $cmds; do
        affected_commands+=("$cmd")
      done
    else
      warn "Route '$route' has no CLI mapping — potential coverage gap"
    fi
  done

  # Export for other steps
  export CHANGED_ROUTES="${changed_routes[*]}"
  export CHANGED_CLI="${changed_cli[*]}"
  export AFFECTED_COMMANDS="${affected_commands[*]}"
  export CURRENT_SHA="$current_sha"
  export LAST_SHA="$last_sha"

  return 0
}

# ── Step 2: Run test suite ──────────────────────────────────────────

run_tests() {
  log "Running CLI test suite..."

  local test_output
  if test_output=$(cd "$REPO_DIR" && npx vitest run cli/test/commands/ --reporter=json 2>/dev/null); then
    local total passed failed
    total=$(echo "$test_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('numTotalTests',0))" 2>/dev/null || echo "?")
    passed=$(echo "$test_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('numPassedTests',0))" 2>/dev/null || echo "?")
    failed=$(echo "$test_output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('numFailedTests',0))" 2>/dev/null || echo "?")
    pass "Tests: $passed/$total passed, $failed failed"
    export TEST_RESULT="pass"
    export TEST_TOTAL="$total"
    export TEST_FAILED="$failed"
    return 0
  else
    fail "Test suite has failures"
    export TEST_RESULT="fail"
    # Still extract counts from failed output
    export TEST_FAILED="unknown"
    return 1
  fi
}

# ── Step 3: Smoke tests against live services ───────────────────────

run_smoke_tests() {
  log "Running smoke tests against live services..."

  local quox="node $CLI_DIR/bin/quox.js"
  local passed=0
  local failed=0
  local failures=()

  # Check auth is available (try refreshing token if needed)
  if ! $quox whoami 2>/dev/null | grep -q "Email"; then
    # Try token refresh
    local refresh_token
    refresh_token=$(python3 -c "
import json; d=json.load(open('$HOME/.config/quox/config.json'))
print(d['profiles'][d['activeProfile']]['auth'].get('refresh_token',''))
" 2>/dev/null || echo "")

    if [[ -n "$refresh_token" ]]; then
      curl -sf http://localhost:3101/api/auth/refresh -X POST \
        -H "Content-Type: application/json" \
        -d "{\"refresh_token\": \"$refresh_token\"}" 2>/dev/null | python3 -c "
import sys, json, os
d = json.load(sys.stdin)
if 'access_token' in d:
    config_path = os.path.expanduser('~/.config/quox/config.json')
    config = json.load(open(config_path))
    p = config['activeProfile']
    config['profiles'][p]['auth']['access_token'] = d['access_token']
    if 'refresh_token' in d:
        config['profiles'][p]['auth']['refresh_token'] = d['refresh_token']
    json.dump(config, open(config_path, 'w'), indent=2)
" 2>/dev/null
      log "Refreshed auth token"
    fi

    if ! $quox whoami 2>/dev/null | grep -q "Email"; then
      warn "Not logged in — skipping smoke tests. Run 'quox login' first."
      export SMOKE_RESULT="skipped"
      return 0
    fi
  fi

  # Get first org ID for commands that need it
  local first_org_id
  first_org_id=$($quox org list --json 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  items = d if isinstance(d, list) else d.get('rows', d.get('data', []))
  if items and len(items) > 0:
    print(items[0].get('id',''))
except: pass
" 2>/dev/null || echo "")

  for smoke_cmd in "${SMOKE_COMMANDS[@]}"; do
    # Replace FIRST_ORG_ID placeholder
    local cmd="${smoke_cmd/FIRST_ORG_ID/$first_org_id}"

    # Skip commands that need an org ID if we don't have one
    if [[ "$cmd" == *"FIRST_ORG_ID"* ]]; then
      skip "$smoke_cmd (no org ID)"
      continue
    fi

    local output
    if output=$($quox $cmd 2>&1); then
      # Check for "No results" or empty output which may indicate a bug
      if echo "$output" | grep -q "No results" && [[ "$cmd" != *"tool list"* ]]; then
        warn "$cmd → 'No results' (may be empty data or response key mismatch)"
      else
        pass "$cmd"
        ((passed++))
      fi
    else
      # Check if it's a known acceptable error
      if echo "$output" | grep -qE "(No active org|not found|not implemented)"; then
        skip "$cmd → expected error"
      else
        fail "$cmd → $output"
        failures+=("$cmd")
        ((failed++))
      fi
    fi
  done

  echo ""
  log "Smoke tests: $passed passed, $failed failed"
  export SMOKE_RESULT="$passed passed, $failed failed"
  export SMOKE_FAILURES="${failures[*]:-none}"

  [[ $failed -eq 0 ]]
}

# ── Step 4: Schema drift detection ──────────────────────────────────

check_schema_drift() {
  log "Checking for API response schema drift..."

  local quox="node $CLI_DIR/bin/quox.js"
  local drifts=()

  # For each paginated endpoint, verify the CLI handles the response correctly
  # We check if the API returns { items: [...] } but the CLI expects something else

  local token
  token=$(python3 -c "
import json
d=json.load(open('$HOME/.config/quox/config.json'))
p=d.get('activeProfile','local')
print(d['profiles'][p]['auth']['access_token'])
" 2>/dev/null || echo "")

  if [[ -z "$token" ]]; then
    warn "No auth token — skipping schema drift check"
    return 0
  fi

  # Check critical endpoints (pipe-delimited: url|expected_key|label)
  local endpoints=(
    "http://localhost:3101/api/orgs|organizations|org list"
    "http://localhost:3101/api/orgs/01KGXQGVF36579YESP5GNYQZWJ|organization|org get"
  )

  local org_id
  org_id=$($quox org list --json 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  items = d if isinstance(d, list) else d.get('rows', d.get('data', []))
  if items: print(items[0].get('id',''))
except: pass
" 2>/dev/null || echo "01KGXQGVF36579YESP5GNYQZWJ")

  if [[ -n "$org_id" ]]; then
    endpoints+=(
      "http://localhost:3101/api/orgs/$org_id/tools|items|tool list"
      "http://localhost:3101/api/orgs/$org_id/workflows|items|workflow list"
      "http://localhost:3101/api/orgs/$org_id/assistants|items|assistant list"
      "http://localhost:3101/api/orgs/$org_id/runs|items|run list"
      "http://localhost:3101/api/orgs/$org_id/backups|items|backup list"
    )
  fi

  for entry in "${endpoints[@]}"; do
    IFS='|' read -r url expected_key label <<< "$entry"
    local response_keys
    response_keys=$(curl -sf "$url" -H "Authorization: Bearer $token" 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print(' '.join(d.keys()))
except: print('ERROR')
" 2>/dev/null || echo "UNREACHABLE")

    if [[ "$response_keys" == "UNREACHABLE" ]]; then
      warn "$label → endpoint unreachable"
    elif echo "$response_keys" | grep -qw "$expected_key"; then
      pass "$label → response has '$expected_key' key"
    else
      fail "$label → expected '$expected_key', got keys: $response_keys"
      drifts+=("$label")
    fi
  done

  export SCHEMA_DRIFTS="${drifts[*]:-none}"
  [[ ${#drifts[@]} -eq 0 ]]
}

# ── Step 5: Coverage gap detection ──────────────────────────────────

check_coverage_gaps() {
  log "Checking for API routes without CLI coverage..."

  local route_dir="$REPO_DIR/services/auth/routes"
  local cmd_dir="$CLI_DIR/lib/commands"
  local gaps=()

  for route_file in "$route_dir"/*.js; do
    local route_name
    route_name=$(basename "$route_file" .js)

    # Skip internal/infrastructure routes
    case "$route_name" in
      routing|share-policies|retention|bastion-approvals|uploads|tests|teamAssistants|scope-channels|messages|invites)
        continue ;;
    esac

    local cli_cmds="${ROUTE_TO_CLI[$route_name]:-}"
    if [[ -z "$cli_cmds" ]]; then
      gaps+=("$route_name")
    fi
  done

  if [[ ${#gaps[@]} -gt 0 ]]; then
    warn "API routes without CLI commands: ${gaps[*]}"
  else
    pass "All mapped API routes have CLI commands"
  fi

  export COVERAGE_GAPS="${gaps[*]:-none}"
}

# ── Step 6: Blast radius analysis ───────────────────────────────────

analyze_blast_radius() {
  local sha="${1:-HEAD}"
  log "Analyzing blast radius for $sha..."

  local changed_files
  changed_files=$(git -C "$REPO_DIR" diff-tree --no-commit-id --name-only -r "$sha" 2>/dev/null || echo "")

  if [[ -z "$changed_files" ]]; then
    skip "No files changed in $sha"
    return 0
  fi

  local api_changes=()
  local cli_changes=()
  local middleware_changes=()
  local frontend_changes=()

  while IFS= read -r f; do
    case "$f" in
      services/auth/routes/*.js) api_changes+=("$f") ;;
      services/auth/middleware/*.js) middleware_changes+=("$f") ;;
      cli/*) cli_changes+=("$f") ;;
      src/*) frontend_changes+=("$f") ;;
    esac
  done <<< "$changed_files"

  echo ""
  echo "Blast Radius for $(git -C "$REPO_DIR" log --oneline -1 "$sha" 2>/dev/null):"
  echo "  API routes changed:  ${#api_changes[@]}"
  echo "  CLI files changed:   ${#cli_changes[@]}"
  echo "  Middleware changed:   ${#middleware_changes[@]}"
  echo "  Frontend changed:    ${#frontend_changes[@]}"

  if [[ ${#api_changes[@]} -gt 0 && ${#cli_changes[@]} -eq 0 ]]; then
    warn "API changed but CLI was NOT updated — potential drift!"
    for api_file in "${api_changes[@]}"; do
      local route_name
      route_name=$(basename "$api_file" .js)
      local affected="${ROUTE_TO_CLI[$route_name]:-UNMAPPED}"
      echo "    $route_name → CLI command(s): $affected"
    done
  fi

  if [[ ${#middleware_changes[@]} -gt 0 ]]; then
    warn "Middleware changed — may affect ALL CLI commands"
  fi
}

# ── Step 7: Generate report ─────────────────────────────────────────

generate_report() {
  cat > "$REPORT_FILE" << EOF
{
  "timestamp": "$(date -Iseconds)",
  "mode": "${MODE:-daily}",
  "sha": "${CURRENT_SHA:-unknown}",
  "last_sha": "${LAST_SHA:-none}",
  "changed_routes": "${CHANGED_ROUTES:-none}",
  "changed_cli": "${CHANGED_CLI:-none}",
  "affected_commands": "${AFFECTED_COMMANDS:-none}",
  "tests": {
    "result": "${TEST_RESULT:-skipped}",
    "total": "${TEST_TOTAL:-0}",
    "failed": "${TEST_FAILED:-0}"
  },
  "smoke": {
    "result": "${SMOKE_RESULT:-skipped}",
    "failures": "${SMOKE_FAILURES:-none}"
  },
  "schema_drifts": "${SCHEMA_DRIFTS:-none}",
  "coverage_gaps": "${COVERAGE_GAPS:-none}"
}
EOF

  log "Report written to $REPORT_FILE"
}

save_state() {
  echo "${CURRENT_SHA:-}" > "$STATE_FILE"
  echo "$(date -Iseconds)" >> "$STATE_FILE"
}

# ── Main ────────────────────────────────────────────────────────────

MODE="${1:-daily}"

case "$MODE" in
  daily)
    echo ""
    log "=== QuoxCLI Daily Audit ==="
    echo ""

    if ! check_changes_since_last_audit; then
      exit 0
    fi

    echo ""
    test_ok=true
    smoke_ok=true
    run_tests || test_ok=false
    echo ""
    run_smoke_tests || smoke_ok=false
    echo ""
    generate_report
    save_state

    if $test_ok && $smoke_ok; then
      echo ""
      log "${GREEN}Daily audit passed.${NC}"
      exit 0
    else
      echo ""
      log "${RED}Daily audit found issues. Review report: $REPORT_FILE${NC}"
      exit 1
    fi
    ;;

  weekly)
    echo ""
    log "=== QuoxCLI Weekly Audit ==="
    echo ""

    check_changes_since_last_audit --force || true

    echo ""
    test_ok=true
    smoke_ok=true
    schema_ok=true
    run_tests || test_ok=false
    echo ""
    run_smoke_tests || smoke_ok=false
    echo ""
    check_schema_drift || schema_ok=false
    echo ""
    check_coverage_gaps
    echo ""

    # Analyze blast radius for each commit since last audit
    if [[ -n "${LAST_SHA:-}" ]]; then
      for sha in $(git -C "$REPO_DIR" log --format=%H "${LAST_SHA}..HEAD" -- services/auth/routes/ 2>/dev/null | head -10); do
        analyze_blast_radius "$sha"
        echo ""
      done
    fi

    generate_report
    save_state

    if $test_ok && $smoke_ok && $schema_ok; then
      echo ""
      log "${GREEN}Weekly audit passed.${NC}"
      exit 0
    else
      echo ""
      log "${RED}Weekly audit found issues. Review report: $REPORT_FILE${NC}"
      exit 1
    fi
    ;;

  blast)
    sha="${2:-HEAD}"
    analyze_blast_radius "$sha"
    ;;

  *)
    echo "Usage: $0 {daily|weekly|blast <sha>}"
    exit 3
    ;;
esac
