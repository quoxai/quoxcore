/**
 * RepoBrain Metrics: fetches stats from the RepoBrain API.
 *
 * Proxied through collector: /collector/api/v1/nucleus → repobrain:3105/api
 * Endpoints used:
 *   GET /targets       — list indexed repos with file counts
 *   GET /cache/stats   — cache hit rate (optional, graceful fallback)
 *   GET /health        — health info (optional, graceful fallback)
 */

const REPOBRAIN_API = '/collector/api/v1/nucleus'
const TIMEOUT_MS = 3000

/**
 * Fetch with timeout — resolves to null on failure/timeout.
 */
async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

// QMH-5/1: failureReason carries through to mirrorIndex.deriveImplantStatus
// so the topology card surfaces "⚠ Service unreachable: repobrain" instead
// of the legacy "DOWN" badge.
const OFFLINE_RESULT = {
  healthScore: null,
  status: 'offline',
  failureReason: { code: 'SERVICE_UNREACHABLE', service: 'repobrain', message: 'RepoBrain API unreachable' },
  indexedFiles: 0,
  repoCount: 0,
  connections: 0,    // QMH-2: real graph-edge count requires a RepoBrain
                     // /graph/stats endpoint that does not exist yet. Until
                     // it does, this stays 0 — never a fabricated number.
  cacheHitRate: 0,
  avgQueryMs: 0,
  fallback: true,
}

/**
 * Get RepoBrain stats.
 * Never throws, returns offline fallback if VM is unreachable.
 */
export async function getNucleusStats() {
  try {
    const [targets, cacheStats, health] = await Promise.all([
      fetchWithTimeout(`${REPOBRAIN_API}/targets`),
      fetchWithTimeout(`${REPOBRAIN_API}/cache/stats`),
      fetchWithTimeout(`${REPOBRAIN_API}/health`),
    ])

    // If we can't even get targets, we're offline
    if (!targets) return OFFLINE_RESULT

    // Count repos and indexed files from targets response
    const repos = Array.isArray(targets) ? targets : (targets.targets || [])
    const repoCount = repos.length
    const indexedFiles = repos.reduce((sum, r) => sum + (r.file_count || r.fileCount || r.files || 0), 0)

    // Cache hit rate (optional endpoint)
    let cacheHitRate = 0
    if (cacheStats) {
      const hits = cacheStats.hits || 0
      const misses = cacheStats.misses || 0
      const total = hits + misses
      cacheHitRate = total > 0 ? Math.round((hits / total) * 100) : 0
    }

    // Avg query time from health endpoint (optional)
    const avgQueryMs = health?.avg_query_ms || health?.avgQueryMs || 0

    // Note: import-graph connection count would come from a RepoBrain
    // /graph/stats endpoint that does not exist yet. The result object
    // surfaces 0 for that field rather than a fabricated value.

    // Health score: 100 = all repos indexed and fresh
    let healthScore = 0
    if (repoCount > 0) {
      healthScore += 40 // Base: repos are indexed
      healthScore += Math.min(30, repoCount * 5) // More repos = better (up to 30)
      healthScore += indexedFiles > 100 ? 20 : Math.min(20, Math.round((indexedFiles / 100) * 20))
      if (cacheHitRate > 50) healthScore += 10
    }
    healthScore = Math.min(100, healthScore)

    // Determine status
    let status = 'offline'
    if (healthScore > 80) status = 'healthy'
    else if (healthScore > 30) status = 'degraded'
    else if (healthScore > 0) status = 'minimal'

    return {
      healthScore,
      status,
      indexedFiles,
      repoCount,
      connections: 0,
      cacheHitRate,
      avgQueryMs,
    }
  } catch {
    return OFFLINE_RESULT
  }
}
