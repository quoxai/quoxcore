#!/bin/bash
# Pre-commit hook to detect accidental secret commits
# Install: cp scripts/pre-commit-secrets-check.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# This script checks staged files for:
# - Hardcoded secrets (high entropy strings after known secret keys)
# - .env files (should never be committed)
# - Private keys and certificates

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo "Running pre-commit secrets check..."

ERRORS=0
WARNINGS=0

# Get list of staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    echo -e "${GREEN}No staged files to check.${NC}"
    exit 0
fi

# Check for .env files (should never be committed)
ENV_FILES=$(echo "$STAGED_FILES" | grep -E '\.env$|\.env\.' | grep -v '\.example' || true)
if [ -n "$ENV_FILES" ]; then
    echo -e "${RED}ERROR: Attempting to commit .env file(s):${NC}"
    echo "$ENV_FILES" | while read -r f; do echo "  - $f"; done
    echo -e "${YELLOW}These files may contain secrets and should be in .gitignore${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check for private keys
KEY_FILES=$(echo "$STAGED_FILES" | grep -E '\.(key|pem)$' | grep -v '\.example\.' || true)
if [ -n "$KEY_FILES" ]; then
    echo -e "${RED}ERROR: Attempting to commit private key file(s):${NC}"
    echo "$KEY_FILES" | while read -r f; do echo "  - $f"; done
    ERRORS=$((ERRORS + 1))
fi

# Check for credential/secret files
CRED_FILES=$(echo "$STAGED_FILES" | grep -E 'credentials\.json|secrets\.json|apikeys\.json' || true)
if [ -n "$CRED_FILES" ]; then
    echo -e "${RED}ERROR: Attempting to commit credential file(s):${NC}"
    echo "$CRED_FILES" | while read -r f; do echo "  - $f"; done
    ERRORS=$((ERRORS + 1))
fi

# Patterns that indicate hardcoded secrets (after the = sign)
# We look for lines with SECRET/KEY/PASSWORD followed by a long value
SECRET_PATTERNS=(
    'JWT_SECRET=[a-zA-Z0-9+/=_-]{32,}'
    'ENCRYPTION_KEY=[a-zA-Z0-9+/=_-]{32,}'
    'MASTER_ENCRYPTION_KEY=[a-zA-Z0-9+/=_-]{32,}'
    'N8N_ENCRYPTION_KEY=[a-zA-Z0-9+/=_-]{16,}'
    'API_KEY=[a-zA-Z0-9+/=_-]{20,}'
    'SECRET_KEY=[a-zA-Z0-9+/=_-]{20,}'
    'PRIVATE_KEY=[a-zA-Z0-9+/=_-]{20,}'
    'PASSWORD=[a-zA-Z0-9+/=_-]{12,}'
)

# Allowed placeholder patterns (these are OK to commit)
ALLOWED_PATTERNS=(
    'CHANGE_ME'
    'change-this'
    'your-.*-here'
    'example'
    'placeholder'
    'dev-secret'
)

# Check staged content for secrets
for file in $STAGED_FILES; do
    # Skip binary files, examples, and documentation
    if [[ "$file" =~ \.(md|example|sample)$ ]] || [[ "$file" =~ \.example\. ]]; then
        continue
    fi

    # Skip non-existent files (deleted)
    if [ ! -f "$file" ]; then
        continue
    fi

    # Get staged content
    CONTENT=$(git show ":$file" 2>/dev/null || cat "$file" 2>/dev/null || true)

    for pattern in "${SECRET_PATTERNS[@]}"; do
        MATCHES=$(echo "$CONTENT" | grep -oE "$pattern" || true)
        if [ -n "$MATCHES" ]; then
            # Check if it's an allowed placeholder
            IS_PLACEHOLDER=false
            for allowed in "${ALLOWED_PATTERNS[@]}"; do
                if echo "$MATCHES" | grep -qiE "$allowed"; then
                    IS_PLACEHOLDER=true
                    break
                fi
            done

            if [ "$IS_PLACEHOLDER" = false ]; then
                echo -e "${RED}ERROR: Potential secret detected in $file:${NC}"
                echo "$MATCHES" | head -3 | while read -r m; do
                    # Mask the actual value
                    KEY=$(echo "$m" | cut -d'=' -f1)
                    echo "  $KEY=<REDACTED>"
                done
                ERRORS=$((ERRORS + 1))
            fi
        fi
    done
done

# Check for high-entropy strings (potential API keys)
for file in $STAGED_FILES; do
    # Only check specific file types
    if [[ ! "$file" =~ \.(js|ts|jsx|tsx|json|yml|yaml|sh|py)$ ]]; then
        continue
    fi

    # Skip examples and docs
    if [[ "$file" =~ \.example\. ]] || [[ "$file" =~ /docs/ ]]; then
        continue
    fi

    if [ ! -f "$file" ]; then
        continue
    fi

    # Look for common API key patterns
    CONTENT=$(git show ":$file" 2>/dev/null || cat "$file" 2>/dev/null || true)

    # Check for sk-xxx (OpenAI style)
    if echo "$CONTENT" | grep -qE 'sk-[a-zA-Z0-9]{20,}'; then
        echo -e "${YELLOW}WARNING: Possible OpenAI API key pattern in $file${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Check for anthropic style keys
    if echo "$CONTENT" | grep -qE 'sk-ant-[a-zA-Z0-9]{20,}'; then
        echo -e "${YELLOW}WARNING: Possible Anthropic API key pattern in $file${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
done

# Summary
echo ""
if [ $ERRORS -gt 0 ]; then
    echo -e "${RED}COMMIT BLOCKED: $ERRORS secret(s) detected!${NC}"
    echo ""
    echo "To fix this:"
    echo "  1. Remove secrets from the files"
    echo "  2. Add files to .gitignore if they should never be committed"
    echo "  3. Use environment variables or .env files (which are gitignored)"
    echo ""
    echo "If this is a false positive, you can bypass with: git commit --no-verify"
    echo "(Use with caution!)"
    exit 1
elif [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}WARNINGS: $WARNINGS potential issue(s) detected.${NC}"
    echo "Please review before committing."
fi

echo -e "${GREEN}Pre-commit secrets check passed.${NC}"
exit 0
