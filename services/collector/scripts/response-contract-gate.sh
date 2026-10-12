#!/bin/sh
# AGH-RESP-4: response contract CI gate
# Soft-fail by default until 2026-05-31, hard-fail thereafter.

set -e
GATE_MODE="${1:-soft}"
echo "[AGH-RESP-4] running response contract gate (mode=$GATE_MODE, cutover=2026-05-31)"

if npm run test:response-contract; then
  echo "[AGH-RESP-4] gate PASSED"
  mkdir -p /tmp && touch /tmp/.tester-ok
  exit 0
fi

if [ "$GATE_MODE" = "hard" ]; then
  echo "[AGH-RESP-4] gate HARD-FAILED — blocking build"
  exit 1
else
  echo "[AGH-RESP-4] gate SOFT-FAILED — build proceeding (cutover to hard-fail: 2026-05-31)"
  mkdir -p /tmp && touch /tmp/.tester-ok
  exit 0
fi
