/**
 * Quox Service Health Check System
 *
 * Comprehensive health verification for all Quox services.
 * Checks not just if services respond, but if they have the expected capabilities.
 *
 * Usage:
 *   import { runFullHealthCheck, getServiceStatus } from './healthCheck'
 *   const health = await runFullHealthCheck()
 *   console.log(health.summary)  // "3/4 services healthy"
 */

import { getCustomServices } from './customServices'

// Unavailability cache — skip polling a service after it fails. Persisted to
// sessionStorage so the cooldown survives hard page navigations within a tab
// (otherwise every full reload re-polls every dead service before the in-memory
// cache can save us). sessionStorage is right here, not localStorage: a new tab
// (potentially after the user fixes the missing service) starts with fresh state.
const STORAGE_KEY = 'quox-service-unavailable-until'

function loadUnavailabilityCache() {
  if (typeof window === 'undefined' || !window.sessionStorage) return {}
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveUnavailabilityCache(cache) {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    /* quota or disabled — best-effort */
  }
}

const _serviceUnavailableUntil = loadUnavailabilityCache()
const SERVICE_COOLDOWN_MS = 30 * 1000               // 30s — retry quickly after transient failures
const SERVICE_COOLDOWN_LONG_MS = 30 * 60 * 1000    // 30 min for 502 (container not deployed)
const FILES_SERVICE_BASE_URL = import.meta.env.DEV ? '/files-api' : '/files'

function hasConfiguredBastion() {
  if (import.meta.env.VITE_BASTION_ENABLED === 'true') return true
  if (import.meta.env.VITE_BASTION_URL) return true
  if (typeof window === 'undefined' || !window.localStorage) return false

  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || (!key.endsWith('_bastion-config') && key !== 'quox-bastion-config')) {
        continue
      }
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const config = JSON.parse(raw)
      if (config?.backendUrl || config?.apiToken || config?.credential_id) {
        return true
      }
    }
  } catch {
    return false
  }

  return false
}

function isOptionalServiceInstalled(serviceKey) {
  if (serviceKey === 'bastion') {
    return hasConfiguredBastion()
  }
  return true
}

// Core service definitions with their required endpoints
const CORE_SERVICES = {
  quoxagent: {
    name: 'QuoxAgent',
    description: 'Fleet management agent',
    // FALSE-NEGATIVE FIX: nginx has no /quoxagent-agent/ location — it falls
    // through to the SPA catch-all (200 index.html), so this never actually
    // reached the agent. The real proxy path is /mha-agent/ (see nginx.conf).
    baseUrl: '/mha-agent',
    port: 9847,
    healthEndpoint: '/health',
    requiredEndpoints: [
      { path: '/api/v1/status', method: 'GET', description: 'Agent status' },
      { path: '/api/v1/plugins', method: 'GET', description: 'Plugin management' },
      { path: '/api/v1/license', method: 'GET', description: 'License status' },
      { path: '/api/v1/jobs', method: 'GET', description: 'Job listing' },
    ],
    critical: true,
    // The per-host MHA agent is opt-in — many dev/non-managed boxes never
    // install it. nginx proxies /mha-agent/ to the host network gateway
    // (172.18.0.1:9847); if nothing's listening there, nginx itself returns
    // a real 502, which is a definitive "not deployed here" signal (as
    // opposed to a network-level fetch failure, which means "misconfigured
    // proxy"). Treat that 502 as absent/not-configured, not down.
    absentOn502: true,
    docsUrl: '/docs/QuoxAgent'
  },
  collector: {
    name: 'Collector',
    description: 'Fleet heartbeat aggregator',
    baseUrl: '/collector',
    port: 9848,
    healthEndpoint: '/health',
    requiredEndpoints: [
      { path: '/api/v1/fleet/status', method: 'GET', description: 'Fleet status' },
    ],
    critical: true,
    docsUrl: '/docs/QuoxAgent#collector-api'
  },
  auth: {
    name: 'Auth Service',
    description: 'Authentication and authorization',
    baseUrl: '/api/auth',
    port: 3101,
    healthEndpoint: null, // Liveness inferred from /me endpoint (expectError: authentication_required)
    requiredEndpoints: [
      { path: '/me', method: 'GET', description: 'User profile', expectError: 'authentication_required' },
    ],
    critical: true,
    docsUrl: '/docs/auth-service'
  },
  qdrant: {
    name: 'Qdrant',
    description: 'Vector database for semantic search',
    baseUrl: '/qdrant',
    port: 6333,
    healthEndpoint: '/',
    requiredEndpoints: [],
    critical: false,
    docsUrl: '/docs/memory#qdrant-configuration'
  },
  orchestrator: {
    name: 'Orchestrator',
    description: 'Container lifecycle management',
    baseUrl: '/orchestrator',
    port: 3100,
    healthEndpoint: '/health',
    requiredEndpoints: [],
    critical: false,
    docsUrl: '/docs/docker-containment'
  },
  nginx: {
    name: 'Nginx',
    description: 'Reverse proxy & TLS termination',
    baseUrl: '',
    port: 443,
    healthEndpoint: null, // Check via page load success
    requiredEndpoints: [],
    critical: true,
    docsUrl: '/docs/setup#reverse-proxy'
  },
  memory: {
    name: 'Memory Service',
    description: 'Server-side memory persistence',
    // FALSE-NEGATIVE FIX: nginx only proxies memory at /api/memory/ — a
    // bare /memory/ location doesn't exist and falls through to the SPA
    // catch-all (200 index.html), masking real memory-service outages.
    baseUrl: '/api/memory',
    port: 3103,
    healthEndpoint: '/health',
    requiredEndpoints: [],
    critical: false,
    docsUrl: '/docs/memory'
  },
  files: {
    name: 'File Service',
    description: 'File storage and operations',
    baseUrl: FILES_SERVICE_BASE_URL,
    port: 3102,
    healthEndpoint: '/health',
    requiredEndpoints: [],
    critical: false,
    docsUrl: '/docs/files'
  },
  postgres: {
    name: 'PostgreSQL',
    description: 'Relational database for QuoxFlow',
    baseUrl: null,
    port: 5432,
    healthEndpoint: null,
    requiredEndpoints: [],
    critical: true,
    docsUrl: '/docs/quoxflow#database',
    tcpOnly: true
  },
  bastion: {
    name: 'QuoxBastion',
    description: 'SSH gateway & secure access',
    baseUrl: '/bastion',
    port: 9850,
    healthEndpoint: '/api/v1/health',
    requiredEndpoints: [],
    critical: false,
    optional: true,
    docsUrl: '/docs/bastion'
  },
  quoxflow: {
    name: 'QuoxFlow',
    description: 'Auditable workflow engine',
    baseUrl: '/quoxflow',
    port: 3200,
    healthEndpoint: '/health',
    requiredEndpoints: [
      { path: '/api/workflows', method: 'GET', description: 'Workflow management' },
      { path: '/api/executions', method: 'GET', description: 'Execution tracking' },
    ],
    critical: false,
    docsUrl: '/docs/quoxflow'
  }
}

/**
 * Get all services (core + custom)
 */
function getAllServices() {
  const customServices = getCustomServices()
  return { ...CORE_SERVICES, ...customServices }
}

/**
 * Check if a single endpoint is accessible
 */
async function checkEndpoint(baseUrl, endpoint, timeout = 8000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const url = `${baseUrl}${endpoint.path}`
    const res = await fetch(url, {
      method: endpoint.method || 'GET',
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    // Some endpoints return errors intentionally (like /me without auth)
    if (endpoint.expectError) {
      const data = await res.json().catch(() => ({}))
      if (data.error === endpoint.expectError) {
        return { ok: true, status: res.status, expected: true }
      }
    }

    // Auth-gated endpoints (401/403) are responding — not broken
    if (res.status === 401 || res.status === 403) {
      return { ok: true, status: res.status, authGated: true }
    }

    return { ok: res.ok, status: res.status }
  } catch (err) {
    clearTimeout(timeoutId)
    return { ok: false, error: err.message }
  }
}

// CLARITY-1: services whose requiredEndpoints hit auth-gated APIs (401 when
// no session cookie is present). Probing these while unauthenticated is pure
// console/network noise on the login page — the endpoints exist and will be
// checked properly once the user is signed in.
const AUTH_GATED_REQUIRED_ENDPOINT_SERVICES = new Set(['quoxflow', 'quoxagent'])

/**
 * Check health of a single service
 *
 * @param {string} serviceKey
 * @param {Object} [opts]
 * @param {boolean} [opts.authenticated=true] - When false, skip the
 *   requiredEndpoints probes for services known to need an authenticated
 *   session (quoxflow, quoxagent). Health-endpoint pings still run so the
 *   service is still reported as up/down — only the auth-gated endpoint
 *   checks are suppressed.
 */
export async function checkService(serviceKey, opts = {}) {
  const { authenticated = true } = opts
  const services = getAllServices()
  const service = services[serviceKey]
  if (!service) {
    return { error: `Unknown service: ${serviceKey}` }
  }

  const result = {
    key: serviceKey,
    name: service.name,
    description: service.description,
    port: service.port,
    critical: service.critical,
    docsUrl: service.docsUrl || null,
    healthy: false,
    responding: false,
    responseTime: null,
    version: null,
    uptime: null,
    endpoints: {},
    missingEndpoints: [],
    error: null,
    checkedAt: new Date().toISOString(),
    optional: Boolean(service.optional),
    installed: true
  }

  if (service.optional && !isOptionalServiceInstalled(serviceKey)) {
    result.responding = true
    result.healthy = true
    result.installed = false
    result.optionalState = 'absent'
    result.error = null
    return result
  }

  // Skip polling if recently unavailable (cooldown).
  //
  // GTM-A1/B2e: this short-circuit probes NOTHING, yet it used to return a
  // bare responding:false that diagnoseIssues rendered as the present-tense
  // claim "Service not responding. Fix: Check if Collector is running on port
  // 9848". The cached verdict can be up to SERVICE_COOLDOWN_LONG_MS (30 min)
  // old. On 2026-09-16 the dashboard made exactly that claim about a collector
  // that was serving the page (GET /collector/health -> 200 healthy).
  //
  // "Not checked recently" is a weaker statement than "not responding", and
  // asserting the stronger one from a cache is the falsehood. Mark the reading
  // stale so downstream reporting can say what it actually knows.
  const cooldownUntil = _serviceUnavailableUntil[serviceKey] || 0
  if (Date.now() < cooldownUntil) {
    result.stale = true
    result.cachedUntil = new Date(cooldownUntil).toISOString()
    result.error = 'Status unknown: not re-checked since the last failure (cached)'
    return result
  }

  // Check main health endpoint with timing
  if (service.healthEndpoint) {
    const startTime = performance.now()
    try {
      const healthUrl = service.healthEndpoint.startsWith('/..')
        ? service.healthEndpoint.replace('/..', '')
        : `${service.baseUrl}${service.healthEndpoint}`

      // 12s, not 5s: the collector's /health handler is trivial (in-memory
      // counters) but its Node event loop can stall for ~4-5s under periodic
      // load, pushing this tiny response past a tight abort. A 5s timeout then
      // aborts, marks a CRITICAL service down, engages a 30s cooldown, and the
      // whole panel flaps green<->degraded. Health polling is not latency
      // sensitive (30s interval, run in parallel), so tolerate the stall.
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(12000) })
      const endTime = performance.now()
      result.responseTime = Math.round(endTime - startTime)

      if (res.ok) {
        result.responding = true
        const data = await res.json().catch(() => ({}))
        result.version = data.version || null
        result.uptime = data.uptime_seconds || data.uptime || null
        result.healthData = data
      } else if (res.status === 429) {
        // Rate-limited but responding — service is up
        result.responding = true
      } else if (res.status === 401 || res.status === 403) {
        // Auth-gated but responding (e.g. bastion requires token)
        result.responding = true
        result.error = 'Authentication required'
      } else if (res.status === 502 || res.status === 503) {
        // FALSE-NEGATIVE FIX: for a service explicitly flagged absentOn502
        // (e.g. the per-host MHA agent, which is opt-in — many boxes never
        // install it), a 502 from nginx means "nothing is listening on the
        // upstream", a definitive not-deployed-here signal. Render it as a
        // neutral "not configured" state — same treatment as bastion — so
        // it doesn't count as a real outage. Required services without that
        // flag keep the prior behavior (real degradation, long cooldown).
        if (service.absentOn502) {
          result.responding = true
          result.healthy = true
          result.installed = false
          result.optionalState = 'absent'
          result.error = null
          delete _serviceUnavailableUntil[serviceKey]
          saveUnavailabilityCache(_serviceUnavailableUntil)
          return result
        }
        // Container not deployed — use longer cooldown (30 min)
        result.error = `Service not deployed (HTTP ${res.status})`
        result._longCooldown = true
      }
    } catch (err) {
      const endTime = performance.now()
      result.responseTime = Math.round(endTime - startTime)
      result.error = err.message
      // Network-level failure (ERR_PROXY_CONNECTION_FAILED, ERR_CONNECTION_REFUSED,
      // ERR_NAME_NOT_RESOLVED) means the service isn't routed in this environment.
      // Treat as "not deployed" — long cooldown — otherwise the 30s short cooldown
      // races against the 30s poll interval and we spam the console on every page
      // navigation (HealthProvider re-mounts and re-polls). Timeouts get the short
      // cooldown since a slow service may recover quickly.
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
      if (!isTimeout) {
        result._longCooldown = true
        // Persist the cooldown NOW, not at function exit. checkService still has
        // to await ~4 × 5s endpoint timeouts before reaching the existing cache
        // write at the bottom — long enough that a fast page navigation
        // (clarity-mcp route walk, user clicking a link) abandons the in-flight
        // promise and the cache write never runs. The console then spams these
        // endpoints again on the next page load. Writing here makes the
        // cooldown survive even if the rest of checkService is abandoned.
        _serviceUnavailableUntil[serviceKey] = Date.now() + SERVICE_COOLDOWN_LONG_MS
        saveUnavailabilityCache(_serviceUnavailableUntil)
      }
    }
  } else {
    // No health endpoint - assume responding if we can reach any endpoint
    result.responding = true
    result.responseTime = 0
  }

  // CLARITY-1: skip auth-gated requiredEndpoints probes entirely when the
  // caller tells us the user isn't authenticated yet (e.g. login page).
  const skipRequiredEndpoints = !authenticated && AUTH_GATED_REQUIRED_ENDPOINT_SERVICES.has(serviceKey)

  // Check required endpoints. The moment one fails, persist a long cooldown
  // and bail — otherwise a fast page navigation aborts the remaining fetches
  // and they appear as ERR_ABORTED in the network panel, polluting the
  // console on every navigation. Bailing early caps the noise at one
  // failed-endpoint per service per cooldown window.
  for (const endpoint of (skipRequiredEndpoints ? [] : service.requiredEndpoints)) {
    const check = await checkEndpoint(service.baseUrl, endpoint)
    result.endpoints[endpoint.path] = {
      ...endpoint,
      ...check
    }

    if (!check.ok && !check.expected) {
      result.missingEndpoints.push(endpoint.path)
      result._longCooldown = true
      _serviceUnavailableUntil[serviceKey] = Date.now() + SERVICE_COOLDOWN_LONG_MS
      saveUnavailabilityCache(_serviceUnavailableUntil)
      break
    }
  }

  // Service is healthy if responding AND all required endpoints work
  result.healthy = result.responding && result.missingEndpoints.length === 0

  // Cache unavailability to avoid spamming network requests. Trigger on
  // !healthy (not just !responding) so services that respond on /health but
  // have missing API endpoints — common when nginx serves SPA HTML as a
  // fallback for unrouted paths — also engage cooldown.
  if (!result.healthy) {
    const cooldown = result._longCooldown ? SERVICE_COOLDOWN_LONG_MS : SERVICE_COOLDOWN_MS
    _serviceUnavailableUntil[serviceKey] = Date.now() + cooldown
  } else {
    delete _serviceUnavailableUntil[serviceKey]
  }
  saveUnavailabilityCache(_serviceUnavailableUntil)

  return result
}

/**
 * Run health check on all services
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.authenticated=true] - Forwarded to checkService();
 *   set to false to suppress auth-gated requiredEndpoints probes (login page).
 */
export async function runFullHealthCheck(opts = {}) {
  const results = {}
  const allServices = getAllServices()
  const checks = Object.keys(allServices).map(async (key) => {
    results[key] = await checkService(key, opts)
  })

  await Promise.all(checks)

  // Calculate summary
  const services = Object.values(results)
  const installedServices = services.filter(s => s.installed !== false)
  const healthy = installedServices.filter(s => s.healthy).length
  const critical = installedServices.filter(s => s.critical)
  const criticalHealthy = critical.filter(s => s.healthy).length

  // GTM-A1/B2e: a critical service whose reading is stale is neither proven
  // healthy nor proven down. It stays out of `criticalHealthy` (we cannot
  // vouch for it) but it must not be announced as "CRITICAL down" either.
  // The counters keep their existing shape so callers deriving
  // `criticalTotal - criticalHealthy` are unaffected; only the claim changes.
  const criticalStale = critical.filter(s => s.stale).length
  const criticalDown = critical.length - criticalHealthy - criticalStale

  return {
    services: results,
    summary: {
      total: installedServices.length,
      healthy,
      unhealthy: installedServices.length - healthy,
      criticalTotal: critical.length,
      criticalHealthy,
      criticalUnhealthy: critical.length - criticalHealthy,
      criticalStale,
      criticalDown,
      allHealthy: healthy === installedServices.length,
      allCriticalHealthy: criticalHealthy === critical.length,
      message: `${healthy}/${installedServices.length} services healthy` +
        (criticalDown > 0 ? ` (${criticalDown} CRITICAL down)` : '') +
        (criticalStale > 0 ? ` (${criticalStale} CRITICAL status unknown)` : '')
    },
    timestamp: new Date().toISOString()
  }
}

/**
 * Get simple status for a service (for quick checks)
 */
export async function getServiceStatus(serviceKey) {
  const result = await checkService(serviceKey)
  return {
    healthy: result.healthy,
    responding: result.responding,
    version: result.version,
    error: result.error,
    missingEndpoints: result.missingEndpoints
  }
}

/**
 * Check if QuoxAgent has plugin support (common check)
 */
export async function hasQuoxAgentPluginSupport() {
  const quoxagent = await checkService('quoxagent')
  return quoxagent.healthy && !quoxagent.missingEndpoints.includes('/api/v1/plugins')
}

/**
 * Get human-readable diagnosis for issues
 */
export function diagnoseIssues(healthResult) {
  const issues = []

  for (const [key, service] of Object.entries(healthResult.services)) {
    if (service.installed === false && service.optional) continue

    // GTM-A1/B2e: a stale entry was never probed this cycle. Report the gap in
    // knowledge, not an outage: claiming "not responding" and telling the owner
    // to go restart a healthy service is a false alarm, and on an
    // evidence-and-governance product a provably wrong red alert costs more
    // credibility than it buys caution.
    if (service.stale) {
      issues.push({
        severity: 'warning',
        service: service.name,
        issue: 'Status unknown (not re-checked since the last failure)',
        fix: `Re-run the health check to get a current answer for ${service.name}.`
      })
      continue
    }

    if (!service.responding) {
      issues.push({
        severity: service.critical ? 'critical' : 'warning',
        service: service.name,
        issue: 'Service not responding',
        fix: `Check if ${service.name} is running on port ${service.port}`
      })
    } else if (service.missingEndpoints.length > 0) {
      issues.push({
        severity: 'error',
        service: service.name,
        issue: `Missing endpoints: ${service.missingEndpoints.join(', ')}`,
        fix: `The ${service.name} binary may be outdated. Rebuild and redeploy.`
      })
    }
  }

  return issues
}

/**
 * Reset the internal unavailability cache. Used by tests.
 */
export function resetHealthCache() {
  for (const key of Object.keys(_serviceUnavailableUntil)) {
    delete _serviceUnavailableUntil[key]
  }
  saveUnavailabilityCache(_serviceUnavailableUntil)
}

export { CORE_SERVICES, CORE_SERVICES as SERVICES, getAllServices }
export default { runFullHealthCheck, checkService, getServiceStatus, hasQuoxAgentPluginSupport, diagnoseIssues, getAllServices, resetHealthCache }
