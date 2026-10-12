#!/bin/bash
# Pre-commit hook: Governance Claims Matrix freshness check
#
# Enforces the "no governance theater" rule from
# docs/GOVERNANCE_CLAIMS_MATRIX.md:
#
#   "No new governance UI surface, badge, metric, or report label ships
#    without a row in this matrix. Every claim names its enforcement path
#    and evidence source."
#
# Logic: if the commit modifies any file in a governance-surface path,
# require docs/GOVERNANCE_CLAIMS_MATRIX.md to also be in the diff.
#
# Bypass: commit with QUOX_MATRIX_SKIP=1 git commit ...
# or with `git commit --no-verify` (noisy, discouraged).

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

# Skip if explicitly opted out
if [ "${QUOX_MATRIX_SKIP:-}" = "1" ]; then
    echo -e "${YELLOW}[matrix] QUOX_MATRIX_SKIP=1 — governance matrix check skipped${NC}"
    exit 0
fi

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

# Paths that contain governance-surfacing UI. If any of these changes,
# the matrix should be updated.
# Patterns use simple grep -E regex against staged file paths.
GOVERNANCE_PATTERNS=(
    '^src/components/compliance/'
    '^src/pages/views/Compliance'
    '^src/pages/views/Volt'
    '^src/pages/views/Ward'
    '^src/pages/views/Certification'
    '^src/pages/views/AuditLog'
    '^src/pages/views/Policies'
    '^src/pages/views/Evidence'
    '^src/services/layers/'
    '^src/services/compliance/'
    '^services/collector/lib/aoclPipeline\.js'
    '^services/collector/lib/compliancePolicyEvaluator\.js'
    '^services/collector/lib/safetyPolicyEvaluator\.js'
    '^services/collector/lib/identityLayer\.js'
    '^services/collector/lib/responseVerifier\.js'
    '^src/hooks/useComplianceData'
    '^src/components/monitoring/AlertTimeline'
)

# Build one combined regex
COMBINED_PATTERN=$(IFS='|'; echo "${GOVERNANCE_PATTERNS[*]}")

GOVERNANCE_HITS=$(echo "$STAGED_FILES" | grep -E "$COMBINED_PATTERN" || true)

if [ -z "$GOVERNANCE_HITS" ]; then
    # No governance UI files touched — nothing to enforce
    exit 0
fi

# A governance surface changed. Is the matrix also in the diff?
JSON_FILE='docs/governance-claims.json'
MD_FILE='docs/GOVERNANCE_CLAIMS_MATRIX.md'
JSON_IN_DIFF=$(echo "$STAGED_FILES" | grep -F "$JSON_FILE" || true)
MD_IN_DIFF=$(echo "$STAGED_FILES" | grep -F "$MD_FILE" || true)

if [ -z "$JSON_IN_DIFF" ]; then
    # Governance surface touched but JSON wasn't updated — block
    echo ""
    echo -e "${RED}=== GOVERNANCE MATRIX CHECK — COMMIT BLOCKED ===${NC}"
    echo ""
    echo "The following governance-surfacing files changed:"
    echo ""
    echo "$GOVERNANCE_HITS" | sed 's/^/  - /'
    echo ""
    echo -e "${YELLOW}But docs/governance-claims.json was not updated.${NC}"
    echo ""
    echo "Rule: No governance UI, enforcement code, or evidence pipeline change"
    echo "ships without a corresponding claims matrix row update. Every claim"
    echo "must name its enforcement path and evidence source."
    echo ""
    echo "How to fix:"
    echo "  1. Edit docs/governance-claims.json (structured source of truth)"
    echo "  2. Add/update claim entries that your change affects"
    echo "  3. Regenerate markdown: node scripts/render-claims-matrix.cjs"
    echo "  4. Verify drift-free: node scripts/verify-claims-matrix.cjs"
    echo "  5. Stage both files and re-commit"
    echo ""
    echo "If this is genuinely unrelated to governance claims (e.g., typo fix,"
    echo "internal refactor with no user-visible claim change):"
    echo "  QUOX_MATRIX_SKIP=1 git commit ..."
    echo ""
    exit 1
fi

# JSON was updated. Run drift verifier against the staged version.
REPO_ROOT=$(git rev-parse --show-toplevel)
VERIFY_SCRIPT="$REPO_ROOT/scripts/verify-claims-matrix.cjs"
if [ -x "$VERIFY_SCRIPT" ]; then
    if ! node "$VERIFY_SCRIPT" > /tmp/matrix-verify.out 2>&1; then
        echo ""
        echo -e "${RED}=== GOVERNANCE MATRIX DRIFT DETECTED — COMMIT BLOCKED ===${NC}"
        echo ""
        cat /tmp/matrix-verify.out
        echo ""
        echo "Fix the drift (update backend_path or change status) before committing."
        echo "Bypass (discouraged): QUOX_MATRIX_SKIP=1 git commit ..."
        echo ""
        exit 1
    fi
fi

# Require markdown to be in sync with JSON
RENDER_SCRIPT="$REPO_ROOT/scripts/render-claims-matrix.cjs"
if [ -x "$RENDER_SCRIPT" ]; then
    if ! node "$RENDER_SCRIPT" --check > /tmp/matrix-check.out 2>&1; then
        echo ""
        echo -e "${RED}=== MATRIX MARKDOWN OUT OF SYNC — COMMIT BLOCKED ===${NC}"
        echo ""
        cat /tmp/matrix-check.out
        echo ""
        echo "The JSON was updated but the markdown was not regenerated."
        echo "Run: node scripts/render-claims-matrix.cjs"
        echo "Then stage GOVERNANCE_CLAIMS_MATRIX.md and re-commit."
        echo ""
        exit 1
    fi
fi

echo -e "${GREEN}[matrix] governance UI + JSON + drift verified + markdown in sync — OK${NC}"
exit 0
