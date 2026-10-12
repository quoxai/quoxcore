/**
 * proxmoxAlertService — Evaluates Proxmox alert rules against VM metrics.
 *
 * Called after each data refresh in useProxmoxData. Generates HITL inbox
 * items when rules trigger. Tracks duration state and cooldowns.
 */

import { getProxmoxAlertRules } from './proxmoxAlertRules'

const DURATION_STATE_KEY = 'quox_proxmox_alert_durations'
const COOLDOWN_STATE_KEY = 'quox_proxmox_alert_cooldowns'
const PREV_STATUS_KEY = 'quox_proxmox_prev_status'

function getDurationState() {
  try {
    return JSON.parse(localStorage.getItem(DURATION_STATE_KEY) || '{}')
  } catch { return {} }
}

function saveDurationState(state) {
  try { localStorage.setItem(DURATION_STATE_KEY, JSON.stringify(state)) } catch { /* */ }
}

function getCooldownState() {
  try {
    return JSON.parse(localStorage.getItem(COOLDOWN_STATE_KEY) || '{}')
  } catch { return {} }
}

function saveCooldownState(state) {
  try { localStorage.setItem(COOLDOWN_STATE_KEY, JSON.stringify(state)) } catch { /* */ }
}

function getPrevStatus() {
  try {
    return JSON.parse(localStorage.getItem(PREV_STATUS_KEY) || '{}')
  } catch { return {} }
}

function savePrevStatus(state) {
  try { localStorage.setItem(PREV_STATUS_KEY, JSON.stringify(state)) } catch { /* */ }
}

function isInCooldown(ruleId, vmKey, cooldownSec) {
  const cooldowns = getCooldownState()
  const key = `${ruleId}:${vmKey}`
  const lastFired = cooldowns[key]
  if (!lastFired) return false
  return (Date.now() - lastFired) < cooldownSec * 1000
}

function recordCooldown(ruleId, vmKey) {
  const cooldowns = getCooldownState()
  cooldowns[`${ruleId}:${vmKey}`] = Date.now()
  saveCooldownState(cooldowns)
}

function getMetricValue(item, metric) {
  switch (metric) {
    case 'cpu':
      return item.status === 'running' && item.cpu != null ? item.cpu : null
    case 'memory':
      return item.status === 'running' && item.mem && item.maxmem
        ? item.mem / item.maxmem : null
    default:
      return null
  }
}

function checkThreshold(value, operator, threshold) {
  if (value === null) return false
  switch (operator) {
    case '>': return value > threshold
    case '<': return value < threshold
    case '>=': return value >= threshold
    case '<=': return value <= threshold
    case '==': return value === threshold
    default: return false
  }
}

/**
 * Evaluate all Proxmox alert rules against current VM data.
 * Returns an array of triggered alerts.
 */
export function evaluateProxmoxAlerts(allItems, authFetch, orgId) {
  const rules = getProxmoxAlertRules().filter(r => r.enabled)
  if (rules.length === 0 || !allItems || allItems.length === 0) return []

  const now = Date.now()
  const durations = getDurationState()
  const prevStatus = getPrevStatus()
  const alerts = []

  for (const rule of rules) {
    if (rule.metric === 'status_change') {
      // Special: detect status transitions
      for (const item of allItems) {
        const vmKey = `${item.node}-${item.vmid}`
        const prev = prevStatus[vmKey]

        if (prev === 'running' && item.status === 'stopped') {
          if (!isInCooldown(rule.id, vmKey, rule.cooldown)) {
            alerts.push({
              ruleId: rule.id,
              ruleName: rule.name,
              priority: rule.priority,
              vmid: item.vmid,
              node: item.node,
              name: item.name,
              type: item.type,
              message: `${item.name || item.vmid} on ${item.node} stopped unexpectedly`,
            })
            recordCooldown(rule.id, vmKey)
          }
        }
      }
      continue
    }

    // Threshold-based rules (cpu, memory)
    for (const item of allItems) {
      if (rule.scope !== 'all' && String(item.vmid) !== String(rule.scope)) continue

      const vmKey = `${item.node}-${item.vmid}`
      const durationKey = `${rule.id}:${vmKey}`
      const value = getMetricValue(item, rule.metric)
      const breached = checkThreshold(value, rule.operator, rule.threshold)

      if (breached) {
        if (!durations[durationKey]) {
          durations[durationKey] = now
        }
        const elapsed = (now - durations[durationKey]) / 1000

        if (elapsed >= rule.duration && !isInCooldown(rule.id, vmKey, rule.cooldown)) {
          const pct = value != null ? (value * 100).toFixed(0) : '?'
          const threshPct = (rule.threshold * 100).toFixed(0)
          alerts.push({
            ruleId: rule.id,
            ruleName: rule.name,
            priority: rule.priority,
            vmid: item.vmid,
            node: item.node,
            name: item.name,
            type: item.type,
            metric: rule.metric,
            value: pct,
            threshold: threshPct,
            message: `${item.name || item.vmid} on ${item.node}: ${rule.metric} at ${pct}% (threshold ${threshPct}%)`,
          })
          recordCooldown(rule.id, vmKey)
        }
      } else {
        delete durations[durationKey]
      }
    }
  }

  // Save status snapshot for next evaluation
  const newStatus = {}
  for (const item of allItems) {
    newStatus[`${item.node}-${item.vmid}`] = item.status
  }
  savePrevStatus(newStatus)
  saveDurationState(durations)

  // Send alerts to HITL inbox
  if (alerts.length > 0 && authFetch && orgId) {
    sendAlertsToInbox(alerts, authFetch, orgId)
  }

  return alerts
}

/**
 * Send triggered alerts to the HITL inbox via the collector.
 */
async function sendAlertsToInbox(alerts, authFetch, orgId) {
  for (const alert of alerts) {
    try {
      await authFetch('/collector/api/v1/inbox/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          item: {
            kind: 'incident',
            source: 'proxmox_monitor',
            title: alert.ruleName,
            body: alert.message,
            priority: alert.priority,
            requires_action: true,
            payload: {
              vmid: alert.vmid,
              node: alert.node,
              name: alert.name,
              type: alert.type,
              metric: alert.metric,
              value: alert.value,
              threshold: alert.threshold,
            },
          },
        }),
      })
    } catch (err) {
      console.error('[ProxmoxAlerts] Failed to send inbox item:', err)
    }
  }
}

export function getProxmoxAlertStats() {
  const cooldowns = getCooldownState()
  const activeCount = Object.keys(cooldowns).length
  const rules = getProxmoxAlertRules()
  return {
    totalRules: rules.length,
    enabledRules: rules.filter(r => r.enabled).length,
    recentAlerts: activeCount,
  }
}
