/**
 * Objective Chaining — Dependencies, templates, and cross-objective context
 *
 * Stream OE Phase OE-7: QuoxEngine composition
 *
 * - isObjectiveBlocked(): Check if an objective is waiting for a parent
 * - getParentContext(): Get parent's completion summary for prompt injection
 * - saveObjectiveTemplate(): Save a successful objective as a reusable template
 * - listObjectiveTemplates(): List templates for an org
 * - instantiateTemplate(): Create a new objective from a template
 * - canCreateChildObjective(): AT-1 — check if an agent can spawn a sub-objective (hierarchical topology)
 */

import { getDatabase } from '../db/index.js'
import { ulid } from 'ulid'

const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled']

/**
 * Check if an objective is blocked by an unfinished dependency.
 *
 * @param {string} objectiveId
 * @returns {boolean} true if blocked (parent not yet completed)
 */
export function isObjectiveBlocked(objectiveId) {
  const db = getDatabase()

  const obj = db.prepare('SELECT depends_on_objective_id FROM objectives WHERE id = ?').get(objectiveId)
  if (!obj || !obj.depends_on_objective_id) return false

  const parent = db.prepare('SELECT status FROM objectives WHERE id = ?').get(obj.depends_on_objective_id)
  if (!parent) return false // parent deleted — not blocked

  // Blocked unless parent is in a terminal success state
  return !['completed', 'completed_with_errors'].includes(parent.status)
}

/**
 * Get context from a parent objective for prompt injection.
 * Returns a formatted string with parent title + task summaries.
 *
 * @param {string} objectiveId — the child objective
 * @returns {string|null} context string, or null if no parent
 */
export function getParentContext(objectiveId) {
  const db = getDatabase()

  const obj = db.prepare('SELECT depends_on_objective_id FROM objectives WHERE id = ?').get(objectiveId)
  if (!obj || !obj.depends_on_objective_id) return null

  const parent = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.depends_on_objective_id)
  if (!parent) return null

  // Get parent's completed tasks with results
  const tasks = db.prepare(`
    SELECT title, agent_id, status, result, result_structured FROM tasks
    WHERE objective_id = ? AND result IS NOT NULL
    ORDER BY sequence_num ASC
  `).all(parent.id)

  const taskSummaries = tasks.map(t => {
    const result = t.result_structured || (t.result?.length > 500 ? t.result.slice(0, 500) + '...' : t.result)
    return `- ${t.title} (${t.agent_id}): ${result || t.status}`
  }).join('\n')

  return `--- Parent Objective: ${parent.title} (${parent.status}) ---\n` +
    `${parent.description || ''}\n\n` +
    `Task Results:\n${taskSummaries}`
}

/**
 * Save a completed objective as a reusable template.
 * WC-4: Accepts optional variables array for parameterisation.
 *
 * @param {string} objectiveId — source objective
 * @param {string} orgId
 * @param {string} userId
 * @param {string} name — template name
 * @param {Array} [variables] — optional array of { value, suggestedName, type, label }
 * @returns {Object} saved template record
 */
export function saveObjectiveTemplate(objectiveId, orgId, userId, name, variables = []) {
  const db = getDatabase()

  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (!objective) throw new Error(`Objective ${objectiveId} not found`)

  const tasks = db.prepare(`
    SELECT title, agent_id, prompt, sequence_num, depends_on, output_schema
    FROM tasks WHERE objective_id = ?
    ORDER BY sequence_num ASC
  `).all(objectiveId)

  const templateObj = {
    title: objective.title,
    description: objective.description,
    max_tokens: objective.max_tokens,
    max_tool_calls: objective.max_tool_calls,
    max_duration_ms: objective.max_duration_ms,
    team_id: objective.team_id,
    checkpoint_after_each_task: objective.checkpoint_after_each_task,
    tasks: tasks.map(t => ({
      title: t.title,
      agent_id: t.agent_id,
      prompt: t.prompt,
      sequence_num: t.sequence_num,
      depends_on_indices: t.depends_on ? (() => {
        // Convert task ID deps to sequence_num indices for portability
        try {
          const depIds = JSON.parse(t.depends_on)
          return depIds.map(depId => {
            const dep = tasks.find(tt => tt.id === depId)
            return dep ? dep.sequence_num : null
          }).filter(x => x !== null)
        } catch { return [] }
      })() : [],
      output_schema: t.output_schema,
    })),
  }

  // WC-4: Apply variable parameterisation if variables provided
  if (variables && variables.length > 0) {
    let json = JSON.stringify(templateObj)
    const variablesDef = []

    for (const v of variables) {
      const escaped = v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped, 'g')
      json = json.replace(re, `{{${v.suggestedName}}}`)

      variablesDef.push({
        name: v.suggestedName,
        type: v.type,
        defaultValue: v.value,
        label: v.label || v.suggestedName,
      })
    }

    const parameterised = JSON.parse(json)
    parameterised.variables = variablesDef
    const templateJson = JSON.stringify(parameterised)

    const id = ulid()
    db.prepare(`
      INSERT INTO objective_templates (id, org_id, user_id, name, source_objective_id, template_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, orgId, userId, name, objectiveId, templateJson)

    return { id, name, org_id: orgId, source_objective_id: objectiveId, template_json: templateJson }
  }

  const templateJson = JSON.stringify(templateObj)

  const id = ulid()
  db.prepare(`
    INSERT INTO objective_templates (id, org_id, user_id, name, source_objective_id, template_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, orgId, userId, name, objectiveId, templateJson)

  return { id, name, org_id: orgId, source_objective_id: objectiveId, template_json: templateJson }
}

/**
 * List objective templates for an org.
 *
 * @param {string} orgId
 * @returns {Array}
 */
export function listObjectiveTemplates(orgId) {
  const db = getDatabase()
  return db.prepare(`
    SELECT id, name, source_objective_id, template_json, created_at FROM objective_templates
    WHERE org_id = ? ORDER BY created_at DESC
  `).all(orgId)
}

/**
 * Get a template by ID.
 *
 * @param {string} templateId
 * @param {string} orgId
 * @returns {Object|null}
 */
export function getObjectiveTemplate(templateId, orgId) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM objective_templates WHERE id = ? AND org_id = ?').get(templateId, orgId)
}

/**
 * Create a new objective (+ tasks) from a template.
 * WC-4: Accepts optional variableValues to replace {{placeholders}} before creating.
 *
 * @param {string} templateId
 * @param {string} orgId
 * @param {string} userId
 * @param {Object} [variableValues] — optional { variable_name: "actual_value" } map
 * @returns {Object} the created objective
 */
export function instantiateTemplate(templateId, orgId, userId, variableValues) {
  const db = getDatabase()

  const template = db.prepare('SELECT * FROM objective_templates WHERE id = ? AND org_id = ?')
    .get(templateId, orgId)
  if (!template) throw new Error(`Template ${templateId} not found`)

  let planJson = template.template_json

  // WC-4: Replace {{variable}} placeholders with actual values
  if (variableValues && typeof variableValues === 'object') {
    for (const [name, value] of Object.entries(variableValues)) {
      const placeholder = `{{${name}}}`
      while (planJson.includes(placeholder)) {
        planJson = planJson.replace(placeholder, value)
      }
    }
  }

  const plan = JSON.parse(planJson)
  const objectiveId = ulid()

  // Create objective
  db.prepare(`
    INSERT INTO objectives (id, org_id, user_id, title, description, status, max_tokens, max_tool_calls, max_duration_ms,
      team_id, checkpoint_after_each_task, task_count, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    objectiveId, orgId, userId,
    plan.title, plan.description,
    plan.max_tokens || 100000,
    plan.max_tool_calls || 50,
    plan.max_duration_ms || 600000,
    plan.team_id || null,
    plan.checkpoint_after_each_task ? 1 : 0,
    (plan.tasks || []).length
  )

  // Create tasks
  const taskIds = []
  for (const taskDef of (plan.tasks || [])) {
    const taskId = ulid()
    taskIds.push(taskId)

    // Resolve depends_on from sequence indices to actual task IDs
    const dependsOn = (taskDef.depends_on_indices || [])
      .map(idx => taskIds[idx])
      .filter(Boolean)

    db.prepare(`
      INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, depends_on, output_schema, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(
      taskId, objectiveId, orgId,
      taskDef.title, taskDef.agent_id, taskDef.prompt,
      taskDef.sequence_num || 0,
      JSON.stringify(dependsOn),
      taskDef.output_schema || null
    )
  }

  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
}

/**
 * AT-1: Check if an agent can create a child objective (hierarchical topology).
 *
 * Only agents listed as sub-orchestrators in a hierarchical manifest
 * can spawn child objectives, and only up to maxDepth.
 *
 * @param {string} agentId — the agent attempting to create a child
 * @param {Object} manifest — team manifest
 * @param {number} currentDepth — current decomposition depth (0 = root)
 * @returns {boolean}
 */
export function canCreateChildObjective(agentId, manifest, currentDepth) {
  if (!manifest?.topology) return false
  if (manifest.topology.type !== 'hierarchical') return false
  if (!manifest.topology.subOrchestrators?.includes(agentId)) return false
  const maxDepth = manifest.topology.maxDepth !== undefined ? manifest.topology.maxDepth : 2
  if (currentDepth >= maxDepth) return false
  return true
}
