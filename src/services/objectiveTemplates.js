/**
 * objectiveTemplates — localStorage-backed template CRUD for objectives
 *
 * Provides built-in templates + user-saved custom templates.
 * Templates pre-fill the New Objective modal with title, description,
 * team_id, priority, and budget constraints.
 *
 * UX-3: Clone + Template system.
 */

const STORAGE_KEY = 'quox_objective_templates'

/**
 * Built-in templates — always available, cannot be deleted.
 */
export const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin_security_audit',
    name: 'Security Audit',
    title: 'Security audit across infrastructure',
    description: 'Scan all hosts for open ports, expired certificates, outdated packages, and misconfigurations. Produce a prioritised remediation report.',
    team_id: 'secops',
    priority: 'high',
    constraints: { max_tokens: 200000, max_tool_calls: 100, max_duration_ms: 3600000 },
    isBuiltIn: true,
  },
  {
    id: 'builtin_health_check',
    name: 'System Health Check',
    title: 'System health check and status report',
    description: 'Check CPU, memory, disk, and service health across all monitored hosts. Flag any resources above 80% utilisation or services that are degraded.',
    team_id: null,
    priority: 'medium',
    constraints: { max_tokens: 100000, max_tool_calls: 50, max_duration_ms: 1800000 },
    isBuiltIn: true,
  },
  {
    id: 'builtin_deployment',
    name: 'Deployment Checklist',
    title: 'Pre-deployment verification',
    description: 'Run through the standard deployment checklist: verify tests pass, check for breaking changes, validate configuration, confirm rollback plan is in place.',
    team_id: null,
    priority: 'high',
    constraints: { max_tokens: 150000, max_tool_calls: 80, max_duration_ms: 2400000 },
    isBuiltIn: true,
  },
  {
    id: 'builtin_data_analysis',
    name: 'Data Analysis',
    title: 'Analyse recent metrics and trends',
    description: 'Review performance metrics, error rates, and usage trends over the last 7 days. Identify anomalies and produce an executive summary with recommendations.',
    team_id: null,
    priority: 'medium',
    constraints: { max_tokens: 100000, max_tool_calls: 40, max_duration_ms: 1800000 },
    isBuiltIn: true,
  },
  {
    id: 'builtin_incident_response',
    name: 'Incident Response',
    title: 'Investigate and respond to incident',
    description: 'Gather logs and metrics related to the incident. Identify root cause, assess blast radius, apply mitigation, and produce a post-mortem summary.',
    team_id: 'secops',
    priority: 'critical',
    constraints: { max_tokens: 300000, max_tool_calls: 150, max_duration_ms: 7200000 },
    isBuiltIn: true,
  },
]

/**
 * Read custom templates from localStorage.
 */
function readCustom() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/**
 * Write custom templates to localStorage.
 */
function writeCustom(templates) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
}

/**
 * Generate a unique template ID.
 */
function generateId() {
  return `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * List all templates — custom first, then built-in.
 */
export function listTemplates() {
  const custom = readCustom()
  return [...custom, ...BUILT_IN_TEMPLATES]
}

/**
 * Get a template by ID (checks custom then built-in).
 */
export function getTemplate(id) {
  const custom = readCustom()
  const found = custom.find(t => t.id === id) || BUILT_IN_TEMPLATES.find(t => t.id === id)
  return found || null
}

/**
 * Save a new custom template.
 * @param {Object} template — { name, title, description, team_id, priority, constraints }
 * @returns {Object} the saved template with generated id
 */
export function saveTemplate(template) {
  const custom = readCustom()
  const saved = {
    id: generateId(),
    name: template.name,
    title: template.title || '',
    description: template.description || '',
    team_id: template.team_id || null,
    priority: template.priority || 'medium',
    constraints: template.constraints || {},
    isBuiltIn: false,
    createdAt: new Date().toISOString(),
  }
  custom.push(saved)
  writeCustom(custom)
  return saved
}

/**
 * Delete a custom template by ID. Built-in templates cannot be deleted.
 */
export function deleteTemplate(id) {
  if (BUILT_IN_TEMPLATES.find(t => t.id === id)) return // can't delete built-ins
  const custom = readCustom().filter(t => t.id !== id)
  writeCustom(custom)
}

/**
 * Create a template from an existing objective (for Clone flow).
 * @param {Object} objective — objective data
 * @param {string} name — template name
 * @returns {Object} saved template
 */
export function saveFromObjective(objective, name) {
  return saveTemplate({
    name,
    title: objective.title,
    description: objective.description || '',
    team_id: objective.team_id || null,
    priority: objective.priority || 'medium',
    constraints: {
      max_tokens: objective.max_tokens,
      max_tool_calls: objective.max_tool_calls,
      max_duration_ms: objective.max_duration_ms,
      checkpoint_after_each_task: objective.checkpoint_after_each_task,
    },
  })
}
