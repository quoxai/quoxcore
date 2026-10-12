#!/bin/bash
# QuoxCORE Secret Generation Script
# Generates secure secrets and updates .env file
#
# Usage: ./scripts/generate-secrets.sh
#
# This script will:
# 1. Create .env from .env.example if it doesn't exist
# 2. Generate cryptographically secure values for:
#    - JWT_SECRET (32 bytes, hex)
#    - ENCRYPTION_KEY (64 bytes, hex)
#    - N8N_ENCRYPTION_KEY (16 bytes, hex)
#    - MASTER_ENCRYPTION_KEY (32 bytes, base64url)
#    - QDRANT_API_KEY (32 bytes, hex)
#    - POSTGRES_PASSWORD (32 bytes, hex)
#    - INTERNAL_SERVICE_KEY (32 bytes, hex)
#    - WEBSITE_SERVICE_KEY (32 bytes, hex)
#    - N8N_BASIC_AUTH_PASSWORD (16 bytes, hex)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"
ENV_EXAMPLE="$PROJECT_ROOT/.env.example"

echo "QuoxCORE Secret Generator"
echo "========================="
echo ""

# Create .env from example if it doesn't exist
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_EXAMPLE" ]; then
        echo "Creating .env from .env.example..."
        cp "$ENV_EXAMPLE" "$ENV_FILE"
    else
        echo "Error: Neither .env nor .env.example found!"
        exit 1
    fi
fi

# Function to generate a secret
generate_secret() {
    local bytes=$1
    local format=${2:-hex}

    if [ "$format" = "base64url" ]; then
        openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '='
    else
        openssl rand -hex "$bytes"
    fi
}

# Function to update or add a variable in .env
update_env() {
    local key=$1
    local value=$2

    if grep -q "^${key}=" "$ENV_FILE"; then
        # Check if it's a placeholder value
        current=$(grep "^${key}=" "$ENV_FILE" | cut -d'=' -f2)
        if [[ "$current" == *"CHANGE_ME"* ]] || [[ "$current" == *"change-this"* ]] || [[ -z "$current" ]]; then
            # Replace with new value
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
            else
                sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
            fi
            echo "  ✓ Generated ${key}"
        else
            echo "  - ${key} already set (skipped)"
        fi
    else
        # Add new variable
        echo "${key}=${value}" >> "$ENV_FILE"
        echo "  ✓ Added ${key}"
    fi
}

echo "Generating secrets..."
echo ""

# Generate each secret
update_env "JWT_SECRET" "$(generate_secret 32)"
update_env "ENCRYPTION_KEY" "$(generate_secret 64)"
update_env "N8N_ENCRYPTION_KEY" "$(generate_secret 16)"
update_env "MASTER_ENCRYPTION_KEY" "$(generate_secret 32 base64url)"
update_env "QDRANT_API_KEY" "$(generate_secret 32)"
update_env "POSTGRES_PASSWORD" "$(generate_secret 32)"
update_env "INTERNAL_SERVICE_KEY" "$(generate_secret 32)"
# MUST be different from INTERNAL_SERVICE_KEY — see .env.example note.
update_env "WEBSITE_SERVICE_KEY" "$(generate_secret 32)"
update_env "N8N_BASIC_AUTH_PASSWORD" "$(generate_secret 16)"

# Detect host Docker GID for orchestrator container
HOST_DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3)
if [ -n "$HOST_DOCKER_GID" ]; then
    update_env "DOCKER_GID" "$HOST_DOCKER_GID"
else
    echo "  - DOCKER_GID: docker group not found (orchestrator may need manual config)"
fi

# Auto-detect CORS_ORIGINS from local IP (Issue #192)
LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
CORS_VALUE="https://${LOCAL_IP}:3000,https://${LOCAL_IP}:3443,https://${LOCAL_IP},https://localhost:3000,https://localhost:3443,https://localhost,http://localhost:3000,http://localhost:5173"
update_env "CORS_ORIGINS" "$CORS_VALUE"

# Frontend service URLs — must use proxy paths so remote browsers work
update_env "VITE_MEMORY_SERVICE_URL" "/api/memory"
update_env "VITE_QDRANT_URL" "/qdrant"

echo ""
echo "Done! Secrets have been written to .env"

# Generate SSL certs for nginx (quox.crt / quox.key in ssl/ directory)
SSL_DIR="$PROJECT_ROOT/ssl"
if [ ! -f "$SSL_DIR/quox.crt" ] || [ ! -f "$SSL_DIR/quox.key" ]; then
    echo ""
    echo "Generating self-signed SSL certificate..."
    mkdir -p "$SSL_DIR"

    # Detect local IP for SAN
    LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

    openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
        -keyout "$SSL_DIR/quox.key" \
        -out "$SSL_DIR/quox.crt" \
        -subj "/CN=quox.local/O=QuoxCORE/C=US" \
        -addext "subjectAltName=IP:127.0.0.1,IP:${LOCAL_IP},DNS:localhost,DNS:quox.local" \
        2>/dev/null

    chmod 600 "$SSL_DIR/quox.key"
    chmod 644 "$SSL_DIR/quox.crt"
    echo "  ✓ Generated ssl/quox.crt and ssl/quox.key (valid for 365 days)"
    echo "  ✓ Certificate covers: localhost, 127.0.0.1, ${LOCAL_IP}"
else
    echo "  - ssl/quox.crt already exists (skipped)"
fi

echo ""
echo "IMPORTANT: Keep your .env file secure and never commit it to version control."
echo ""
echo "Next steps:"
echo "  1. Review and customize other settings in .env"
echo "  2. Run: docker compose up -d"
echo "  3. Open: https://localhost"
