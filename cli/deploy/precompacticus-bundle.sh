#!/bin/bash
# Bundle Precompacticus (context-limit alerts + pre-compaction snapshots for
# Claude Code) into a self-contained tarball for dev-server installs
# (DEVSUITE-DEVMODE phase 14). Today precompacticus is installed by a
# hand-run script, scripts/install-precompacticus.sh, once per box; that
# script's own header names the DEV-SERVERS kit delivering it at enrolment
# as the registered productisation path and itself as only the bridge. This
# is that path: the collector already serves everything under cli/deploy
# (see server.js GET /download/quoxcli-bundle.tar.gz and
# /download/quoxgauge-bundle.tar.gz), so dropping a precompacticus tarball
# in the same directory needs no new volume mount.
#
# Creates precompacticus-bundle.tar.gz with precompacticus.py,
# precompacticus.conf.example and README.md only — the same three files
# install-precompacticus.sh installs, minus the runtime snapshots/ dir
# (self-heals via mkdir on the remote host).
#
# The tarball is FLAT (entries at the tar root), same shape as
# quoxcli-bundle.tar.gz and quoxgauge-bundle.tar.gz: consumers extract with
# -C into the destination (~/.claude/precompacticus/).
#
# Usage: cd quox-dashboard/cli/deploy && ./precompacticus-bundle.sh
# Override the source dir with PC_ROOT=/path/to/precompacticus.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(dirname "$SCRIPT_DIR")"
DASHBOARD_ROOT="$(dirname "$CLI_ROOT")"
PC_ROOT="${PC_ROOT:-$DASHBOARD_ROOT/scripts/precompacticus}"
BUNDLE_NAME="precompacticus-bundle.tar.gz"
BUNDLE_DIR="$SCRIPT_DIR/.precompacticus-bundle-staging"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[precompacticus-bundle]${NC} $1"; }
error() { echo -e "${RED}[precompacticus-bundle]${NC} $1"; exit 1; }

[ -f "$PC_ROOT/precompacticus.py" ] || error "precompacticus.py not found in $PC_ROOT, set PC_ROOT to the payload dir"
[ -f "$PC_ROOT/precompacticus.conf.example" ] || error "precompacticus.conf.example not found in $PC_ROOT"

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

log "Staging from $PC_ROOT..."
cp "$PC_ROOT/precompacticus.py" "$BUNDLE_DIR/"
cp "$PC_ROOT/precompacticus.conf.example" "$BUNDLE_DIR/"
[ -f "$PC_ROOT/README.md" ] && cp "$PC_ROOT/README.md" "$BUNDLE_DIR/"

# Smoke the staged copy before shipping it: the statusline entrypoint must
# run and degrade gracefully on a fake payload (same smoke as
# install-precompacticus.sh's own final check).
SMOKE_ERR="$(mktemp)"
set +e
echo '{}' | python3 "$BUNDLE_DIR/precompacticus.py" statusline >/dev/null 2>"$SMOKE_ERR"
SMOKE_EXIT=$?
set -e
if [ "$SMOKE_EXIT" -ne 0 ]; then
  cat "$SMOKE_ERR" >&2
  rm -f "$SMOKE_ERR"
  error "staged precompacticus crashed (exit $SMOKE_EXIT), refusing to bundle"
fi
rm -f "$SMOKE_ERR"

log "Staged: $(du -sh "$BUNDLE_DIR" | cut -f1)"
log "Creating $BUNDLE_NAME..."
tar -czf "$SCRIPT_DIR/$BUNDLE_NAME" -C "$BUNDLE_DIR" .
rm -rf "$BUNDLE_DIR"

log "Bundle created: $SCRIPT_DIR/$BUNDLE_NAME ($(du -sh "$SCRIPT_DIR/$BUNDLE_NAME" | cut -f1))"
log "Consumers extract with: tar -xzf $BUNDLE_NAME -C ~/.claude/precompacticus"
