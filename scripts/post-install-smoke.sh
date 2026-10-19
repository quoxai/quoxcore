#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-https://127.0.0.1:3000}}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Z2H-425 (#1313): routes behind login answer 401/403 on a clean install. Without a token that still proves the
# proxy reaches the service (reported "reachable, auth required"); with QUOX_TOKEN set the call is made
# authenticated and must succeed. A broken proxy (502/404/timeout/HTML) still FAILs.
QUOX_TOKEN="${QUOX_TOKEN:-}"
AUTH_ARGS=()
if [[ -n "${QUOX_TOKEN}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${QUOX_TOKEN}")
fi

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$1"; }
red() { printf '\033[0;31m%s\033[0m\n' "$1"; }

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  green "[smoke] PASS: $1"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  yellow "[smoke] SKIP: $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  red "[smoke] FAIL: $1"
}

request() {
  local path="$1"
  local headers_file="$2"
  local body_file="$3"
  curl -ksS -D "${headers_file}" -o "${body_file}" \
    -H 'Accept: application/json, text/html;q=0.9' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    "${BASE_URL}${path}" \
    -w '%{http_code}'
}

ensure_not_html_body() {
  local body_file="$1"
  if grep -qiE '^\s*<!doctype html|^\s*<html' "${body_file}"; then
    return 1
  fi
  return 0
}

check_json_health() {
  local label="$1"
  local path="$2"
  local required_fragment="$3"
  local headers_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').headers"
  local body_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').body"
  local code
  code="$(request "${path}" "${headers_file}" "${body_file}")"

  if [[ "${code}" == "401" || "${code}" == "403" ]]; then
    if [[ -n "${QUOX_TOKEN}" ]]; then
      fail "${label} returned HTTP ${code} with QUOX_TOKEN (token rejected)"
    elif ensure_not_html_body "${body_file}"; then
      pass "${label} (reachable, auth required: HTTP ${code}; set QUOX_TOKEN to check it authenticated)"
    else
      fail "${label} returned HTML instead of an API response"
    fi
    return
  fi

  if [[ "${code}" != "200" ]]; then
    fail "${label} returned HTTP ${code}"
    return
  fi

  if ! ensure_not_html_body "${body_file}"; then
    fail "${label} returned HTML instead of JSON"
    return
  fi

  if ! grep -q "${required_fragment}" "${body_file}"; then
    fail "${label} response missing expected fragment ${required_fragment}"
    return
  fi

  pass "${label}"
}

check_json_post() {
  local label="$1"
  local path="$2"
  local payload="$3"
  local required_fragment="$4"
  local headers_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').headers"
  local body_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').body"
  local code
  if [[ -z "${QUOX_TOKEN}" ]]; then
    skip "${label}: needs login (set QUOX_TOKEN to run it)"
    return
  fi
  code="$(curl -ksS -D "${headers_file}" -o "${body_file}" \
    -H 'Accept: application/json, text/html;q=0.9' \
    -H 'Content-Type: application/json' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    -X POST "${BASE_URL}${path}" \
    --data "${payload}" \
    -w '%{http_code}')"

  if [[ "${code}" != "200" ]]; then
    fail "${label} returned HTTP ${code}"
    return
  fi

  if ! ensure_not_html_body "${body_file}"; then
    fail "${label} returned HTML instead of JSON"
    return
  fi

  if ! grep -q "${required_fragment}" "${body_file}"; then
    fail "${label} response missing expected fragment ${required_fragment}"
    return
  fi

  pass "${label}"
}

check_delete_json() {
  local label="$1"
  local path="$2"
  local required_fragment="$3"
  local headers_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').headers"
  local body_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').body"
  local code
  if [[ -z "${QUOX_TOKEN}" ]]; then
    skip "${label}: needs login (set QUOX_TOKEN to run it)"
    return
  fi
  code="$(curl -ksS -D "${headers_file}" -o "${body_file}" \
    -H 'Accept: application/json, text/html;q=0.9' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    -X DELETE "${BASE_URL}${path}" \
    -w '%{http_code}')"

  if [[ "${code}" != "200" ]]; then
    fail "${label} returned HTTP ${code}"
    return
  fi

  if ! ensure_not_html_body "${body_file}"; then
    fail "${label} returned HTML instead of JSON"
    return
  fi

  if ! grep -q "${required_fragment}" "${body_file}"; then
    fail "${label} response missing expected fragment ${required_fragment}"
    return
  fi

  pass "${label}"
}

check_proxy_json_or_auth() {
  local label="$1"
  local path="$2"
  local headers_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').headers"
  local body_file="${TMP_DIR}/$(echo "${label}" | tr ' /' '__').body"
  local code
  code="$(request "${path}" "${headers_file}" "${body_file}")"

  case "${code}" in
    200|401|403)
      ;;
    *)
      fail "${label} returned unexpected HTTP ${code}"
      return
      ;;
  esac

  if ! ensure_not_html_body "${body_file}"; then
    fail "${label} returned HTML instead of a proxied API response"
    return
  fi

  pass "${label}"
}

# G3d: collector availability probe. A responsive governed surface answers a
# lightweight request well within budget. A build that starves the collector event
# loop (e.g. an unbounded synchronous hash walk over a huge WARD chain) blows this
# budget even while /health eventually returns 200, so this catches the DoS-shape
# class at deploy time rather than in production.
check_latency() {
  local label="$1" path="$2" budget_ms="${3:-5000}"
  local start end elapsed code max_s
  max_s=$(( (budget_ms + 999) / 1000 ))
  start="$(date +%s%3N)"
  code="$(curl -ksS -o /dev/null -w '%{http_code}' --max-time "${max_s}" "${BASE_URL}${path}" 2>/dev/null || echo 000)"
  end="$(date +%s%3N)"
  elapsed=$(( end - start ))
  if [[ "${code}" == "000" ]]; then
    fail "${label} did not respond within ${budget_ms}ms (collector event-loop starved?)"
    return
  fi
  if (( elapsed > budget_ms )); then
    fail "${label} responded in ${elapsed}ms (> ${budget_ms}ms budget); collector may be event-loop starved"
    return
  fi
  pass "${label} (${elapsed}ms, HTTP ${code})"
}

echo "[smoke] Base URL: ${BASE_URL}"
[[ -n "${QUOX_TOKEN}" ]] || yellow "[smoke] No QUOX_TOKEN: login-only checks are skipped, auth-required routes are checked as reachable"

check_json_health "Setup status" "/api/setup/status" '"readiness"'
check_json_health "Collector chat status" "/collector/chat/status" '"ready"'
check_json_health "Terminal health" "/collector/terminal/health" '"quoxcli"'
check_json_health "Files health" "/files-api/health" '"status"'
check_json_health "Tasks health" "/tasks/health" '"status"'
check_json_health "QuoxFlow health" "/quoxflow/health" '{'

# G3d availability gate: the governed surface must stay responsive, not just 200.
check_latency "Collector availability probe (G3d)" "/collector/chat/status" 5000

check_json_post \
  "Files upload proxy" \
  "/files-api/upload-base64" \
  '{"fileId":"smoke_upload_probe","filename":"smoke-upload-probe.txt","data":"data:text/plain;base64,c21va2UgdXBsb2FkIHByb2Jl"}' \
  '"success":true'
check_delete_json "Files delete proxy" "/files-api/file/smoke_upload_probe" '"success":true'

check_proxy_json_or_auth "Objectives API proxy" "/tasks/api/objectives?limit=1"
check_proxy_json_or_auth "Policies API proxy" "/quoxflow/api/policies?limit=1"

echo ""
echo "[smoke] Passed: ${PASS_COUNT}"
echo "[smoke] Skipped: ${SKIP_COUNT}"
echo "[smoke] Failed: ${FAIL_COUNT}"

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  yellow "[smoke] Post-install smoke failed. Fix the failing proxy/service paths before treating the platform as ready."
  exit 1
fi

green "[smoke] Post-install smoke passed"
