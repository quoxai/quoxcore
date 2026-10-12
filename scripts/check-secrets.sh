#!/usr/bin/env bash
# check-secrets.sh — Validates that required secrets are properly configured.
# Run at startup or as part of CI to catch misconfigured environments.
#
# Usage: ./scripts/check-secrets.sh [--env-file .env]
#
# Exit codes:
#   0 — All checks passed
#   1 — Critical issues found (will not boot safely)

set -euo pipefail

ENV_FILE="${1:-.env}"
ERRORS=0
WARNINGS=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

# Load .env if it exists
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC2046
    export $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs -d '\n' 2>/dev/null || true)
fi

echo "=== QuoxCORE Secret Validation ==="
echo ""

# --- MASTER_ENCRYPTION_KEY ---
if [[ -z "${MASTER_ENCRYPTION_KEY:-}" ]]; then
    red "[CRITICAL] MASTER_ENCRYPTION_KEY is not set"
    red "  Fix: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    ERRORS=$((ERRORS + 1))
elif [[ "$MASTER_ENCRYPTION_KEY" == CHANGE_ME* ]]; then
    red "[CRITICAL] MASTER_ENCRYPTION_KEY is still a placeholder"
    red "  Fix: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    ERRORS=$((ERRORS + 1))
else
    # Validate by CHARACTER length, not by decoding. A 32-byte key encodes to
    # ~43 base64 chars (44 with padding). The previous `base64 -d` check died
    # SILENTLY under `set -euo pipefail` when the key was base64url (the `-`/`_`,
    # no-padding form generate-secrets.sh produces): standard `base64 -d` rejects
    # base64url, the pipeline failed, and set -e aborted the whole script with no
    # message — blocking deploys on a perfectly valid key. Char-length avoids all
    # base64-vs-base64url + padding fragility.
    if [[ "${#MASTER_ENCRYPTION_KEY}" -lt 43 ]]; then
        red "[CRITICAL] MASTER_ENCRYPTION_KEY too short (${#MASTER_ENCRYPTION_KEY} chars, need >=43 for a 32-byte key)"
        ERRORS=$((ERRORS + 1))
    else
        green "[OK] MASTER_ENCRYPTION_KEY (${#MASTER_ENCRYPTION_KEY} chars)"
    fi
fi

# --- JWT_SECRET ---
if [[ -z "${JWT_SECRET:-}" ]]; then
    red "[CRITICAL] JWT_SECRET is not set"
    ERRORS=$((ERRORS + 1))
elif [[ "${#JWT_SECRET}" -lt 32 ]]; then
    red "[CRITICAL] JWT_SECRET too short (${#JWT_SECRET} chars, need 32+)"
    ERRORS=$((ERRORS + 1))
else
    green "[OK] JWT_SECRET (${#JWT_SECRET} chars)"
fi

# --- INTERNAL_SERVICE_KEY ---
if [[ -z "${INTERNAL_SERVICE_KEY:-}" ]]; then
    red "[CRITICAL] INTERNAL_SERVICE_KEY is not set"
    red "  Fix: openssl rand -hex 32"
    ERRORS=$((ERRORS + 1))
elif [[ "$INTERNAL_SERVICE_KEY" == CHANGE_ME* ]]; then
    red "[CRITICAL] INTERNAL_SERVICE_KEY is still a placeholder"
    ERRORS=$((ERRORS + 1))
else
    green "[OK] INTERNAL_SERVICE_KEY (${#INTERNAL_SERVICE_KEY} chars)"
fi

# --- WEBSITE_SERVICE_KEY ---
if [[ -z "${WEBSITE_SERVICE_KEY:-}" ]]; then
    yellow "[WARN] WEBSITE_SERVICE_KEY is not set (needed for ScreenCap)"
    WARNINGS=$((WARNINGS + 1))
elif [[ "$WEBSITE_SERVICE_KEY" == CHANGE_ME* ]]; then
    yellow "[WARN] WEBSITE_SERVICE_KEY is still a placeholder"
    WARNINGS=$((WARNINGS + 1))
else
    green "[OK] WEBSITE_SERVICE_KEY (${#WEBSITE_SERVICE_KEY} chars)"
fi

# --- Check for reused keys ---
if [[ -n "${INTERNAL_SERVICE_KEY:-}" && -n "${WEBSITE_SERVICE_KEY:-}" ]]; then
    if [[ "$INTERNAL_SERVICE_KEY" == "$WEBSITE_SERVICE_KEY" ]]; then
        red "[CRITICAL] INTERNAL_SERVICE_KEY and WEBSITE_SERVICE_KEY are the same value!"
        red "  This means compromising one key compromises both services."
        red "  Generate distinct keys: openssl rand -hex 32"
        ERRORS=$((ERRORS + 1))
    fi
fi

if [[ -n "${JWT_SECRET:-}" && -n "${MASTER_ENCRYPTION_KEY:-}" ]]; then
    if [[ "$JWT_SECRET" == "$MASTER_ENCRYPTION_KEY" ]]; then
        red "[CRITICAL] JWT_SECRET and MASTER_ENCRYPTION_KEY are the same — use independent keys"
        ERRORS=$((ERRORS + 1))
    fi
fi

# --- POSTGRES_PASSWORD ---
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
    red "[CRITICAL] POSTGRES_PASSWORD is not set"
    red "  Fix: openssl rand -hex 32"
    ERRORS=$((ERRORS + 1))
elif [[ "$POSTGRES_PASSWORD" == CHANGE_ME* ]]; then
    red "[CRITICAL] POSTGRES_PASSWORD is still a placeholder"
    ERRORS=$((ERRORS + 1))
else
    green "[OK] POSTGRES_PASSWORD (${#POSTGRES_PASSWORD} chars)"
fi

# --- QDRANT_API_KEY ---
if [[ -z "${QDRANT_API_KEY:-}" ]]; then
    red "[CRITICAL] QDRANT_API_KEY is not set"
    red "  Fix: openssl rand -hex 32"
    ERRORS=$((ERRORS + 1))
elif [[ "$QDRANT_API_KEY" == CHANGE_ME* ]]; then
    red "[CRITICAL] QDRANT_API_KEY is still a placeholder"
    ERRORS=$((ERRORS + 1))
else
    green "[OK] QDRANT_API_KEY (${#QDRANT_API_KEY} chars)"
fi

# --- Dev/test flags must not be set in production (unless explicitly allowed) ---
ALLOW_TEST_FLAGS_SET=false
if [[ "${ALLOW_TEST_FLAGS:-}" == "true" ]]; then
    ALLOW_TEST_FLAGS_SET=true
fi

for flag in TEST_LLM_STUB SKIP_AUTH MOCK_LLM BYPASS_RATE_LIMIT; do
    value="${!flag:-}"
    if [[ -n "$value" ]]; then
        if [[ "$ALLOW_TEST_FLAGS_SET" == "true" ]]; then
            yellow "[WARN] ${flag} is set (allowed — ALLOW_TEST_FLAGS=true)"
            WARNINGS=$((WARNINGS + 1))
        else
            red "[CRITICAL] ${flag} is set to a non-empty value — this is a dev/test flag and must not be enabled in production"
            red "  Fix: unset ${flag} (or set ALLOW_TEST_FLAGS=true if you really mean it)"
            ERRORS=$((ERRORS + 1))
        fi
    fi
done

# --- Summary ---
echo ""
if [[ "$ERRORS" -gt 0 ]]; then
    red "=== FAILED: $ERRORS critical issue(s), $WARNINGS warning(s) ==="
    exit 1
elif [[ "$WARNINGS" -gt 0 ]]; then
    yellow "=== PASSED with $WARNINGS warning(s) ==="
    exit 0
else
    green "=== ALL CHECKS PASSED ==="
    exit 0
fi
