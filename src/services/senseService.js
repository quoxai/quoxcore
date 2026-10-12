/**
 * QuoxSense Service — Perceptual Substrate
 *
 * Inspired by the sensory cortex. Aggregates operational signals from
 * multiple sources into structured observations.
 *
 * Stream QMB Phase QMB-2.
 *
 * Signal sources:
 * - Service health checks (healthCheck.js)
 * - Guardian metrics (task service /api/engine/health)
 * - Memory activity (recent memory operations)
 * - WSM state changes (working set mutations)
 *
 * Future expansion:
 * - Webhook signal intake
 * - Telemetry stream processing
 * - Infrastructure event subscriptions
 */

import { runFullHealthCheck } from './healthCheck.js'

// ── Signal Log ─────────────────────────────────────────────────────
// Rolling buffer of recent signals for rate calculation and history.
// Kept in memory — not persisted. Resets on page reload.

const SIGNAL_BUFFER_SIZE = 200
const SIGNAL_WINDOW_MS = 60000  // 1 minute window for rate calculation

const signalLog = []
let signalIdCounter = 0

/**
 * Record a signal (observation).
 * Called by other services when something noteworthy happens.
 *
 * @param {string} source — which service/system generated the signal
 * @param {string} type — signal category (health, memory, execution, agent, error)
 * @param {string} summary — human-readable description
 * @param {Object} [data] — structured payload
 */
export function recordSignal(source, type, summary, data = null) {
  signalIdCounter++
  const signal = {
    id: signalIdCounter,
    source,
    type,
    summary,
    data,
    timestamp: Date.now(),
  }

  signalLog.push(signal)

  // Trim buffer
  if (signalLog.length > SIGNAL_BUFFER_SIZE) {
    signalLog.splice(0, signalLog.length - SIGNAL_BUFFER_SIZE)
  }

  return signal
}

/**
 * Get signals from the last N milliseconds.
 * @param {number} windowMs — time window (default: 1 minute)
 * @returns {Array} signals within the window
 */
export function getRecentSignals(windowMs = SIGNAL_WINDOW_MS) {
  const cutoff = Date.now() - windowMs
  return signalLog.filter(s => s.timestamp >= cutoff)
}

/**
 * Get signal rate (signals per minute).
 * @returns {number} rate
 */
export function getSignalRate() {
  const recent = getRecentSignals(SIGNAL_WINDOW_MS)
  return recent.length  // signals in last 60 seconds = signals per minute
}

/**
 * Get signal count in the last N hours.
 * @param {number} hours — default 24
 * @returns {number}
 */
export function getSignalCount(hours = 24) {
  const cutoff = Date.now() - (hours * 3600000)
  return signalLog.filter(s => s.timestamp >= cutoff).length
}

/**
 * Get signal breakdown by type.
 * @returns {Object} { health: N, memory: N, execution: N, agent: N, error: N }
 */
export function getSignalBreakdown() {
  const breakdown = {}
  for (const signal of signalLog) {
    breakdown[signal.type] = (breakdown[signal.type] || 0) + 1
  }
  return breakdown
}

// ── Health Check Integration ───────────────────────────────────────
// Periodically sample health checks and record as signals.

let lastHealthSnapshot = null

/**
 * Run a health perception cycle.
 * Compares current health to previous snapshot, generates signals for changes.
 * Called by the cognitive data cache refresh cycle.
 */
export async function perceiveHealthChanges() {
  try {
    const health = await runFullHealthCheck()
    if (!health?.services) return

    const current = {}
    for (const [name, data] of Object.entries(health.services)) {
      current[name] = data.healthy === true
    }

    if (lastHealthSnapshot) {
      // Detect changes
      for (const [name, isHealthy] of Object.entries(current)) {
        const wasHealthy = lastHealthSnapshot[name]
        if (wasHealthy !== undefined && wasHealthy !== isHealthy) {
          if (!isHealthy) {
            recordSignal('health', 'health', `Service "${name}" went unhealthy`, { service: name, change: 'degraded' })
          } else {
            recordSignal('health', 'health', `Service "${name}" recovered`, { service: name, change: 'recovered' })
          }
        }
      }

      // Detect new services
      for (const name of Object.keys(current)) {
        if (lastHealthSnapshot[name] === undefined) {
          recordSignal('health', 'health', `New service detected: "${name}"`, { service: name, change: 'discovered' })
        }
      }
    }

    lastHealthSnapshot = current
    return current
  } catch (err) {
    recordSignal('health', 'error', `Health check failed: ${err.message}`, { error: err.message })
    return null
  }
}

// ── Sense Stats (for implant data fetcher) ─────────────────────────

/**
 * Get QuoxSense implant metrics.
 * Called by cognitiveTopologyService.fetchAllImplantData().
 */
export async function getSenseStats() {
  // Run a perception cycle
  const healthState = await perceiveHealthChanges()

  const activeServices = healthState
    ? Object.values(healthState).filter(Boolean).length
    : 0
  const totalServices = healthState
    ? Object.keys(healthState).length
    : 0

  const signalCount = getSignalCount(24)
  const eventRate = getSignalRate()
  const breakdown = getSignalBreakdown()

  // Health score: based on service health + signal freshness
  const serviceHealth = totalServices > 0
    ? Math.round((activeServices / totalServices) * 100)
    : 0

  // Bonus for active signal flow (system is being observed)
  const signalBonus = signalCount > 0 ? Math.min(20, signalCount) : 0
  const overallHealth = Math.min(100, serviceHealth + signalBonus)

  return {
    overallHealth,
    activeServices,
    totalServices,
    status: serviceHealth >= 90 ? 'operational' :
            serviceHealth >= 50 ? 'degraded' : 'critical',
    signalCount,
    eventRate,
    breakdown,
    serviceDetails: healthState ? Object.entries(healthState).map(([name, healthy]) => ({
      name,
      healthy,
      status: healthy ? 'healthy' : 'unhealthy',
    })) : [],
  }
}
