#!/bin/bash
# QuoxCORE SSL Renewal Hook
# Post-renewal hook for Let's Encrypt certbot
#
# This script is called automatically by certbot after successful renewal.
# It updates symlinks and reloads nginx to pick up the new certificates.
#
# Installation:
#   Copy to: /etc/letsencrypt/renewal-hooks/deploy/quox-renewal.sh
#   Or run: ssl-manager.sh init (with SSL_MODE=letsencrypt)

set -e

# Configuration
SSL_DIR="/opt/quoxcore/ssl"
CERT_NAME="quox.crt"
KEY_NAME="quox.key"
LOG_FILE="/var/log/quox-ssl-renewal.log"

# Colors (for interactive use)
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ============================================
# Logging
# ============================================

log() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$message" >> "$LOG_FILE" 2>/dev/null || true
    echo -e "$message"
}

log_success() {
    log "${GREEN}[OK]${NC} $1"
}

log_warn() {
    log "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    log "${RED}[ERROR]${NC} $1"
}

# ============================================
# Main Renewal Hook Logic
# ============================================

update_symlinks() {
    # RENEWED_LINEAGE is set by certbot and contains the path to the renewed cert
    if [[ -z "$RENEWED_LINEAGE" ]]; then
        log_error "RENEWED_LINEAGE not set. This script should be run by certbot."
        return 1
    fi

    log "Processing renewal for: $RENEWED_LINEAGE"

    local cert_path="$RENEWED_LINEAGE/fullchain.pem"
    local key_path="$RENEWED_LINEAGE/privkey.pem"

    # Verify new certificates exist
    if [[ ! -f "$cert_path" ]]; then
        log_error "New certificate not found: $cert_path"
        return 1
    fi

    if [[ ! -f "$key_path" ]]; then
        log_error "New private key not found: $key_path"
        return 1
    fi

    # Ensure SSL directory exists
    mkdir -p "$SSL_DIR"

    # Update symlinks
    log "Updating symlinks in $SSL_DIR..."

    rm -f "$SSL_DIR/$CERT_NAME"
    rm -f "$SSL_DIR/$KEY_NAME"

    ln -sf "$cert_path" "$SSL_DIR/$CERT_NAME"
    ln -sf "$key_path" "$SSL_DIR/$KEY_NAME"

    log_success "Symlinks updated"
    log "  $SSL_DIR/$CERT_NAME -> $cert_path"
    log "  $SSL_DIR/$KEY_NAME -> $key_path"

    return 0
}

reload_nginx() {
    if command -v nginx &> /dev/null; then
        # Test nginx configuration first
        if nginx -t 2>/dev/null; then
            log "Reloading nginx..."

            if systemctl is-active --quiet nginx; then
                systemctl reload nginx
                log_success "nginx reloaded via systemctl"
            elif service nginx status &>/dev/null; then
                service nginx reload
                log_success "nginx reloaded via service"
            elif nginx -s reload 2>/dev/null; then
                log_success "nginx reloaded via signal"
            else
                log_warn "Could not reload nginx - may need manual restart"
            fi
        else
            log_error "nginx configuration test failed - not reloading"
            return 1
        fi
    else
        log_warn "nginx not found - skipping reload"
    fi

    return 0
}

reload_other_services() {
    # Reload any other services that use the certificate

    # Example: Reload Node.js application (if using PM2)
    if command -v pm2 &> /dev/null; then
        if pm2 list 2>/dev/null | grep -q "quox"; then
            log "Reloading PM2 quox processes..."
            pm2 reload quox --update-env 2>/dev/null || true
        fi
    fi

    # Example: Docker containers
    if command -v docker &> /dev/null; then
        # Send HUP signal to nginx containers using the cert
        local nginx_containers
        nginx_containers=$(docker ps --filter "name=nginx" --format "{{.Names}}" 2>/dev/null || true)

        for container in $nginx_containers; do
            if [[ -n "$container" ]]; then
                log "Sending SIGHUP to docker container: $container"
                docker kill --signal=HUP "$container" 2>/dev/null || true
            fi
        done
    fi
}

verify_certificate() {
    local cert_file="$SSL_DIR/$CERT_NAME"

    if [[ -f "$cert_file" ]] || [[ -L "$cert_file" ]]; then
        # Check expiry
        local expiry
        expiry=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
        log "New certificate expires: $expiry"

        # Verify certificate chain
        if openssl verify -CAfile "$cert_file" "$cert_file" &>/dev/null; then
            log_success "Certificate chain verified"
        fi
    fi
}

send_notification() {
    # Optional: Send notification about renewal
    # Implement email, Slack, or other notification here

    local domain
    domain=$(basename "$RENEWED_LINEAGE")

    # Example: Log to syslog
    logger -t "quox-ssl" "SSL certificate renewed for $domain"

    # Example: Create a marker file for dashboard to detect
    local marker_file="/tmp/quox-ssl-renewed"
    echo "$(date -Iseconds) $domain" >> "$marker_file"
}

# ============================================
# Main
# ============================================

main() {
    log "=========================================="
    log "QuoxCORE SSL Renewal Hook Started"
    log "=========================================="

    # Update symlinks
    if ! update_symlinks; then
        log_error "Failed to update symlinks"
        exit 1
    fi

    # Verify the new certificate
    verify_certificate

    # Reload services
    reload_nginx
    reload_other_services

    # Send notification
    send_notification

    log_success "Renewal hook completed successfully"
    log "=========================================="

    exit 0
}

# Run main function
main "$@"
