#!/bin/bash
# Bundle the quox CLI into a self-contained tarball for dev-server installs.
# Creates quoxcli-bundle.tar.gz with bin/, lib/, package.json, node_modules/.
# No `npm install` needed on remote hosts. Served by the collector at
# GET /download/quoxcli-bundle.tar.gz (server.js), consumed by
# quoxagent/deploy/install.sh's quoxcli section.
#
# The tarball is FLAT (entries at the tar root): consumers MUST extract with
# -C into the final install dir (e.g. /opt/quoxcli). The quoxmcp bundle
# shipped the same shape and its installer extracted to /opt/ instead,
# leaving the install dir empty on every host (fixed 2026-08-15); this
# header exists so the next consumer does not repeat that.
#
# Usage: cd quox-dashboard/cli/deploy && ./bundle.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_NAME="quoxcli-bundle.tar.gz"
BUNDLE_DIR="$SCRIPT_DIR/.bundle-staging"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[bundle]${NC} $1"; }
error() { echo -e "${RED}[bundle]${NC} $1"; exit 1; }

[ -f "$CLI_ROOT/bin/quox.js" ] || error "bin/quox.js not found in $CLI_ROOT — run from cli/deploy/"
[ -d "$CLI_ROOT/node_modules" ] || error "node_modules/ not found. Run 'npm install' in $CLI_ROOT first."

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

log "Staging from $CLI_ROOT..."
cp -r "$CLI_ROOT/bin" "$BUNDLE_DIR/"
cp -r "$CLI_ROOT/lib" "$BUNDLE_DIR/"
cp "$CLI_ROOT/package.json" "$BUNDLE_DIR/"
cp -r "$CLI_ROOT/node_modules" "$BUNDLE_DIR/"

# Smoke the staged copy before shipping it: a bundle whose entrypoint cannot
# even print --help is not a bundle.
if ! node "$BUNDLE_DIR/bin/quox.js" --help >/dev/null 2>&1; then
  error "staged CLI failed 'node bin/quox.js --help' — refusing to bundle"
fi

log "Staged: $(du -sh "$BUNDLE_DIR" | cut -f1)"
log "Creating $BUNDLE_NAME..."
tar -czf "$SCRIPT_DIR/$BUNDLE_NAME" -C "$BUNDLE_DIR" .
rm -rf "$BUNDLE_DIR"

log "Bundle created: $SCRIPT_DIR/$BUNDLE_NAME ($(du -sh "$SCRIPT_DIR/$BUNDLE_NAME" | cut -f1))"
log "Consumers extract with: tar -xzf $BUNDLE_NAME -C /opt/quoxcli"
