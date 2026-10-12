/**
 * serviceHealthClassifier.js
 *
 * Pure classification helper for the Instance Admin "Service Health" check
 * (GET/POST /admin/services). Separated from routes/admin.js so the
 * online / offline / not-configured decision can be unit tested without
 * spinning up Express + the SQLite DB.
 *
 * FALSE-NEGATIVE FIX (2026-07): services that are legitimately not part of
 * this deployment (e.g. n8n, which only starts under the optional
 * `--profile with-n8n` compose profile) must NOT render as red "OFFLINE" —
 * a network-level failure (DNS/connection refused/timeout) against an
 * optional service means "not configured for this instance", not "broken".
 * Required/core services still report a real failure so genuine outages
 * are visible.
 */

// Services registered in the `services` table that are not part of the
// default docker-compose deployment. A connection-level failure against
// one of these means "not deployed here", not "down".
export const OPTIONAL_SERVICE_IDS = new Set(['n8n']);

export function isOptionalServiceId(id) {
  return OPTIONAL_SERVICE_IDS.has(id);
}

/**
 * @param {Object} args
 * @param {string} args.id - service id (e.g. 'collector', 'n8n')
 * @param {{ ok: boolean, status: number }|null} args.response - fetch Response-like result, or null if the fetch threw
 * @param {Error|null} args.error - the error the fetch threw, or null if it resolved
 * @returns {{ status: 'healthy'|'unhealthy'|'disabled', statusMessage: string }}
 */
export function classifyServiceCheck({ id, response, error }) {
  if (response) {
    if (response.ok) {
      return { status: 'healthy', statusMessage: 'OK' };
    }
    return { status: 'unhealthy', statusMessage: `HTTP ${response.status}` };
  }

  // Network-level failure (DNS/connection refused/timeout/abort).
  const message = error?.name === 'AbortError' ? 'Timeout' : (error?.message || 'Unreachable');

  if (isOptionalServiceId(id)) {
    return { status: 'disabled', statusMessage: 'Not deployed on this instance' };
  }

  return { status: 'unhealthy', statusMessage: message };
}

/**
 * probeServiceHealth
 *
 * Shared fetch+classify step, extracted from the POST /admin/services/:id/check
 * route handler (routes/admin.js) so the periodic serviceHealthScheduler.js
 * background job can reuse the exact same probe + classification logic
 * instead of reimplementing it. Network/timeout behavior only — does NOT
 * touch the DB or emit audit events; callers are responsible for persisting
 * the returned { status, statusMessage } and logging as appropriate for
 * their context (admin-triggered vs scheduler-triggered).
 *
 * @param {{ id: string, health_endpoint: string|null }} service
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: 'healthy'|'unhealthy'|'disabled', statusMessage: string }>}
 */
export async function probeServiceHealth(service, { timeoutMs = 5000 } = {}) {
  if (!service.health_endpoint) {
    return { status: 'unknown', statusMessage: 'No health endpoint configured' };
  }

  let response = null;
  let fetchErr = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(service.health_endpoint, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    response = { ok: res.ok, status: res.status };
  } catch (err) {
    fetchErr = err;
  }

  return classifyServiceCheck({ id: service.id, response, error: fetchErr });
}
