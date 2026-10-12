/**
 * Service History Tracker
 *
 * Tracks service health check history in localStorage for:
 * - 24-hour uptime percentage calculation
 * - Response time trends
 * - Status change detection and notifications
 *
 * Usage:
 *   import { recordHealthCheck, getServiceUptime, getStatusChanges } from './serviceHistory'
 *
 *   // After each health check
 *   const changes = recordHealthCheck(healthResult)
 *   if (changes.length > 0) {
 *     // Services changed state
 *   }
 */

const HISTORY_KEY = 'quox_service_history'
const MAX_HISTORY_HOURS = 24
const MAX_ENTRIES_PER_SERVICE = 2880 // 24 hours at 30-second intervals

/**
 * Get stored history from localStorage
 */
function getHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Save history to localStorage
 */
function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch (err) {
    console.warn('Failed to save service history:', err)
  }
}

/**
 * Prune old entries from history
 */
function pruneHistory(history) {
  const cutoff = Date.now() - (MAX_HISTORY_HOURS * 60 * 60 * 1000)

  for (const serviceKey of Object.keys(history)) {
    if (history[serviceKey].checks) {
      history[serviceKey].checks = history[serviceKey].checks
        .filter(check => check.timestamp > cutoff)
        .slice(-MAX_ENTRIES_PER_SERVICE)
    }
  }

  return history
}

/**
 * Record a health check result for all services
 * Returns array of status changes
 */
export function recordHealthCheck(healthResult) {
  const history = getHistory()
  const changes = []
  const timestamp = Date.now()

  for (const [serviceKey, service] of Object.entries(healthResult.services)) {
    // Initialize service history if needed
    if (!history[serviceKey]) {
      history[serviceKey] = {
        checks: [],
        lastStatus: null,
        lastStatusChange: null
      }
    }

    const serviceHistory = history[serviceKey]
    const previousStatus = serviceHistory.lastStatus
    const currentStatus = service.healthy ? 'healthy' :
                         service.responding ? 'degraded' : 'down'

    // Record this check
    serviceHistory.checks.push({
      timestamp,
      status: currentStatus,
      responseTime: service.responseTime,
      healthy: service.healthy,
      responding: service.responding
    })

    // Detect status change
    if (previousStatus !== null && previousStatus !== currentStatus) {
      changes.push({
        serviceKey,
        serviceName: service.name,
        previousStatus,
        currentStatus,
        timestamp,
        critical: service.critical
      })
      serviceHistory.lastStatusChange = timestamp
    }

    serviceHistory.lastStatus = currentStatus
  }

  // Prune and save
  saveHistory(pruneHistory(history))

  return changes
}

/**
 * Get uptime percentage for a service over the last N hours
 */
export function getServiceUptime(serviceKey, hours = 24) {
  const history = getHistory()
  const serviceHistory = history[serviceKey]

  if (!serviceHistory?.checks?.length) {
    return null
  }

  const cutoff = Date.now() - (hours * 60 * 60 * 1000)
  const relevantChecks = serviceHistory.checks.filter(c => c.timestamp > cutoff)

  if (relevantChecks.length === 0) {
    return null
  }

  const healthyChecks = relevantChecks.filter(c => c.healthy).length
  return Math.round((healthyChecks / relevantChecks.length) * 1000) / 10 // One decimal
}

/**
 * Get average response time for a service over the last N hours
 */
export function getAverageResponseTime(serviceKey, hours = 1) {
  const history = getHistory()
  const serviceHistory = history[serviceKey]

  if (!serviceHistory?.checks?.length) {
    return null
  }

  const cutoff = Date.now() - (hours * 60 * 60 * 1000)
  const relevantChecks = serviceHistory.checks
    .filter(c => c.timestamp > cutoff && c.responseTime !== null)

  if (relevantChecks.length === 0) {
    return null
  }

  const total = relevantChecks.reduce((sum, c) => sum + c.responseTime, 0)
  return Math.round(total / relevantChecks.length)
}

/**
 * Get response time trend data for sparkline (last N checks)
 */
export function getResponseTimeTrend(serviceKey, count = 20) {
  const history = getHistory()
  const serviceHistory = history[serviceKey]

  if (!serviceHistory?.checks?.length) {
    return []
  }

  return serviceHistory.checks
    .slice(-count)
    .map(c => ({
      time: c.timestamp,
      value: c.responseTime || 0,
      status: c.status
    }))
}

/**
 * Get status history for a service (for timeline display)
 */
export function getStatusHistory(serviceKey, hours = 24) {
  const history = getHistory()
  const serviceHistory = history[serviceKey]

  if (!serviceHistory?.checks?.length) {
    return []
  }

  const cutoff = Date.now() - (hours * 60 * 60 * 1000)
  return serviceHistory.checks
    .filter(c => c.timestamp > cutoff)
    .map(c => ({
      timestamp: c.timestamp,
      status: c.status,
      responseTime: c.responseTime
    }))
}

/**
 * Get last status change time for a service
 */
export function getLastStatusChange(serviceKey) {
  const history = getHistory()
  return history[serviceKey]?.lastStatusChange || null
}

/**
 * Get all recent status changes (across all services)
 */
export function getRecentStatusChanges(hours = 24) {
  const history = getHistory()
  const cutoff = Date.now() - (hours * 60 * 60 * 1000)
  const changes = []

  for (const [serviceKey, serviceHistory] of Object.entries(history)) {
    if (!serviceHistory.checks || serviceHistory.checks.length < 2) continue

    let previousStatus = null
    for (const check of serviceHistory.checks) {
      if (check.timestamp < cutoff) {
        previousStatus = check.status
        continue
      }

      if (previousStatus !== null && previousStatus !== check.status) {
        changes.push({
          serviceKey,
          timestamp: check.timestamp,
          from: previousStatus,
          to: check.status
        })
      }
      previousStatus = check.status
    }
  }

  return changes.sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * Get uptime data for all services
 */
export function getAllServiceUptimes(hours = 24) {
  const history = getHistory()
  const uptimes = {}

  for (const serviceKey of Object.keys(history)) {
    uptimes[serviceKey] = {
      uptime: getServiceUptime(serviceKey, hours),
      avgResponseTime: getAverageResponseTime(serviceKey, 1),
      lastChange: getLastStatusChange(serviceKey)
    }
  }

  return uptimes
}

/**
 * Clear all history (for debugging/reset)
 */
export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY)
}

export default {
  recordHealthCheck,
  getServiceUptime,
  getAverageResponseTime,
  getResponseTimeTrend,
  getStatusHistory,
  getLastStatusChange,
  getRecentStatusChanges,
  getAllServiceUptimes,
  clearHistory
}
