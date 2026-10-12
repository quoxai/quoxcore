#!/bin/bash
# Quox Auth Service Startup Script

cd "$(dirname "$0")"

# Check for required dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Create data directory if needed
mkdir -p "$(dirname "${AUTH_DB_PATH:-/var/lib/quox/auth.db}")"

# Start the service
echo "Starting Quox Auth Service..."
exec node server.js
