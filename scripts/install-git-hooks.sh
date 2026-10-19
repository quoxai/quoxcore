#!/bin/bash
# Install Quox git hooks into .git/hooks/
#
# Installs a composite pre-commit hook that runs:
#   1. Secrets check (blocks hardcoded API keys, .env files, private keys)
#   2. Governance Claims Matrix freshness check (blocks governance UI changes
#      that don't update the matrix)
#   3. Env-config registry ratchet (VAULT-INTEG P13 — blocks a new
#      process.env read under services/ that isn't registered)
#
# Usage: scripts/install-git-hooks.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Hooks live in the COMMON .git dir, shared across every worktree of this
# repo — not necessarily "$REPO_ROOT/.git" (a worktree's ".git" is a file
# pointing at the common dir, not a directory). `--git-common-dir` resolves
# correctly from both a normal checkout and any worktree.
GIT_COMMON_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -z "$GIT_COMMON_DIR" ]; then
    echo "Error: not inside a git repo (git rev-parse --git-common-dir failed) at $REPO_ROOT"
    exit 1
fi
case "$GIT_COMMON_DIR" in
    /*) : ;;
    *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
esac
HOOK_DIR="$GIT_COMMON_DIR/hooks"

if [ ! -d "$HOOK_DIR" ]; then
    echo "Error: $HOOK_DIR not found — are you inside a git repo?"
    exit 1
fi

cat > "$HOOK_DIR/pre-commit" <<'EOF'
#!/bin/bash
# Quox pre-commit hook — installed by scripts/install-git-hooks.sh
# Edits here will be overwritten. To change behavior, edit the scripts/
# pre-commit-*.sh files and re-run the installer.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)

# 1. Secrets check
SECRETS="$REPO_ROOT/scripts/pre-commit-secrets-check.sh"
if [ -x "$SECRETS" ]; then
    "$SECRETS" || exit $?
fi

# 2. Governance Claims Matrix freshness
MATRIX="$REPO_ROOT/scripts/pre-commit-matrix-check.sh"
if [ -x "$MATRIX" ]; then
    "$MATRIX" || exit $?
fi

# 3. Env-config registry ratchet (VAULT-INTEG P13)
ENV_CHECK="$REPO_ROOT/scripts/pre-commit-env-check.sh"
if [ -x "$ENV_CHECK" ]; then
    "$ENV_CHECK" || exit $?
fi

exit 0
EOF

chmod +x "$HOOK_DIR/pre-commit"

cat > "$HOOK_DIR/commit-msg" <<'HOOK'
#!/bin/bash
# Quox commit-msg hook (installed by scripts/install-git-hooks.sh; edits here are overwritten).
# LOOSEN-GUARD: a commit that makes a test or proof case easier to pass is refused unless its message
# carries `Loosening-Attestation: <signed attestation>` from an item a HUMAN approved with a step-up PIN.
# There is deliberately no skip variable. quox-land and CI run the same guard over the pushed range.
REPO_ROOT=$(git rev-parse --show-toplevel)
GIT_DIR=$(git rev-parse --git-dir)
# The judge is HEAD's committed guard, not the working copy being committed.
GUARD="$(mktemp "${TMPDIR:-/tmp}/loosen-guard.XXXXXX.mjs")"; trap 'rm -f "$GUARD"' EXIT
git show HEAD:scripts/guards/check-test-loosening.mjs > "$GUARD" 2>/dev/null || exit 0   # a branch older than the guard
[ -f "$GIT_DIR/MERGE_HEAD" ] && exit 0    # merges: quox-land and CI judge the whole range
(cd "$REPO_ROOT" && node "$GUARD" --staged --strict --msg-file "$1"); code=$?
[ "$code" -eq 3 ] && exit 1
[ "$code" -ne 0 ] && echo "LOOSEN-GUARD: guard error (exit $code), commit allowed; quox-land and CI still check the range" >&2
exit 0
HOOK

chmod +x "$HOOK_DIR/commit-msg"

echo "Installed pre-commit hook at $HOOK_DIR/pre-commit"
echo "  → runs scripts/pre-commit-secrets-check.sh"
echo "  → runs scripts/pre-commit-matrix-check.sh"
echo "  → runs scripts/pre-commit-env-check.sh"
echo "Installed commit-msg hook at $HOOK_DIR/commit-msg"
echo "  → runs scripts/guards/check-test-loosening.mjs --staged (no loosening without a human approval)"
echo ""
echo "To bypass the matrix check on a commit: QUOX_MATRIX_SKIP=1 git commit ..."
echo "To bypass the env registry check on a commit: QUOX_ENV_SKIP=1 git commit ..."
