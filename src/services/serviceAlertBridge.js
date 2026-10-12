/**
 * Service Alert Bridge
 *
 * Bridges health check alerts from the local alertService to the server-side
 * HITL inbox. When a service goes degraded/down and an alert rule fires,
 * this module POSTs an inbox item so the alert persists across sessions.
 *
 * Deduplication: Each serviceKey+ruleId combo has a 5-minute cooldown
 * to prevent flooding the inbox on repeated 30s health polls.
 *
 * Usage:
 *   import { bridgeAlertsToInbox } from './serviceAlertBridge'
 *
 *   // After evaluateAlerts() in the health check flow
 *   const alerts = evaluateAlerts(healthData)
 *   bridgeAlertsToInbox(alerts, { authFetch, orgId })
 */

// Deduplication: track recently bridged alerts
// Key: "serviceKey:ruleId" → timestamp of last bridge
const recentlyBridged = new Map()

// 5-minute dedup window
const DEDUP_COOLDOWN_MS = 5 * 60 * 1000

// Map alert priorities to inbox priorities
const PRIORITY_MAP = {
  urgent: 'urgent',
  high: 'high',
  normal: 'normal',
  low: 'low'
}

/**
 * Check if an alert was recently bridged (within dedup window)
 */
function isDuplicate(serviceKey, ruleId) {
  const key = `${serviceKey}:${ruleId}`
  const lastBridged = recentlyBridged.get(key)
  if (!lastBridged) return false
  return (Date.now() - lastBridged) < DEDUP_COOLDOWN_MS
}

/**
 * Record that an alert was bridged
 */
function recordBridge(serviceKey, ruleId) {
  const key = `${serviceKey}:${ruleId}`
  recentlyBridged.set(key, Date.now())

  // Prune old entries to prevent memory leak
  if (recentlyBridged.size > 200) {
    const now = Date.now()
    for (const [k, ts] of recentlyBridged) {
      if (now - ts > DEDUP_COOLDOWN_MS) {
        recentlyBridged.delete(k)
      }
    }
  }
}

/**
 * Bridge triggered alerts to the server-side inbox
 *
 * @param {Array} alerts - Alerts from evaluateAlerts()
 * @param {Object} options
 * @param {Function} options.authFetch - Authenticated fetch from AuthContext
 * @param {string} options.orgId - Current organization ID
 * @returns {Promise<Array>} - Successfully bridged alerts
 */
export async function bridgeAlertsToInbox(alerts, { authFetch, orgId } = {}) {
  if (!alerts || alerts.length === 0) return []
  if (!authFetch || !orgId) {
    // Silently skip — auth not ready or no org context
    return []
  }

  const bridged = []

  for (const alert of alerts) {
    const serviceKey = alert.payload?.service_key
    const ruleId = alert.payload?.rule_id
    if (!serviceKey || !ruleId) continue

    // Dedup check
    if (isDuplicate(serviceKey, ruleId)) continue

    try {
      const inboxItem = {
        kind: 'incident',
        priority: PRIORITY_MAP[alert.priority] || 'normal',
        title: alert.title,
        body_md: alert.body_md,
        payload: {
          source: 'service_monitor',
          service_key: serviceKey,
          service_name: alert.payload?.service_name,
          service_status: alert.payload?.service_status,
          response_time: alert.payload?.response_time,
          rule_id: ruleId,
          rule_name: alert.payload?.rule_name,
          triggered_at: alert.payload?.triggered_at || new Date().toISOString()
        }
      }

      await authFetch(`/api/orgs/${orgId}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inboxItem)
      })

      recordBridge(serviceKey, ruleId)
      bridged.push(alert)
    } catch (err) {
      // Don't let inbox failures break the health check flow
      console.warn(`[AlertBridge] Failed to bridge alert for ${serviceKey}:`, err.message || err)
    }
  }

  return bridged
}

/**
 * Auto-resolve server-side inbox alerts for recovered services.
 * Called after evaluateAlerts detects healthy services with open alerts.
 *
 * @param {string[]} healthyServiceKeys - Service keys that are now healthy
 * @param {Object} options
 * @param {Function} options.authFetch - Authenticated fetch from AuthContext
 * @param {string} options.orgId - Current organization ID
 */
export async function bridgeResolutionsToInbox(healthyServiceKeys, { authFetch, orgId } = {}) {
  if (!healthyServiceKeys || healthyServiceKeys.length === 0) return
  if (!authFetch || !orgId) return

  try {
    // P0b step 6a: the internal auto-resolve route is service-key gated now
    // (and was never reachable in prod anyway — nginx 404s /api/internal).
    // This authenticated org-scoped route is the real home.
    await authFetch(`/api/orgs/${orgId}/inbox/auto-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_keys: healthyServiceKeys })
    })
  } catch (err) {
    // Best effort — don't break the health check flow
    console.warn('[AlertBridge] Failed to auto-resolve server alerts:', err.message || err)
  }
}

/**
 * Clear dedup state (for testing)
 */
export function clearBridgeState() {
  recentlyBridged.clear()
}

/**
 * Get current dedup state size (for testing/debugging)
 */
export function getBridgeStateSize() {
  return recentlyBridged.size
}

export default { bridgeAlertsToInbox, bridgeResolutionsToInbox, clearBridgeState, getBridgeStateSize }
