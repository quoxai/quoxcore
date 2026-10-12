/**
 * quox#503 — tasks-service client for the collector's kill switch / DEFCON
 * state (services/collector/lib/killSwitchStore.js, routes/safetyGate.js).
 * The tasks service owns no safety state of its own: "SERVER-SIDE STATE,
 * org-scoped, owned by the collector" is the binding design. Every
 * enforcement checkpoint that lives in this service (agentScheduler.js
 * pre-dispatch, loopDispatch.js turn boundary) crosses the service
 * boundary via this module, the same way interruptLoopSession/
 * escalateToHuman already cross to the collector/auth services.
 *
 * FAILURE POSTURE (binding, tested in safetyGate.test.js): a safety gate
 * that cannot be reached — collector down, network partition, timeout,
 * non-2xx, unparseable body — is treated as `blocked: true`, never as "no
 * halt in effect". This mirrors the established precedent one file away
 * (loopDispatch.js's sandbox-lease check: "any lapse ... halts the live
 * session"). A kill switch that goes blind and defaults to permissive is
 * not a kill switch.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

function failClosed(message) {
  return {
    blocked: true,
    escalate: false,
    defcon: 'UNKNOWN',
    agentHalted: false,
    reason: `safety gate unreachable (${message}) — failing closed`,
    gateError: true,
  }
}

/**
 * @param {string} orgId
 * @param {string} agentId
 * @param {{fetchFn?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{blocked: boolean, escalate: boolean, defcon: string, agentHalted: boolean, reason: string|null, gateError?: boolean}>}
 */
export async function checkSafetyGate(orgId, agentId, opts = {}) {
  const fetchFn = opts.fetchFn || fetch
  try {
    const url = `${COLLECTOR_URL}/api/v1/safety/gate?org_id=${encodeURIComponent(orgId || '')}&agent_id=${encodeURIComponent(agentId || '')}`
    const resp = await fetchFn(url, {
      headers: { ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs || 5000),
    })
    if (!resp.ok) return failClosed(`HTTP ${resp.status}`)
    const body = await resp.json()
    if (typeof body?.blocked !== 'boolean') return failClosed('malformed response body')
    return body
  } catch (err) {
    return failClosed(err.message || 'unknown error')
  }
}
