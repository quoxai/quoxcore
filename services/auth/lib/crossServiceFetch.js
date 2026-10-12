/**
 * crossServiceFetch.js — canonical pattern for auth→service HTTP calls
 *
 * Every cross-service fetch in auth must:
 *   1. Log pre-fetch (proves call was attempted, with target + key payload fields)
 *   2. Wrap network layer in try/catch (fetch rejects on DNS/network errors)
 *   3. Check response.ok explicitly (fetch does NOT throw on non-2xx)
 *   4. Surface response body excerpt on failure
 *   5. Throw on failure so the caller's transaction/handler can roll back
 *
 * Per feedback_silent_success_cross_service.md (P2.C live verify 2026-05-22):
 * silent success on a failed cross-service call is the worst-class bug —
 * the wizard ships false-positive, the agent appears in /agents but is not
 * invocable. Every call site must produce enough log output to diagnose
 * a failure in <60 seconds.
 */

/**
 * Error thrown when a cross-service call fails (network or non-2xx).
 * Callers catch this to roll back local state or return 503 to the client.
 */
export class CrossServiceError extends Error {
  constructor(label, status, bodyExcerpt) {
    super(`[cross-service] ${label} failed: HTTP ${status} — ${bodyExcerpt}`);
    this.name = 'CrossServiceError';
    this.label = label;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/**
 * assertJsonResponse — fire a fetch, enforce pre-log + network + .ok checks.
 *
 * @param {string}  label        — short human label, e.g. 'auth→collector install'
 * @param {string}  url          — full URL being fetched
 * @param {object}  fetchOptions — options passed directly to fetch()
 * @param {object}  [logFields]  — extra fields to include in the pre-fetch log line
 * @returns {Promise<Response>}  — the Response object on success (status 2xx)
 * @throws  {CrossServiceError}  — on network error OR non-2xx response
 */
export async function assertJsonResponse(label, url, fetchOptions, logFields = {}) {
  // Step 1: pre-fetch log — proves the call was attempted
  console.log(`[CROSS-SERVICE] ${label} → POST ${url}`, logFields);

  let response;
  // Step 2: network-level try/catch — fetch rejects on DNS/timeout/ECONNREFUSED
  try {
    response = await fetch(url, fetchOptions);
  } catch (err) {
    console.error(`[CROSS-SERVICE] ${label} NETWORK ERROR`, {
      url,
      error: err.message,
      ...logFields,
    });
    throw new CrossServiceError(label, 'NETWORK_ERROR', err.message);
  }

  // Step 3: explicit response.ok check — fetch does NOT throw on 4xx/5xx
  if (!response.ok) {
    // Step 4: surface body excerpt so you can read the downstream error
    let bodyExcerpt = '<unreadable>';
    try {
      bodyExcerpt = await response.text();
      bodyExcerpt = bodyExcerpt.slice(0, 500);
    } catch (_) { /* ignore */ }

    console.error(`[CROSS-SERVICE] ${label} NON-2XX`, {
      url,
      status: response.status,
      bodyExcerpt,
      ...logFields,
    });
    throw new CrossServiceError(label, response.status, bodyExcerpt);
  }

  // Step 5: success log — a missing success log is itself a diagnostic signal
  console.log(`[CROSS-SERVICE] ${label} OK`, {
    url,
    status: response.status,
    ...logFields,
  });

  return response;
}

export default assertJsonResponse;
