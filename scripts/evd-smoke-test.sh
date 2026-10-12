#!/bin/bash
# EVD stream smoke tests — live-container verification of the four phases.
# Run after a collector deploy to confirm end-to-end behavior works.
#
# Usage: bash scripts/evd-smoke-test.sh
# Exit code: 0 = all pass, 1 = any failure

set +e  # don't exit on individual test failure — collect them all

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

PASS=0
FAIL=0
FAILURES=()

pass() { echo -e "${GREEN}✓${RESET} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}✗${RESET} $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
note() { echo -e "${YELLOW}•${RESET} $1"; }

SESSION_ID="EVD_SMOKE_$(date +%s)"
SERVICE_KEY="${INTERNAL_SERVICE_KEY:-}"
COLLECTOR_URL="${COLLECTOR_URL:-http://localhost:9848}"

if [ -z "$SERVICE_KEY" ]; then
  SERVICE_KEY=$(docker exec quox-collector env 2>/dev/null | grep '^INTERNAL_SERVICE_KEY=' | cut -d= -f2)
fi

if [ -z "$SERVICE_KEY" ]; then
  echo "ERROR: INTERNAL_SERVICE_KEY not set and not available in container env"
  exit 2
fi

echo "== EVD Smoke Tests =="
echo "session_id: $SESSION_ID"
echo

# ─── EVD-1c: priority column populated ──────────────────────────────────
note "[EVD-1c] Envelopes written since priority migration"
LAST_10=$(docker exec quox-collector sqlite3 /var/lib/quox/aee.db \
  "SELECT COUNT(*) FROM envelopes WHERE ts > datetime('now', '-30 minutes')")
NO_PRIORITY=$(docker exec quox-collector sqlite3 /var/lib/quox/aee.db \
  "SELECT COUNT(*) FROM envelopes WHERE ts > datetime('now', '-30 minutes') AND priority IS NULL")
if [ "$NO_PRIORITY" = "0" ]; then
  pass "EVD-1c: $LAST_10 recent envelopes, 0 with NULL priority"
else
  fail "EVD-1c: $NO_PRIORITY recent envelopes have NULL priority"
fi

# ─── Trigger a chat to generate events ──────────────────────────────────
note "Triggering test chat ($SESSION_ID)"
CHAT_BODY=$(curl -sf -X POST "$COLLECTOR_URL/chat/claude" \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: $SERVICE_KEY" \
  -d "{\"prompt\":\"just say hello\",\"selected_agent\":\"quox\",\"session_id\":\"$SESSION_ID\",\"org_id\":\"__default__\",\"user_id\":\"evd_smoke\"}")
CHAT_OK=$?
if [ $CHAT_OK -ne 0 ]; then
  fail "chat endpoint rejected request — smoke tests cannot proceed"
  echo "Summary: $PASS passed, $FAIL failed"
  exit 1
fi
SUCCESS=$(echo "$CHAT_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))" 2>/dev/null)
if [ "$SUCCESS" = "True" ]; then
  pass "chat request completed successfully"
else
  fail "chat request success=$SUCCESS"
fi

# Find the actual VOLT run_id for this session
VOLT_RUN_ID=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
  "SELECT run_id FROM volt_runs WHERE corr = '$SESSION_ID' ORDER BY started_at DESC LIMIT 1")
if [ -n "$VOLT_RUN_ID" ]; then
  pass "VOLT run created: $VOLT_RUN_ID"
else
  fail "no VOLT run found for session $SESSION_ID"
fi

# ─── EVD-3: volt_content populated with hashes ──────────────────────────
if [ -n "$VOLT_RUN_ID" ]; then
  note "[EVD-3] Checking volt_content rows for this run"
  CONTENT_ROWS=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
    "SELECT COUNT(*) FROM volt_content WHERE run_id = '$VOLT_RUN_ID'")
  if [ "$CONTENT_ROWS" -gt "0" ]; then
    pass "EVD-3: $CONTENT_ROWS volt_content row(s) for run"
  else
    fail "EVD-3: no volt_content rows persisted for run"
  fi

  # Verify content is hashed (not plaintext unless capture is on)
  CONTENT_SAMPLE=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
    "SELECT content FROM volt_content WHERE run_id = '$VOLT_RUN_ID' LIMIT 1")
  if echo "$CONTENT_SAMPLE" | grep -qE '"system_prompt_hash":"[0-9a-f]{64}"'; then
    pass "EVD-3: system_prompt_hash field present and valid SHA-256"
  else
    fail "EVD-3: content row missing system_prompt_hash or malformed"
  fi
fi

# ─── EVD-4: auto-bundle created ─────────────────────────────────────────
if [ -n "$VOLT_RUN_ID" ]; then
  note "[EVD-4] Checking volt_bundles for auto-generated bundle"
  BUNDLE_ID=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
    "SELECT bundle_id FROM volt_bundles WHERE run_id = '$VOLT_RUN_ID' LIMIT 1")
  if [ -n "$BUNDLE_ID" ]; then
    pass "EVD-4: auto-bundle created: $BUNDLE_ID"
  else
    fail "EVD-4: no bundle auto-generated for completed run"
  fi

  # ─── EVD-2: signature uses persistent key ──────────────────────────────
  if [ -n "$BUNDLE_ID" ]; then
    note "[EVD-2] Checking bundle signature uses persistent WARD key"
    SIG_KEY_ID=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
      "SELECT json_extract(data, '\$.signature.key_id') FROM volt_bundles WHERE bundle_id = '$BUNDLE_ID'")
    SIG_TYPE=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
      "SELECT json_extract(data, '\$.signature.sig_type') FROM volt_bundles WHERE bundle_id = '$BUNDLE_ID'")
    if [ "$SIG_TYPE" = "ed25519" ]; then
      pass "EVD-2: signature type is ed25519"
    else
      fail "EVD-2: unexpected signature type: $SIG_TYPE"
    fi
    if echo "$SIG_KEY_ID" | grep -qE '^[0-9a-f]{16}$'; then
      pass "EVD-2: key_id is stable 16-char hex ($SIG_KEY_ID) — persistent WARD key"
    elif echo "$SIG_KEY_ID" | grep -q 'ephemeral'; then
      fail "EVD-2: key_id is ephemeral — WARD keypair not loaded"
    else
      fail "EVD-2: unexpected key_id format: $SIG_KEY_ID"
    fi
    SIG_WARNING=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
      "SELECT json_extract(data, '\$.signature.warning') FROM volt_bundles WHERE bundle_id = '$BUNDLE_ID'")
    if [ "$SIG_WARNING" = "" ] || [ "$SIG_WARNING" = "NULL" ] || [ "$SIG_WARNING" = "" ]; then
      pass "EVD-2: no ephemeral_key_not_verifiable warning (persistent path active)"
    else
      fail "EVD-2: signature warning present: $SIG_WARNING"
    fi
  fi
fi

# ─── EVD-1a: SIGTERM graceful shutdown already in effect ────────────────
# Count stale "active" runs started more than 2 minutes ago. After EVD-1a,
# the only way to get stale active runs is for the collector to crash
# uncleanly. A deliberate restart should flush them.
note "[EVD-1a] Stale active runs (should be stable post-fix)"
STALE_ACTIVE=$(docker exec quox-collector sqlite3 /var/lib/quox/volt.db \
  "SELECT COUNT(*) FROM volt_runs WHERE status = 'active' AND stored_at < datetime('now', '-2 minutes')")
note "EVD-1a: $STALE_ACTIVE runs in 'active' status older than 2 minutes (legacy + any post-deploy)"

# ─── Summary ──────────────────────────────────────────────────────────────
echo
echo "== Results =="
echo -e "${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
if [ $FAIL -gt 0 ]; then
  echo
  echo "Failures:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
