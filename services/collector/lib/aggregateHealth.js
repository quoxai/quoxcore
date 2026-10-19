/**
 * Aggregate Health — Platform-wide health aggregation
 *
 * Provides a single endpoint response combining health from all Quox services,
 * fleet status, agent sessions, vault, memory, and AEE protocol status.
 *
 * Created: CLI-2a (Stream CLI Phase 2)
 */

/**
 * Check health of a single service by fetching its health endpoint.
 * @param {string} baseUrl - Service base URL (e.g., http://localhost:3101)
 * @param {string} path - Health endpoint path (e.g., /health)
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @param {Function} [fetchFn] - Optional fetch override for testing
 * @returns {Promise<{status: string, latency_ms: number|null, error?: string}>}
 */
async function checkServiceHealth(baseUrl, path, timeoutMs, fetchFn) {
  const doFetch = fetchFn || globalThis.fetch;
  const start = Date.now();

  try {
    const response = await Promise.race([
      doFetch(`${baseUrl}${path}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);

    const latency = Date.now() - start;

    if (response.ok) {
      return { status: 'ok', latency_ms: latency };
    }
    return { status: 'degraded', latency_ms: latency };
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    return { status: 'down', latency_ms: null, error: err.message, ...(code ? { code } : {}) };
  }
}

// Z2H run-6: an optional component (RepoBrain) the public install does not ship. The install marks it with an
// explicit empty URL (setup.sh: REPOBRAIN_URL= when ../quox-repobrain is absent). Only that means "not installed";
// anything configured is probed, and a failure (including a stopped container that no longer resolves) is down.
async function checkOptionalServiceHealth(baseUrl, path, timeoutMs, { fetchFn } = {}) {
  if (!baseUrl) return { status: 'not_installed', optional: true, latency_ms: null };
  return checkServiceHealth(baseUrl, path, timeoutMs, fetchFn);
}

/**
 * Compute an aggregate health score (0-100) from individual service statuses.
 * Each service contributes equally. ok=full, degraded=half, down=zero.
 * @param {Object} services - Map of service name → {status, latency_ms}
 * @returns {number} Score 0-100
 */
function computeHealthScore(services) {
  const entries = Object.values(services);
  if (entries.length === 0) return 0;

  let total = 0;
  const counted = entries.filter((svc) => svc.status !== 'not_installed'); // not shipped here: neither up nor down
  if (counted.length === 0) return 0;
  for (const svc of counted) {
    if (svc.status === 'ok') total += 1;
    else if (svc.status === 'degraded') total += 0.5;
    // 'down' contributes 0
  }

  return Math.round((total / counted.length) * 100);
}

const DEFAULTS = {
  fleet: { total: 0, healthy: 0, degraded: 0, down: 0 },
  sessions: { active: 0, providers: {}, cost_today_usd: 0 },
  vault: { total: 0, healthy: 0, expiring_soon: 0 },
  memory: { entries: 0, vector_size_gb: 0, scope: 'default_org' },
  aee: { envelopes_today: 0, chain_ok: true },
  workflows: { running: 0, pending_approval: 0 },
};

/**
 * Build the aggregate health response from pre-fetched data.
 * @param {Object} data - All health data sections
 * @returns {Object} Complete aggregate health response
 */
async function buildAggregateHealth({
  serviceChecks,
  fleetData,
  sessionData,
  vaultData,
  memoryData,
  aeeData,
  workflowData,
}) {
  return {
    score: computeHealthScore(serviceChecks || {}),
    services: serviceChecks || {},
    fleet: fleetData || DEFAULTS.fleet,
    sessions: sessionData || DEFAULTS.sessions,
    vault: vaultData || DEFAULTS.vault,
    memory: memoryData || DEFAULTS.memory,
    aee: aeeData || DEFAULTS.aee,
    workflows: workflowData || DEFAULTS.workflows,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  checkServiceHealth,
  checkOptionalServiceHealth,
  computeHealthScore,
  buildAggregateHealth,
};
