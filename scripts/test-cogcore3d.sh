#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[test:cogcore3d] Running quarantined CogCore3D suites"
mapfile -t SUITES < <(find src/test -maxdepth 1 -type f \( -name 'cogcore3d*.test.*' -o -name 'cogcore3d-*.test.*' -o -name 'cogcore3d-v*.test.*' \) | sort -u)

if [[ "${#SUITES[@]}" -eq 0 ]]; then
  echo "[test:cogcore3d] No CogCore3D suites found"
  exit 0
fi

npm test -- --run "${SUITES[@]}"
