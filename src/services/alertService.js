/**
 * Alert Service
 *
 * Evaluates alert rules against service health data and generates
 * inbox items when conditions are met.
 *
 * Usage:
 *   import { evaluateAlerts } from './alertService'
 *
 *   // After each health check
 *   const alerts = evaluateAlerts(healthData)
 *   // alerts are automatically sent to inbox
 */

import { getAlertRules, isInCooldown, recordAlert, getAlertState, saveAlertState } from './alertRules'
import { getServiceUptime } from './serviceHistory'
import { getService } from '../config/serviceRegistry'
import { sendNotification, isCoreCommsActive } from './coreCommsService'
import { getMemoryClient } from './memoryClient'

// TRUST-GATE-1.16: identity-blob write-through so alert history (incl.
// resolution state) survives a fresh browser/device, not just localStorage.
const memoryClient = getMemoryClient()
const ALERTS_NAMESPACE = 'alerts'

/**
 * Write-through cache: localStorage stays the fast synchronous read path;
 * the memory service becomes the authoritative durable copy. Fire-and-forget
 * — failures are logged, never thrown, so callers' existing sync contracts
 * are unaffected (mirrors memoryManager._identityWriteThrough, TRUST-GATE-1.15).
 */
function alertsWriteThrough(alerts) {
  try {
    memoryClient.setIdentity(ALERTS_NAMESPACE, alerts).catch(err => {
      console.warn('[AlertService] Alert write-through failed:', err.message)
    })
  } catch (err) {
    console.warn('[AlertService] Alert write-through error:', err.message)
  }
}

let _alertsHydrated = false

/**
 * Hydrate quox_pending_alerts from the memory service on a fresh browser
 * (empty localStorage). Best-effort: failures are logged and swallowed so a
 * down/unreachable memory service never blocks alert evaluation.
 * TRUST-GATE-1.16.
 */
export async function hydrateAlertsFromServer() {
  if (_alertsHydrated) return
  _alertsHydrated = true
  try {
    if (localStorage.getItem('quox_pending_alerts')) return
    const result = await memoryClient.getIdentity(ALERTS_NAMESPACE)
    if (result && Array.isArray(result.data)) {
      localStorage.setItem('quox_pending_alerts', JSON.stringify(result.data))
    }
  } catch (err) {
    console.warn('[AlertService] Alert hydration failed:', err.message)
  }
}

// CLARITY-4: no module-load fire-and-forget call here. Calling this at
// import time runs regardless of auth state (including on the
// unauthenticated /login page) and produces expected-but-noisy 401s from
// the identity API. hydrateAlertsFromServer() is now triggered explicitly,
// once, from <AuthGatedBackgroundServices> (src/App.jsx) when a session
// becomes authenticated — same gating pattern CLARITY-1 applied to AEE sync
// and the ReflectionLoop. The function remains exported/callable for that
// caller (and for tests).

// Track condition durations
const DURATION_STATE_KEY = 'quox_alert_duration_state'

/**
 * Get duration tracking state
 */
function getDurationState() {
  try {
    const stored = localStorage.getItem(DURATION_STATE_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Save duration tracking state
 */
function saveDurationState(state) {
  try {
    localStorage.setItem(DURATION_STATE_KEY, JSON.stringify(state))
  } catch (err) {
    console.error('Failed to save duration state:', err)
  }
}

/**
 * Get service status from health data
 */
function getServiceStatus(service) {
  if (service.healthy) return 'healthy'
  if (service.responding) return 'degraded'
  return 'down'
}

/**
 * Check if a condition matches for a service
 */
function checkCondition(rule, serviceKey, service, healthData) {
  const { conditions } = rule
  const registry = getService(serviceKey)

  // Check criticalOnly filter
  if (conditions.criticalOnly && !service.critical) {
    return false
  }

  const status = getServiceStatus(service)

  switch (conditions.type) {
    case 'status':
      return status === conditions.status

    case 'response_time':
      return service.responseTime !== null && service.responseTime > conditions.threshold

    case 'uptime': {
      const uptime = getServiceUptime(serviceKey, conditions.hours || 24)
      return uptime !== null && uptime < conditions.threshold
    }

    case 'consecutive_failures': {
      const state = getDurationState()
      const key = `failures:${serviceKey}`
      const current = state[key] || 0

      if (status === 'down') {
        state[key] = current + 1
        saveDurationState(state)
        return state[key] >= conditions.count
      } else {
        // Reset on healthy
        if (current > 0) {
          state[key] = 0
          saveDurationState(state)
        }
        return false
      }
    }

    default:
      return false
  }
}

/**
 * Check if duration requirement is met
 */
function checkDuration(rule, serviceKey) {
  if (!rule.duration || rule.duration === 0) {
    return true // No duration requirement
  }

  const state = getDurationState()
  const key = `duration:${rule.id}:${serviceKey}`
  const startTime = state[key]

  if (!startTime) {
    // Start tracking
    state[key] = Date.now()
    saveDurationState(state)
    return false
  }

  const elapsed = Date.now() - startTime
  return elapsed >= rule.duration * 1000
}

/**
 * Clear duration tracking for a rule/service
 */
function clearDuration(ruleId, serviceKey) {
  const state = getDurationState()
  delete state[`duration:${ruleId}:${serviceKey}`]
  saveDurationState(state)
}

/**
 * Create an inbox item for an alert
 */
function createInboxItem(rule, serviceKey, service) {
  const registry = getService(serviceKey) || {}
  const status = getServiceStatus(service)

  const item = {
    id: `alert-${rule.id}-${serviceKey}-${Date.now()}`,
    kind: status === 'down' ? 'incident' : 'info',
    priority: rule.priority || 'normal',
    status: 'open',
    title: `${rule.name}: ${service.name || serviceKey}`,
    body_md: generateAlertBody(rule, serviceKey, service, registry),
    payload: {
      rule_id: rule.id,
      rule_name: rule.name,
      service_key: serviceKey,
      service_name: service.name,
      service_port: service.port,
      service_status: status,
      response_time: service.responseTime,
      triggered_at: new Date().toISOString(),
      conditions: rule.conditions
    },
    source: 'service_monitor',
    created_at: new Date().toISOString(),
    scope_type: 'org',
    requires_action: status === 'down'
  }

  return item
}

/**
 * Generate markdown body for alert
 */
function generateAlertBody(rule, serviceKey, service, registry) {
  const status = getServiceStatus(service)
  const statusEmoji = status === 'down' ? '🔴' : status === 'degraded' ? '🟡' : '🟢'

  let body = `## ${statusEmoji} ${service.name || serviceKey}\n\n`
  body += `**Status:** ${status.toUpperCase()}\n`
  body += `**Port:** ${service.port}\n`

  if (service.responseTime !== null) {
    body += `**Response Time:** ${service.responseTime}ms\n`
  }

  if (service.critical) {
    body += `**Critical Service:** Yes\n`
  }

  body += `\n### Alert Rule\n`
  body += `**Rule:** ${rule.name}\n`
  body += `**Description:** ${rule.description || 'No description'}\n`

  // Add troubleshooting tips if available
  if (registry.troubleshooting?.length > 0) {
    body += `\n### Troubleshooting\n`
    const tip = registry.troubleshooting[0]
    body += `**${tip.symptom}**\n\n`
    body += `Checks:\n`
    tip.checks.forEach(check => {
      body += `- \`${check}\`\n`
    })
    body += `\n**Solution:** \`${tip.solution}\`\n`
  }

  // Add documentation links
  if (registry.docs) {
    body += `\n### Documentation\n`
    if (registry.docs.configPath) body += `- Config: \`${registry.docs.configPath}\`\n`
    if (registry.docs.logsPath) body += `- Logs: \`${registry.docs.logsPath}\`\n`
    if (registry.docs.systemdService) body += `- Service: \`${registry.docs.systemdService}\`\n`
  }

  return body
}

/**
 * Get pending alerts from localStorage (for inbox display)
 */
export function getPendingAlerts() {
  try {
    const stored = localStorage.getItem('quox_pending_alerts')
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

/**
 * Save pending alert to localStorage
 */
function savePendingAlert(alert) {
  try {
    const alerts = getPendingAlerts()
    alerts.unshift(alert)
    // Keep last 100 alerts
    const trimmed = alerts.slice(0, 100)
    localStorage.setItem('quox_pending_alerts', JSON.stringify(trimmed))
    alertsWriteThrough(trimmed)
  } catch (err) {
    console.error('Failed to save pending alert:', err)
  }
}

/**
 * Resolve an alert
 */
export function resolveAlert(alertId) {
  try {
    const alerts = getPendingAlerts()
    const updated = alerts.map(a =>
      a.id === alertId ? { ...a, status: 'resolved', resolved_at: new Date().toISOString() } : a
    )
    localStorage.setItem('quox_pending_alerts', JSON.stringify(updated))
    alertsWriteThrough(updated)
    return true
  } catch {
    return false
  }
}

/**
 * Clear resolved alerts
 */
export function clearResolvedAlerts() {
  try {
    const alerts = getPendingAlerts()
    const active = alerts.filter(a => a.status !== 'resolved')
    localStorage.setItem('quox_pending_alerts', JSON.stringify(active))
    alertsWriteThrough(active)
    return true
  } catch {
    return false
  }
}

/**
 * Get alert statistics
 */
export function getAlertStats() {
  const alerts = getPendingAlerts()
  const now = Date.now()
  const oneHour = 60 * 60 * 1000
  const oneDay = 24 * oneHour

  return {
    total: alerts.length,
    open: alerts.filter(a => a.status === 'open').length,
    resolved: alerts.filter(a => a.status === 'resolved').length,
    lastHour: alerts.filter(a => now - new Date(a.created_at).getTime() < oneHour).length,
    lastDay: alerts.filter(a => now - new Date(a.created_at).getTime() < oneDay).length,
    byPriority: {
      urgent: alerts.filter(a => a.priority === 'urgent' && a.status === 'open').length,
      high: alerts.filter(a => a.priority === 'high' && a.status === 'open').length,
      normal: alerts.filter(a => a.priority === 'normal' && a.status === 'open').length,
      low: alerts.filter(a => a.priority === 'low' && a.status === 'open').length
    }
  }
}

// Mass outage suppression threshold — if this many services are down,
// emit one "Stack Outage" alert instead of per-service alerts
const MASS_OUTAGE_THRESHOLD = 3
const MASS_OUTAGE_COOLDOWN_KEY = 'quox_mass_outage_last'

/**
 * Auto-resolve open alerts for services that are now healthy.
 * Updates localStorage pending alerts and returns count resolved.
 */
function autoResolveHealthy(healthData) {
  const alerts = getPendingAlerts()
  let resolvedCount = 0
  const now = new Date().toISOString()

  const updated = alerts.map(a => {
    if (a.status !== 'open') return a
    const svcKey = a.payload?.service_key
    if (!svcKey) return a

    const service = healthData.services[svcKey]
    if (service && getServiceStatus(service) === 'healthy') {
      resolvedCount++
      return { ...a, status: 'resolved', resolved_at: now, auto_resolved: true }
    }
    return a
  })

  if (resolvedCount > 0) {
    try {
      localStorage.setItem('quox_pending_alerts', JSON.stringify(updated))
      alertsWriteThrough(updated)
    } catch (err) {
      console.error('Failed to auto-resolve alerts:', err)
    }
    console.log(`[Alert] Auto-resolved ${resolvedCount} alerts for recovered services`)
  }

  return resolvedCount
}

/**
 * Check if we're in a mass outage (many services down at once).
 * Returns list of down service keys, or empty if not a mass outage.
 */
function detectMassOutage(healthData) {
  const downServices = []
  for (const [key, service] of Object.entries(healthData.services)) {
    if (getServiceStatus(service) === 'down') {
      downServices.push(key)
    }
  }
  return downServices.length >= MASS_OUTAGE_THRESHOLD ? downServices : []
}

/**
 * Create a single mass-outage alert instead of per-service alerts
 */
function createMassOutageAlert(downServices, healthData) {
  const serviceNames = downServices.map(k => {
    const svc = healthData.services[k]
    return svc?.name || k
  })

  return {
    id: `alert-mass-outage-${Date.now()}`,
    kind: 'incident',
    priority: 'urgent',
    status: 'open',
    title: `Stack Outage: ${downServices.length} services down`,
    body_md: `## Stack Outage\n\n**${downServices.length} services are down simultaneously.** This is likely a single root cause (Docker restart, host reboot, network issue).\n\n### Affected Services\n${serviceNames.map(n => `- ${n}`).join('\n')}\n\n### Suggested Actions\n1. Check if Docker is running: \`docker ps\`\n2. Check host resources: \`free -h && df -h\`\n3. Restart the stack: \`docker compose up -d\``,
    payload: {
      rule_id: 'mass-outage',
      rule_name: 'Stack Outage',
      service_key: 'stack',
      service_status: 'down',
      affected_services: downServices,
      triggered_at: new Date().toISOString()
    },
    source: 'service_monitor',
    created_at: new Date().toISOString(),
    scope_type: 'org',
    requires_action: true
  }
}

/**
 * Evaluate all alert rules against current health data
 * Returns array of triggered alerts
 */
export function evaluateAlerts(healthData) {
  if (!healthData?.services) return []

  // Auto-resolve alerts for services that have recovered
  autoResolveHealthy(healthData)

  // Detect mass outage — suppress per-service alerts if stack is down
  const massOutageServices = detectMassOutage(healthData)
  if (massOutageServices.length > 0) {
    // Check mass-outage cooldown (30 min)
    try {
      const lastMassAlert = localStorage.getItem(MASS_OUTAGE_COOLDOWN_KEY)
      if (lastMassAlert && Date.now() - Number(lastMassAlert) < 1800000) {
        return [] // Still in mass-outage cooldown
      }
    } catch { /* proceed */ }

    const alert = createMassOutageAlert(massOutageServices, healthData)
    savePendingAlert(alert)
    try {
      localStorage.setItem(MASS_OUTAGE_COOLDOWN_KEY, String(Date.now()))
    } catch { /* best effort */ }

    if (isCoreCommsActive()) {
      sendNotification(alert).catch(err => {
        console.warn('[Alert] CoreComms notification failed:', err)
      })
    }

    console.log(`[Alert] Stack Outage: ${massOutageServices.length} services down (${massOutageServices.join(', ')})`)
    return [alert]
  }

  const rules = getAlertRules().filter(r => r.enabled)
  const triggeredAlerts = []

  for (const [serviceKey, service] of Object.entries(healthData.services)) {
    for (const rule of rules) {
      // Check if condition matches
      const conditionMet = checkCondition(rule, serviceKey, service, healthData)

      if (conditionMet) {
        // Check duration requirement
        const durationMet = checkDuration(rule, serviceKey)

        if (durationMet) {
          // Check cooldown
          if (!isInCooldown(rule.id, serviceKey)) {
            // Create and save alert
            const alert = createInboxItem(rule, serviceKey, service)
            savePendingAlert(alert)
            recordAlert(rule.id, serviceKey)
            triggeredAlerts.push(alert)

            // Send external notification via CoreComms (if active)
            if (isCoreCommsActive()) {
              sendNotification(alert).catch(err => {
                console.warn('[Alert] CoreComms notification failed:', err)
              })
            }

            console.log(`[Alert] ${rule.name} triggered for ${serviceKey}`)
          }
        }
      } else {
        // Condition no longer met - clear duration tracking
        clearDuration(rule.id, serviceKey)
      }
    }
  }

  return triggeredAlerts
}

/**
 * Check if any alerts are currently active for a service
 */
export function hasActiveAlerts(serviceKey) {
  const alerts = getPendingAlerts()
  return alerts.some(a =>
    a.payload?.service_key === serviceKey &&
    a.status === 'open'
  )
}

/**
 * Get active alerts for a specific service
 */
export function getServiceAlerts(serviceKey) {
  const alerts = getPendingAlerts()
  return alerts.filter(a =>
    a.payload?.service_key === serviceKey &&
    a.status === 'open'
  )
}

export default {
  evaluateAlerts,
  getPendingAlerts,
  resolveAlert,
  clearResolvedAlerts,
  getAlertStats,
  hasActiveAlerts,
  getServiceAlerts
}
