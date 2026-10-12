#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_auth_jwt_secret() {
  if [[ -n "${JWT_SECRET:-}" ]]; then
    printf '%s' "${JWT_SECRET}"
    return 0
  fi

  local pid
  pid="$(ss -ltnp '( sport = :3101 )' 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1)"
  if [[ -n "${pid}" && -r "/proc/${pid}/environ" ]]; then
    tr '\0' '\n' < "/proc/${pid}/environ" | sed -n 's/^JWT_SECRET=//p' | head -n1
    return 0
  fi

  return 1
}

cd "${ROOT_DIR}"

echo "[test:release] Running root Vitest release gate (cogcore3d quarantined)"
npm test -- --run --exclude='src/test/cogcore3d*.test.*'

echo "[test:release] Running collector suite"
bash scripts/test-collector-release.sh

echo "[test:release] Running screencap suite"
npm run test:screencap

echo "[test:release] Running auth suite"
if docker ps --format '{{.Names}}' | grep -qx 'quox-auth'; then
  docker exec quox-auth sh -lc 'cd /app/project/services/auth && npm test'
else
  AUTH_JWT_SECRET="$(resolve_auth_jwt_secret || true)"
  if [[ -z "${AUTH_JWT_SECRET}" ]]; then
    echo "[test:release] ERROR: Unable to resolve JWT_SECRET for auth integration tests." >&2
    echo "[test:release] Set JWT_SECRET in the environment or run the auth service locally on :3101." >&2
    exit 1
  fi
  (cd services/auth && JWT_SECRET="${AUTH_JWT_SECRET}" npm test)
fi

echo "[test:release] Running install/platform smoke"
BASE_URL="${BASE_URL:-https://127.0.0.1:3000}" bash scripts/post-install-smoke.sh

echo "[test:release] Running browser smoke"
BASE_URL="${BASE_URL:-https://127.0.0.1:3000}" npx playwright test tests/llm-routing-policy.spec.js --reporter=list

echo "[test:release] Building production bundle"
npm run build

echo "[test:release] Release gate passed"
