#!/bin/bash
# Pre-commit hook: SETEC env-config guardrail (SETEC-S1, supersedes the
# VAULT-INTEG P13 services/-only ratchet).
#
# Runs `node scripts/setec-inventory.mjs --check`: every env read anywhere in
# the repo (process.env.X, ['X'], destructuring, import.meta.env, aliases)
# must be in services/shared/envRegistry.cjs, and every registry `surface`
# claim must be verifiable. Known gaps live in scripts/setec-baseline.json;
# only NEW gaps block.
#
# Fast path: only runs when staged files include js/cjs/mjs/jsx/ts/tsx source
# or the registry / baseline / surface files.
#
# Bypass: QUOX_ENV_SKIP=1 git commit ...  (loud warning, and every skip is
# appended to <git-common-dir>/setec-skips.log so skips are visible.)

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

REPO_ROOT=$(git rev-parse --show-toplevel)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ "${QUOX_ENV_SKIP:-}" = "1" ]; then
    GIT_COMMON=$(cd "$REPO_ROOT" && git rev-parse --git-common-dir)
    case "$GIT_COMMON" in /*) ;; *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;; esac
    WHO=$(git config user.email 2>/dev/null || whoami)
    FILES_ONE_LINE=$(echo "$STAGED_FILES" | tr '\n' ' ')
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) who=$WHO repo=$REPO_ROOT files=$FILES_ONE_LINE" >> "$GIT_COMMON/setec-skips.log"
    echo -e "${YELLOW}!!! [setec] QUOX_ENV_SKIP=1: env registry / surface check SKIPPED !!!${NC}"
    echo -e "${YELLOW}!!! This skip is recorded in $GIT_COMMON/setec-skips.log !!!${NC}"
    exit 0
fi

if ! echo "$STAGED_FILES" | grep -qE '\.(js|cjs|mjs|jsx|ts|tsx)$|setec-baseline\.json$|instanceSettingsSurface\.json$'; then
    exit 0
fi

if ! OUT=$(cd "$REPO_ROOT" && node scripts/setec-inventory.mjs --check 2>&1); then
    echo ""
    echo -e "${RED}=== SETEC ENV CHECK - COMMIT BLOCKED ===${NC}"
    echo "$OUT"
    echo ""
    echo "Rule: no env-only settings. Register the var in services/shared/envRegistry.cjs"
    echo "with a surface that really exists, then re-commit."
    echo "Emergency bypass (logged): QUOX_ENV_SKIP=1 git commit ..."
    exit 1
fi

echo -e "${GREEN}[setec] no new env-config gaps - OK${NC}"
exit 0
