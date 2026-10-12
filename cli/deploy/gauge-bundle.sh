#!/bin/bash
# Bundle DoneEngine (quox-gauge) into a self-contained tarball for dev-server
# installs (#456). quox-gauge is a separate, private repo, so this script
# lives here rather than there: the collector already serves everything
# under cli/deploy (see server.js GET /download/quoxcli-bundle.tar.gz), so
# dropping a gauge tarball in the same directory needs no new volume mount.
#
# Creates quoxgauge-bundle.tar.gz with gauge.mjs, packs/, and deploy-map.json
# only. DoneEngine has no dependencies (single-file Node ESM), and
# snapshots/, test/, docs/ are either runtime state (self-heals via
# mkdirSync) or not needed to run `quox done` on a fresh host.
#
# The tarball is FLAT (entries at the tar root), same shape as
# quoxcli-bundle.tar.gz: consumers extract with -C into /opt/quoxgauge.
#
# Usage: cd quox-dashboard/cli/deploy && ./gauge-bundle.sh
# Override the source checkout with GAUGE_ROOT=/path/to/quox-gauge.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(dirname "$SCRIPT_DIR")"
DASHBOARD_ROOT="$(dirname "$CLI_ROOT")"
GAUGE_ROOT="${GAUGE_ROOT:-$(dirname "$DASHBOARD_ROOT")/quox-gauge}"
BUNDLE_NAME="quoxgauge-bundle.tar.gz"
BUNDLE_DIR="$SCRIPT_DIR/.gauge-bundle-staging"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[gauge-bundle]${NC} $1"; }
error() { echo -e "${RED}[gauge-bundle]${NC} $1"; exit 1; }

[ -f "$GAUGE_ROOT/gauge.mjs" ] || error "gauge.mjs not found in $GAUGE_ROOT, set GAUGE_ROOT to the quox-gauge checkout"
[ -d "$GAUGE_ROOT/packs" ] || error "packs/ not found in $GAUGE_ROOT"

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

log "Staging from $GAUGE_ROOT..."
cp "$GAUGE_ROOT/gauge.mjs" "$BUNDLE_DIR/"
cp -r "$GAUGE_ROOT/packs" "$BUNDLE_DIR/"
[ -f "$GAUGE_ROOT/deploy-map.json" ] && cp "$GAUGE_ROOT/deploy-map.json" "$BUNDLE_DIR/"

# Smoke the staged copy before shipping it: 0/1/2 are all real verdicts
# (clear/refused/unknown), only a crash (anything else, e.g. a Node
# exception) means the bundle is broken.
SMOKE_ERR="$(mktemp)"
set +e
node "$BUNDLE_DIR/gauge.mjs" --can-ship all --pack launch-spine --no-deploy --json >/dev/null 2>"$SMOKE_ERR"
GAUGE_SMOKE_EXIT=$?
set -e
if [ "$GAUGE_SMOKE_EXIT" -gt 2 ]; then
  cat "$SMOKE_ERR" >&2
  rm -f "$SMOKE_ERR"
  error "staged DoneEngine crashed (exit $GAUGE_SMOKE_EXIT), refusing to bundle"
fi
rm -f "$SMOKE_ERR"

log "Staged: $(du -sh "$BUNDLE_DIR" | cut -f1)"
log "Creating $BUNDLE_NAME..."
tar -czf "$SCRIPT_DIR/$BUNDLE_NAME" -C "$BUNDLE_DIR" .
rm -rf "$BUNDLE_DIR"

log "Bundle created: $SCRIPT_DIR/$BUNDLE_NAME ($(du -sh "$SCRIPT_DIR/$BUNDLE_NAME" | cut -f1))"
log "Consumers extract with: tar -xzf $BUNDLE_NAME -C /opt/quoxgauge"
