/**
 * Alert Rules Configuration
 *
 * Defines configurable alert rules for service monitoring.
 * Rules trigger when conditions are met for a specified duration.
 *
 * Rule Types:
 * - response_time: Triggers when response time exceeds threshold
 * - uptime: Triggers when uptime percentage falls below threshold
 * - status: Triggers on specific status (down, degraded)
 * - consecutive_failures: Triggers after N consecutive failures
 */

import { orgGet, orgSet, orgRemove } from './orgScopedStorage'
// Bump this when DEFAULT_RULES change to force a reset of cached rules
const RULES_VERSION = 2
// Version key uses org-scoped storage too

/**
 * Default alert rules
 */
const DEFAULT_RULES = [
  {
    id: 'critical-service-down',
    name: 'Critical Service Down',
    enabled: true,
    priority: 'urgent',
    conditions: {
      type: 'status',
      status: 'down',
      criticalOnly: true
    },
    duration: 60, // Must be down for 60 seconds (2 health checks)
    cooldown: 1800, // 30 minutes before re-alerting
    description: 'Alert when a critical service is down for over 1 minute'
  },
  {
    id: 'service-degraded',
    name: 'Service Degraded',
    enabled: true,
    priority: 'high',
    conditions: {
      type: 'status',
      status: 'degraded',
      criticalOnly: false
    },
    duration: 300, // 5 minutes
    cooldown: 1800, // 30 minutes
    description: 'Alert when a service is degraded for over 5 minutes'
  },
  {
    id: 'slow-response',
    name: 'Slow Response Time',
    enabled: true,
    priority: 'normal',
    conditions: {
      type: 'response_time',
      threshold: 2000, // 2 seconds
      criticalOnly: false
    },
    duration: 180, // 3 minutes
    cooldown: 900, // 15 minutes
    description: 'Alert when response time exceeds 2 seconds for 3 minutes'
  },
  {
    id: 'uptime-warning',
    name: 'Low Uptime',
    enabled: true,
    priority: 'high',
    conditions: {
      type: 'uptime',
      threshold: 85, // Below 85%
      hours: 24
    },
    duration: 0, // Check on each evaluation
    cooldown: 86400, // 24 hours — only alert once per day
    description: 'Alert when 24-hour uptime falls below 85%'
  },
  {
    id: 'consecutive-failures',
    name: 'Consecutive Failures',
    enabled: true,
    priority: 'urgent',
    conditions: {
      type: 'consecutive_failures',
      count: 12,
      criticalOnly: true
    },
    duration: 0,
    cooldown: 1800, // 30 minutes
    description: 'Alert after 12 consecutive health check failures (~6 minutes) for critical services only'
  }
]

/**
 * Get all alert rules
 */
export function getAlertRules() {
  try {
    const storedVersion = orgGet('alert-rules-version')
    if (storedVersion && Number(storedVersion) < RULES_VERSION) {
      // Defaults changed — reset to pick up new thresholds
      orgRemove('alert-rules')
      orgSet('alert-rules-version', String(RULES_VERSION))
      return [...DEFAULT_RULES]
    }
    const stored = orgGet('alert-rules')
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (err) {
    console.error('Failed to load alert rules:', err)
  }
  // Return defaults if nothing stored
  orgSet('alert-rules-version', String(RULES_VERSION))
  return [...DEFAULT_RULES]
}

/**
 * Save alert rules
 */
export function saveAlertRules(rules) {
  try {
    orgSet('alert-rules', JSON.stringify(rules))
    return true
  } catch (err) {
    console.error('Failed to save alert rules:', err)
    return false
  }
}

/**
 * Add a new alert rule
 */
export function addAlertRule(rule) {
  const rules = getAlertRules()
  const newRule = {
    ...rule,
    id: rule.id || `rule-${Date.now()}`,
    enabled: rule.enabled ?? true,
    cooldown: rule.cooldown || 300
  }
  rules.push(newRule)
  saveAlertRules(rules)
  return newRule
}

/**
 * Update an existing rule
 */
export function updateAlertRule(ruleId, updates) {
  const rules = getAlertRules()
  const index = rules.findIndex(r => r.id === ruleId)
  if (index === -1) return false

  rules[index] = { ...rules[index], ...updates }
  saveAlertRules(rules)
  return true
}

/**
 * Delete a rule
 */
export function deleteAlertRule(ruleId) {
  const rules = getAlertRules()
  const filtered = rules.filter(r => r.id !== ruleId)
  if (filtered.length === rules.length) return false

  saveAlertRules(filtered)
  return true
}

/**
 * Toggle rule enabled state
 */
export function toggleAlertRule(ruleId, enabled) {
  return updateAlertRule(ruleId, { enabled })
}

/**
 * Reset to default rules
 */
export function resetToDefaultRules() {
  saveAlertRules([...DEFAULT_RULES])
  return DEFAULT_RULES
}

/**
 * Get alert state (for tracking active alerts and cooldowns)
 */
export function getAlertState() {
  try {
    const stored = orgGet('alert-state')
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Save alert state
 */
export function saveAlertState(state) {
  try {
    orgSet('alert-state', JSON.stringify(state))
  } catch (err) {
    console.error('Failed to save alert state:', err)
  }
}

/**
 * Check if a rule is in cooldown for a specific service
 */
export function isInCooldown(ruleId, serviceKey) {
  const state = getAlertState()
  const key = `${ruleId}:${serviceKey}`
  const lastAlert = state[key]

  if (!lastAlert) return false

  const rule = getAlertRules().find(r => r.id === ruleId)
  if (!rule) return false

  const cooldownMs = (rule.cooldown || 300) * 1000
  return Date.now() - lastAlert < cooldownMs
}

/**
 * Record that an alert was sent
 */
export function recordAlert(ruleId, serviceKey) {
  const state = getAlertState()
  state[`${ruleId}:${serviceKey}`] = Date.now()
  saveAlertState(state)
}

/**
 * Clear cooldown for a rule/service
 */
export function clearCooldown(ruleId, serviceKey) {
  const state = getAlertState()
  delete state[`${ruleId}:${serviceKey}`]
  saveAlertState(state)
}

export default {
  getAlertRules,
  saveAlertRules,
  addAlertRule,
  updateAlertRule,
  deleteAlertRule,
  toggleAlertRule,
  resetToDefaultRules,
  getAlertState,
  isInCooldown,
  recordAlert,
  clearCooldown,
  DEFAULT_RULES
}
