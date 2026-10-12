#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/services/collector"

npx vitest run \
  test/consentVerification.test.js \
  test/providerRouting.test.js \
  test/llmRoutingPolicy.test.js \
  test/chatHealth.test.js \
  test/httpAuth.test.js \
  test/httpAuth-security.test.js \
  test/internalServiceHeaders.test.js \
  test/terminalWs.test.js \
  test/claudeTerminalBootstrap.test.js
