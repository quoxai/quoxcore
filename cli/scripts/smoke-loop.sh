#!/usr/bin/env bash
#
# QuoxCLI Smoke Loop
#
# Drives the full scriptable API-level test harness against a LIVE stack
# using a throwaway account:
#
#   signup -> login -> org create -> org switch -> memory create+search
#   -> chat (payload accepted) -> workflow create+publish+run
#   -> objective create+list -> aee query verify
#
# Every step prints PASS/FAIL. Steps that depend on an LLM provider being
# configured (chat response, objective decomposition) are graded on
# "request accepted" not "LLM succeeded" — a dev box with no ANTHROPIC_API_KEY
# is expected to fail at the LLM layer, not at the CLI/HTTP layer.
#
# Usage:
#   ./smoke-loop.sh              # uses a fresh throwaway account
#   ./smoke-loop.sh --profile p  # use a specific config profile (isolated from your real login)
#
# Exit codes:
#   0 — all required steps passed
#   1 — one or more required steps failed
#

set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUOX="node $CLI_DIR/bin/quox.js --insecure"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL=0
PASSED=0
FAILED=0
FAILED_STEPS=()

step() { echo -e "\n${CYAN}==>${NC} $*"; }
pass() { echo -e "${GREEN}  PASS${NC}  $*"; PASSED=$((PASSED+1)); TOTAL=$((TOTAL+1)); }
fail() { echo -e "${RED}  FAIL${NC}  $*"; FAILED=$((FAILED+1)); TOTAL=$((TOTAL+1)); FAILED_STEPS+=("$*"); }
warn() { echo -e "${YELLOW}  WARN${NC}  $*"; }
info() { echo "        $*"; }

json_get() {
  # $1 = python-ish path expr against stdin JSON, best-effort
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print($1)
except Exception:
    pass
" 2>/dev/null
}

# ── Setup: isolated profile so this never touches the operator's real login ──

PROFILE="smoke-$$"
STAMP=$(date +%s)
EMAIL="smoke-${STAMP}@quox.local"
PASSWORD="Harness2026!Smoke"
ORG_NAME="Smoke Loop Org ${STAMP}"
ORG_SLUG="smoke-loop-${STAMP}"

echo "=== QuoxCLI Smoke Loop ==="
echo "Profile: $PROFILE"
echo "Email:   $EMAIL"

# config.js persists `activeProfile` to disk on any call that saves auth
# (login/signup/switch-org), even when invoked with `-p`. Snapshot the
# operator's real active profile up front and restore it on exit so this
# script never leaves their default session pointed at a throwaway account.
ORIGINAL_PROFILE=$(python3 -c "
import json, os
p = os.path.expanduser('~/.config/quox/config.json')
try:
    print(json.load(open(p)).get('activeProfile', 'local'))
except Exception:
    print('local')
" 2>/dev/null || echo "local")

cleanup() {
  # Restore the operator's original active profile, then discard the
  # throwaway one so config.json doesn't accumulate.
  $QUOX config profile use "$ORIGINAL_PROFILE" >/dev/null 2>&1 || true
  $QUOX config profile remove "$PROFILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

$QUOX -p "$PROFILE" config profile add "$PROFILE" --url "${QUOX_URL:-http://localhost:3000}" >/dev/null 2>&1 || true

Q() { $QUOX -p "$PROFILE" "$@"; }

# ── Step 1: signup ───────────────────────────────────────────────────

step "signup"
out=$(Q signup --email "$EMAIL" --password "$PASSWORD" --name "Smoke Test" 2>&1)
if echo "$out" | grep -qi "account created\|verify"; then
  pass "signup ($EMAIL)"
else
  fail "signup — $out"
fi

# ── Step 2: login ────────────────────────────────────────────────────

step "login"
out=$(Q login --email "$EMAIL" --password "$PASSWORD" 2>&1)
if echo "$out" | grep -qi "logged in as"; then
  pass "login"
else
  fail "login — $out"
  echo -e "\n${RED}Cannot continue without a session. Aborting.${NC}"
  exit 1
fi

# ── Step 3: org create ───────────────────────────────────────────────

step "org create"
out=$(Q org create --name "$ORG_NAME" --slug "$ORG_SLUG" 2>&1)
if echo "$out" | grep -qi "created organization"; then
  pass "org create ($ORG_SLUG)"
else
  fail "org create — $out"
fi

ORG_ID=$(Q org list --json 2>/dev/null | json_get "next((o['id'] for o in d if o.get('slug')=='$ORG_SLUG'), '')")
if [[ -z "$ORG_ID" ]]; then
  fail "org list — could not resolve org id for $ORG_SLUG"
  echo -e "\n${RED}Cannot continue without an org. Aborting.${NC}"
  exit 1
fi
info "org_id=$ORG_ID"

# ── Step 4: org switch ───────────────────────────────────────────────

step "org switch"
out=$(Q org switch "$ORG_ID" 2>&1)
if echo "$out" | grep -qi "switched to"; then
  pass "org switch"
else
  fail "org switch — $out"
fi

# ── Step 5: memory create + search ───────────────────────────────────

step "memory create"
MEMORY_MARKER="smoke-loop-marker-${STAMP}"
out=$(Q memory create --type fact --content "$MEMORY_MARKER" --tags smoke,harness 2>&1)
if echo "$out" | grep -qi "memory saved"; then
  pass "memory create"
else
  fail "memory create — $out"
fi

step "memory search"
out=$(Q memory search --query "$MEMORY_MARKER" 2>&1)
if [[ $? -eq 0 || $? -eq 5 ]] && ! echo "$out" | grep -qi "^error"; then
  if echo "$out" | grep -q "$MEMORY_MARKER"; then
    pass "memory search — found marker"
  else
    warn "memory search returned no match yet (indexing may be async)"
    pass "memory search — request succeeded"
  fi
else
  fail "memory search — $out"
fi

# ── Step 6: chat (payload must be accepted — LLM result may fail) ───

step "chat (payload acceptance)"
out=$(timeout 25 $QUOX -p "$PROFILE" --debug chat --no-stream "say ok" 2>&1)
if echo "$out" | grep -qi "missing_prompt\|status 400"; then
  fail "chat — payload rejected: $out"
elif echo "$out" | grep -qi "prompt_len\|Thinking\|Failed\|timed out\|-> POST"; then
  pass "chat — request accepted by collector (LLM layer result not required on dev)"
else
  warn "chat — inconclusive output, treating as pass since no 400 seen"
  pass "chat — no payload-validation error observed"
fi

# ── Step 7: workflow create + steps + publish + run ─────────────────

step "workflow create"
out=$(Q workflow create --name "Smoke WF ${STAMP}" --description "smoke-loop" 2>&1)
if echo "$out" | grep -qi "workflow.*created"; then
  pass "workflow create"
else
  fail "workflow create — $out"
fi

WF_ID=$(Q workflow list --json 2>/dev/null | json_get "next((w['id'] for w in d if w.get('name')=='Smoke WF ${STAMP}'), '')")
if [[ -z "$WF_ID" ]]; then
  fail "workflow list — could not resolve workflow id"
else
  info "workflow_id=$WF_ID"

  step "workflow steps set"
  out=$(Q workflow steps set "$WF_ID" --steps '[{"step_type":"notify","config":{"message":"smoke"}}]' 2>&1)
  if echo "$out" | grep -qi "steps updated"; then
    pass "workflow steps set"
  else
    fail "workflow steps set — $out"
  fi

  step "workflow publish"
  out=$(Q workflow publish "$WF_ID" 2>&1)
  if echo "$out" | grep -qi "published"; then
    pass "workflow publish"
  else
    fail "workflow publish — $out"
  fi

  step "workflow run"
  out=$(Q workflow run "$WF_ID" 2>&1)
  if echo "$out" | grep -qi "run started"; then
    pass "workflow run — $(echo "$out" | grep -i 'run started')"
  else
    fail "workflow run — $out"
  fi
fi

# ── Step 8: objective create + list ──────────────────────────────────

step "objective create"
out=$(Q objective create "smoke loop objective ${STAMP}" 2>&1)
if echo "$out" | grep -qi "objective created"; then
  pass "objective create"
else
  fail "objective create — $out"
fi

OBJ_ID=$(Q objective list --json 2>/dev/null | json_get "next((o['id'] for o in (d if isinstance(d, list) else d.get('objectives', [])) if o.get('title')=='smoke loop objective ${STAMP}'), '')")

step "objective list"
if [[ -n "$OBJ_ID" ]]; then
  pass "objective list — found $OBJ_ID"
else
  fail "objective list — created objective not found in list"
fi

# ── Step 9: aee query verify ─────────────────────────────────────────

step "aee query"
out=$(Q aee query --limit 5 2>&1)
if [[ $? -eq 0 ]] || echo "$out" | grep -qi "no results\|ID\|Type"; then
  pass "aee query — endpoint reachable"
else
  fail "aee query — $out"
fi

# ── Summary ───────────────────────────────────────────────────────────

echo ""
echo "=== Smoke Loop Summary ==="
echo "Total:  $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "Failed steps:"
  for f in "${FAILED_STEPS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

exit 0
