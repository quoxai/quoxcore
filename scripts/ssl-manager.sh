#!/bin/bash
# QuoxCORE SSL Certificate Manager
# Supports: selfsigned, letsencrypt, manual modes
#
# Usage:
#   ./scripts/ssl-manager.sh init       # Initialize SSL based on SSL_MODE
#   ./scripts/ssl-manager.sh renew      # Renew Let's Encrypt certificates
#   ./scripts/ssl-manager.sh status     # Show certificate status
#   ./scripts/ssl-manager.sh help       # Show help
#
# Environment Variables:
#   SSL_MODE              - selfsigned, letsencrypt, or manual (default: selfsigned)
#   LETSENCRYPT_DOMAIN    - Domain for Let's Encrypt certificate
#   LETSENCRYPT_EMAIL     - Email for Let's Encrypt notifications
#   LETSENCRYPT_STAGING   - Use staging server for testing (default: false)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SSL_MODE="${SSL_MODE:-selfsigned}"
SSL_DIR="/opt/quoxcore/ssl"
CERTS_DIR="/opt/quoxcore/certs"
ACME_DIR="/var/www/acme-challenge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Let's Encrypt settings
LETSENCRYPT_DOMAIN="${LETSENCRYPT_DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
LETSENCRYPT_STAGING="${LETSENCRYPT_STAGING:-false}"
LETSENCRYPT_LIVE="/etc/letsencrypt/live"

# Standard certificate names
CERT_NAME="quox.crt"
KEY_NAME="quox.key"

# ============================================
# Helper Functions
# ============================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This operation requires root privileges"
        log_info "Try: sudo $0 $*"
        exit 1
    fi
}

ensure_ssl_dir() {
    if [[ ! -d "$SSL_DIR" ]]; then
        mkdir -p "$SSL_DIR"
        log_info "Created SSL directory: $SSL_DIR"
    fi
}

load_env() {
    local env_file="/opt/quoxcore/.env"
    if [[ -f "$env_file" ]]; then
        # Source only SSL-related variables
        set -a
        source <(grep -E '^(SSL_MODE|LETSENCRYPT_)' "$env_file" 2>/dev/null || true)
        set +a
    fi
}

# ============================================
# Self-Signed Certificate Mode
# ============================================

init_selfsigned() {
    log_info "Initializing self-signed certificates..."

    ensure_ssl_dir

    # Use existing generate-certs.sh if available
    if [[ -x "$SCRIPT_DIR/generate-certs.sh" ]]; then
        log_info "Using generate-certs.sh..."
        cd /opt/quoxcore
        "$SCRIPT_DIR/generate-certs.sh" "$@"

        # Create symlinks in ssl/ directory
        if [[ -f "$CERTS_DIR/cert.pem" ]] && [[ -f "$CERTS_DIR/key.pem" ]]; then
            ln -sf "$CERTS_DIR/cert.pem" "$SSL_DIR/$CERT_NAME"
            ln -sf "$CERTS_DIR/key.pem" "$SSL_DIR/$KEY_NAME"
            log_success "Created symlinks in $SSL_DIR"
        fi
    else
        log_error "generate-certs.sh not found at $SCRIPT_DIR/generate-certs.sh"
        exit 1
    fi

    log_success "Self-signed certificate initialization complete"
}

# ============================================
# Let's Encrypt Mode
# ============================================

check_certbot() {
    if ! command -v certbot &> /dev/null; then
        log_error "certbot is not installed"
        echo ""
        echo "Install certbot with:"
        echo "  Ubuntu/Debian: sudo apt install certbot"
        echo "  RHEL/CentOS:   sudo yum install certbot"
        echo ""
        exit 1
    fi
}

validate_letsencrypt_config() {
    local errors=0

    if [[ -z "$LETSENCRYPT_DOMAIN" ]]; then
        log_error "LETSENCRYPT_DOMAIN is required"
        errors=$((errors + 1))
    fi

    if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
        log_error "LETSENCRYPT_EMAIL is required"
        errors=$((errors + 1))
    fi

    if [[ $errors -gt 0 ]]; then
        echo ""
        echo "Set these in .env or as environment variables:"
        echo "  LETSENCRYPT_DOMAIN=your-domain.com"
        echo "  LETSENCRYPT_EMAIL=admin@your-domain.com"
        exit 1
    fi
}

setup_acme_dir() {
    if [[ ! -d "$ACME_DIR" ]]; then
        log_info "Creating ACME challenge directory..."
        mkdir -p "$ACME_DIR/.well-known/acme-challenge"
        chown -R www-data:www-data "$ACME_DIR" 2>/dev/null || true
        chmod -R 755 "$ACME_DIR"
    fi
}

init_letsencrypt() {
    check_root
    check_certbot
    validate_letsencrypt_config

    log_info "Initializing Let's Encrypt for domain: $LETSENCRYPT_DOMAIN"

    ensure_ssl_dir
    setup_acme_dir

    # Build certbot command
    local certbot_args=(
        "certonly"
        "--webroot"
        "-w" "$ACME_DIR"
        "-d" "$LETSENCRYPT_DOMAIN"
        "--email" "$LETSENCRYPT_EMAIL"
        "--agree-tos"
        "--non-interactive"
    )

    # Add staging flag if enabled
    if [[ "$LETSENCRYPT_STAGING" == "true" ]]; then
        certbot_args+=("--staging")
        log_warn "Using Let's Encrypt STAGING server (certificates will not be trusted)"
    fi

    # Run certbot
    log_info "Running certbot..."
    if certbot "${certbot_args[@]}"; then
        log_success "Certificate obtained successfully"

        # Create symlinks
        create_letsencrypt_symlinks

        # Set up renewal hook
        setup_renewal_hook
    else
        log_error "certbot failed. Check nginx configuration and DNS settings."
        exit 1
    fi
}

create_letsencrypt_symlinks() {
    local cert_path="$LETSENCRYPT_LIVE/$LETSENCRYPT_DOMAIN"

    if [[ -d "$cert_path" ]]; then
        log_info "Creating symlinks to Let's Encrypt certificates..."

        # Remove old symlinks/files
        rm -f "$SSL_DIR/$CERT_NAME" "$SSL_DIR/$KEY_NAME"

        # Create new symlinks
        ln -sf "$cert_path/fullchain.pem" "$SSL_DIR/$CERT_NAME"
        ln -sf "$cert_path/privkey.pem" "$SSL_DIR/$KEY_NAME"

        log_success "Symlinks created:"
        log_info "  $SSL_DIR/$CERT_NAME -> $cert_path/fullchain.pem"
        log_info "  $SSL_DIR/$KEY_NAME -> $cert_path/privkey.pem"
    else
        log_error "Let's Encrypt certificate directory not found: $cert_path"
        exit 1
    fi
}

setup_renewal_hook() {
    local hook_src="$SCRIPT_DIR/renewal-hook.sh"
    local hook_dst="/etc/letsencrypt/renewal-hooks/deploy/quox-renewal.sh"

    if [[ -f "$hook_src" ]]; then
        log_info "Installing renewal hook..."
        mkdir -p /etc/letsencrypt/renewal-hooks/deploy
        cp "$hook_src" "$hook_dst"
        chmod +x "$hook_dst"
        log_success "Renewal hook installed"
    else
        log_warn "Renewal hook not found: $hook_src"
    fi
}

renew_letsencrypt() {
    check_root
    check_certbot

    log_info "Renewing Let's Encrypt certificates..."

    if certbot renew; then
        log_success "Certificate renewal complete"

        # Reload nginx if running
        if systemctl is-active --quiet nginx; then
            log_info "Reloading nginx..."
            systemctl reload nginx
            log_success "nginx reloaded"
        fi
    else
        log_error "Certificate renewal failed"
        exit 1
    fi
}

# ============================================
# Manual Certificate Mode
# ============================================

init_manual() {
    ensure_ssl_dir

    log_info "Manual certificate mode"
    echo ""
    echo "Place your certificate files in: $SSL_DIR"
    echo "  - Certificate: $SSL_DIR/$CERT_NAME"
    echo "  - Private Key: $SSL_DIR/$KEY_NAME"
    echo ""

    # Check if files already exist
    if [[ -f "$SSL_DIR/$CERT_NAME" ]] && [[ -f "$SSL_DIR/$KEY_NAME" ]]; then
        log_success "Certificate files found"
        show_cert_info "$SSL_DIR/$CERT_NAME"
    else
        log_warn "Certificate files not found"
        echo ""
        echo "To set up manually:"
        echo "  1. Copy your certificate to: $SSL_DIR/$CERT_NAME"
        echo "  2. Copy your private key to: $SSL_DIR/$KEY_NAME"
        echo "  3. Set permissions: chmod 600 $SSL_DIR/$KEY_NAME"
        echo ""
    fi
}

# ============================================
# Status and Info
# ============================================

show_cert_info() {
    local cert_file="$1"

    if [[ ! -f "$cert_file" ]]; then
        log_error "Certificate not found: $cert_file"
        return 1
    fi

    echo ""
    echo "Certificate Details:"
    echo "===================="

    # Subject
    echo -n "Subject: "
    openssl x509 -in "$cert_file" -noout -subject 2>/dev/null | sed 's/subject=//'

    # Issuer
    echo -n "Issuer:  "
    openssl x509 -in "$cert_file" -noout -issuer 2>/dev/null | sed 's/issuer=//'

    # Validity
    echo ""
    echo "Validity:"
    openssl x509 -in "$cert_file" -noout -dates 2>/dev/null | sed 's/^/  /'

    # Days until expiry
    local expiry_date
    expiry_date=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
    local expiry_epoch
    expiry_epoch=$(date -d "$expiry_date" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry_date" +%s 2>/dev/null)
    local now_epoch
    now_epoch=$(date +%s)
    local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

    if [[ $days_left -lt 0 ]]; then
        log_error "Certificate EXPIRED $((days_left * -1)) days ago"
    elif [[ $days_left -lt 30 ]]; then
        log_warn "Certificate expires in $days_left days"
    else
        log_success "Certificate expires in $days_left days"
    fi

    # SANs
    echo ""
    echo "Subject Alternative Names:"
    openssl x509 -in "$cert_file" -noout -text 2>/dev/null | grep -A1 "Subject Alternative Name" | tail -1 | sed 's/^[[:space:]]*/  /'

    echo ""
}

show_status() {
    echo ""
    echo "QuoxCORE SSL Status"
    echo "==================="
    echo ""

    log_info "SSL Mode: $SSL_MODE"
    log_info "SSL Directory: $SSL_DIR"
    echo ""

    # Check for certificate files
    local cert_file="$SSL_DIR/$CERT_NAME"
    local key_file="$SSL_DIR/$KEY_NAME"

    if [[ -f "$cert_file" ]] || [[ -L "$cert_file" ]]; then
        if [[ -L "$cert_file" ]]; then
            local target
            target=$(readlink -f "$cert_file")
            log_info "Certificate: $cert_file -> $target"
        else
            log_info "Certificate: $cert_file"
        fi

        show_cert_info "$cert_file"
    else
        log_warn "No certificate found at: $cert_file"
    fi

    if [[ -f "$key_file" ]] || [[ -L "$key_file" ]]; then
        if [[ -L "$key_file" ]]; then
            local target
            target=$(readlink -f "$key_file")
            log_info "Private Key: $key_file -> $target"
        else
            log_info "Private Key: $key_file"
        fi
    else
        log_warn "No private key found at: $key_file"
    fi

    # Show Let's Encrypt info if applicable
    if [[ "$SSL_MODE" == "letsencrypt" ]] && [[ -n "$LETSENCRYPT_DOMAIN" ]]; then
        echo ""
        echo "Let's Encrypt Configuration:"
        echo "  Domain:  $LETSENCRYPT_DOMAIN"
        echo "  Email:   $LETSENCRYPT_EMAIL"
        echo "  Staging: $LETSENCRYPT_STAGING"

        # Check certbot timer
        if systemctl is-active --quiet certbot.timer 2>/dev/null; then
            log_success "Certbot renewal timer is active"
        else
            log_warn "Certbot renewal timer is not active"
        fi
    fi
}

# ============================================
# Help
# ============================================

show_help() {
    echo "QuoxCORE SSL Certificate Manager"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  init      Initialize SSL certificates based on SSL_MODE"
    echo "  renew     Renew Let's Encrypt certificates"
    echo "  status    Show current certificate status"
    echo "  help      Show this help message"
    echo ""
    echo "SSL Modes:"
    echo "  selfsigned   Generate self-signed certificates (default)"
    echo "  letsencrypt  Use Let's Encrypt for trusted certificates"
    echo "  manual       Use manually provided certificates"
    echo ""
    echo "Environment Variables:"
    echo "  SSL_MODE              Certificate mode (selfsigned|letsencrypt|manual)"
    echo "  LETSENCRYPT_DOMAIN    Domain name for Let's Encrypt"
    echo "  LETSENCRYPT_EMAIL     Admin email for Let's Encrypt"
    echo "  LETSENCRYPT_STAGING   Use staging server (true|false)"
    echo ""
    echo "Examples:"
    echo "  # Self-signed (default)"
    echo "  $0 init"
    echo ""
    echo "  # Let's Encrypt"
    echo "  SSL_MODE=letsencrypt LETSENCRYPT_DOMAIN=quox.example.com \\"
    echo "    LETSENCRYPT_EMAIL=admin@example.com sudo $0 init"
    echo ""
    echo "  # Check status"
    echo "  $0 status"
    echo ""
    echo "Output Files:"
    echo "  $SSL_DIR/$CERT_NAME  - Certificate file (or symlink)"
    echo "  $SSL_DIR/$KEY_NAME   - Private key file (or symlink)"
    echo ""
    exit 0
}

# ============================================
# Main
# ============================================

main() {
    # Load environment variables from .env
    load_env

    local command="${1:-help}"
    shift || true

    case "$command" in
        init)
            case "$SSL_MODE" in
                selfsigned)
                    init_selfsigned "$@"
                    ;;
                letsencrypt)
                    init_letsencrypt "$@"
                    ;;
                manual)
                    init_manual "$@"
                    ;;
                *)
                    log_error "Unknown SSL_MODE: $SSL_MODE"
                    log_info "Valid modes: selfsigned, letsencrypt, manual"
                    exit 1
                    ;;
            esac
            ;;
        renew)
            if [[ "$SSL_MODE" == "letsencrypt" ]]; then
                renew_letsencrypt "$@"
            else
                log_warn "Renewal is only applicable for letsencrypt mode"
                log_info "Current mode: $SSL_MODE"
            fi
            ;;
        status)
            show_status
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "Unknown command: $command"
            echo ""
            show_help
            ;;
    esac
}

main "$@"
