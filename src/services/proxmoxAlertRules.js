/**
 * proxmoxAlertRules — CRUD for Proxmox-specific alert rules.
 *
 * Rules stored in localStorage with org scoping.
 * Default rules: CPU > 90% for 5 min, Memory > 90% for 5 min, VM stopped unexpectedly.
 */

const STORAGE_KEY = 'quox_proxmox_alert_rules'

const DEFAULT_RULES = [
  {
    id: 'pxalert-cpu-high',
    name: 'High CPU Usage',
    description: 'Alert when any VM CPU exceeds 90% for 5 minutes',
    metric: 'cpu',
    operator: '>',
    threshold: 0.9,
    duration: 300,  // 5 minutes in seconds
    cooldown: 600,  // 10 minute cooldown
    priority: 'high',
    enabled: true,
    scope: 'all', // 'all' or specific vmid
  },
  {
    id: 'pxalert-mem-high',
    name: 'High Memory Usage',
    description: 'Alert when any VM memory exceeds 90% for 5 minutes',
    metric: 'memory',
    operator: '>',
    threshold: 0.9,
    duration: 300,
    cooldown: 600,
    priority: 'high',
    enabled: true,
    scope: 'all',
  },
  {
    id: 'pxalert-vm-stopped',
    name: 'VM Stopped',
    description: 'Alert when a previously running VM stops unexpectedly',
    metric: 'status_change',
    operator: '==',
    threshold: 'stopped',
    duration: 0,   // Immediate
    cooldown: 1800, // 30 minute cooldown
    priority: 'critical',
    enabled: true,
    scope: 'all',
  },
]

export function getProxmoxAlertRules() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const rules = JSON.parse(stored)
      return Array.isArray(rules) ? rules : DEFAULT_RULES
    }
  } catch { /* ignore */ }
  return [...DEFAULT_RULES]
}

export function saveProxmoxAlertRules(rules) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
  } catch (err) {
    console.error('[ProxmoxAlerts] Failed to save rules:', err)
  }
}

export function addProxmoxAlertRule(rule) {
  const rules = getProxmoxAlertRules()
  const newRule = {
    ...rule,
    id: rule.id || `pxalert-${Date.now()}`,
  }
  rules.push(newRule)
  saveProxmoxAlertRules(rules)
  return newRule
}

export function updateProxmoxAlertRule(id, updates) {
  const rules = getProxmoxAlertRules()
  const idx = rules.findIndex(r => r.id === id)
  if (idx >= 0) {
    rules[idx] = { ...rules[idx], ...updates }
    saveProxmoxAlertRules(rules)
  }
  return rules[idx]
}

export function deleteProxmoxAlertRule(id) {
  const rules = getProxmoxAlertRules().filter(r => r.id !== id)
  saveProxmoxAlertRules(rules)
}

export function toggleProxmoxAlertRule(id, enabled) {
  return updateProxmoxAlertRule(id, { enabled })
}

export function resetToDefaults() {
  saveProxmoxAlertRules([...DEFAULT_RULES])
  return DEFAULT_RULES
}
