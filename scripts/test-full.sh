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

echo "[test:full] Running root Vitest suite"
echo "[test:full] Note: this includes quarantined CogCore3D suites. Use test:release for the release gate."
npm test -- --run

echo "[test:full] Running collector suite"
(cd services/collector && npm test)

echo "[test:full] Running screencap suite"
npm run test:screencap

echo "[test:full] Running quoxbrain suite"
npm run test:quoxbrain

echo "[test:full] Running memory suite"
npm run test:memory

echo "[test:full] Running cli suite"
npm run test:cli

echo "[test:full] Running auth suite"
AUTH_JWT_SECRET="$(resolve_auth_jwt_secret || true)"
if [[ -z "${AUTH_JWT_SECRET}" ]]; then
  echo "[test:full] ERROR: Unable to resolve JWT_SECRET for auth integration tests." >&2
  echo "[test:full] Set JWT_SECRET in the environment or run the auth service locally on :3101." >&2
  exit 1
fi
(cd services/auth && JWT_SECRET="${AUTH_JWT_SECRET}" npm test)

echo "[test:full] All suites passed"
