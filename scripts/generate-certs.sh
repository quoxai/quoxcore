#!/bin/bash
# Generate self-signed SSL certificates for QuoxCORE
#
# Usage:
#   ./scripts/generate-certs.sh              # Auto-detect local IP
#   ./scripts/generate-certs.sh 192.168.1.50 # Specific IP
#   ./scripts/generate-certs.sh --help       # Show help
#
# Output:
#   certs/key.pem  - Private key
#   certs/cert.pem - Certificate (valid for 365 days)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Defaults
CERT_DIR="certs"
DAYS=365

show_help() {
    echo "QuoxCORE SSL Certificate Generator"
    echo ""
    echo "Usage:"
    echo "  ./scripts/generate-certs.sh              Auto-detect local IP"
    echo "  ./scripts/generate-certs.sh 192.168.1.50 Specific IP address"
    echo "  ./scripts/generate-certs.sh --help       Show this help"
    echo ""
    echo "Generated certificates will work for:"
    echo "  - localhost"
    echo "  - 127.0.0.1"
    echo "  - Your local network IP (auto-detected or specified)"
    echo ""
    echo "Output files:"
    echo "  certs/key.pem  - Private key"
    echo "  certs/cert.pem - Certificate"
    echo ""
    exit 0
}

# Parse arguments
if [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
    show_help
fi

# Determine local IP
if [[ -n "$1" ]]; then
    LOCAL_IP="$1"
    echo -e "Using specified IP: ${GREEN}$LOCAL_IP${NC}"
else
    # Auto-detect local IP (works on Linux and macOS)
    if command -v hostname &> /dev/null && hostname -I &> /dev/null; then
        LOCAL_IP=$(hostname -I | awk '{print $1}')
    elif command -v ifconfig &> /dev/null; then
        LOCAL_IP=$(ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1' | head -1)
    elif command -v ip &> /dev/null; then
        LOCAL_IP=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1)
    else
        LOCAL_IP="127.0.0.1"
    fi
    echo -e "Auto-detected local IP: ${GREEN}$LOCAL_IP${NC}"
fi

# Check for openssl
if ! command -v openssl &> /dev/null; then
    echo -e "${RED}Error: openssl is not installed${NC}"
    echo "Install with:"
    echo "  Ubuntu/Debian: sudo apt install openssl"
    echo "  macOS: brew install openssl"
    exit 1
fi

# Create certs directory
mkdir -p "$CERT_DIR"

# Check if certificates already exist
if [[ -f "$CERT_DIR/key.pem" ]] || [[ -f "$CERT_DIR/cert.pem" ]]; then
    echo -e "${YELLOW}Warning: Existing certificates found${NC}"
    read -p "Overwrite? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

echo ""
echo "Generating SSL certificate..."
echo "  - Valid for: localhost, 127.0.0.1, $LOCAL_IP"
echo "  - Expires: $DAYS days"
echo ""

# Create OpenSSL config for SAN (Subject Alternative Names)
OPENSSL_CONF=$(mktemp)
cat > "$OPENSSL_CONF" << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = QuoxCORE

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = $LOCAL_IP
EOF

# Generate certificate
openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days "$DAYS" \
    -nodes \
    -config "$OPENSSL_CONF"

# Cleanup
rm "$OPENSSL_CONF"

# Set permissions
chmod 600 "$CERT_DIR/key.pem"
chmod 644 "$CERT_DIR/cert.pem"

echo -e "${GREEN}✓ Certificates generated successfully${NC}"
echo ""
echo "Files created:"
echo "  $CERT_DIR/key.pem  (private key)"
echo "  $CERT_DIR/cert.pem (certificate)"
echo ""
echo "Certificate details:"
openssl x509 -in "$CERT_DIR/cert.pem" -noout -text | grep -E "(Subject:|DNS:|IP Address:)" | head -5
echo ""
echo "Valid until:"
openssl x509 -in "$CERT_DIR/cert.pem" -noout -enddate
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo "  1. Start dev server: npm run dev"
echo "  2. Access via: https://localhost:3000"
echo "  3. Or via: https://$LOCAL_IP:3000"
echo ""
echo -e "${YELLOW}Note: Your browser will show a security warning for self-signed certs.${NC}"
echo "This is expected - click 'Advanced' > 'Proceed' to continue."
