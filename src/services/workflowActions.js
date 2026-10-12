/**
 * Workflow Actions — Structured action schema for the workflow builder.
 *
 * Defines the actions Claude can take when building workflows, and parses
 * structured responses from the chat pipeline into executable operations.
 */

// Action types Claude can emit in its responses
export const ACTION_TYPES = {
  ADD_NODE: 'add_node',
  REMOVE_NODE: 'remove_node',
  UPDATE_NODE: 'update_node',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  SET_META: 'set_meta',
  LOAD_TEMPLATE: 'load_template',
  CLEAR: 'clear',
  EXPLAIN: 'explain',
  VALIDATE: 'validate',
  DEPLOY: 'deploy',
  SUGGEST: 'suggest',
}

// Verb aliases: normalize drift verbs to canonical action types
const VERB_ALIASES = {
  add_edge: 'connect',
  connect_nodes: 'connect',
  remove_edge: 'disconnect',
  delete_node: 'remove_node',
  delete_edge: 'disconnect',
}

/**
 * Normalize a raw parsed action object (from any drift pattern) to canonical shape.
 * Returns null if the object is unrecognizable or missing critical fields.
 *
 * Handles:
 * - "action" field instead of "type"
 * - verb aliases (add_edge → connect, etc.)
 * - nested node/edge wrapper ({action, node: {...}} → flat)
 * - label → name field alias on node config
 * - from/to → source/target for connect actions
 * - nodeType detection when "type" is used for the node-type string (contains ":")
 *
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null

  // Canonicalize verb: type | action -> canonical type
  let type = raw.type || raw.action
  if (!type || typeof type !== 'string') return null

  // Apply verb aliases
  type = VERB_ALIASES[type] || type

  // Capture the nested node/edge type BEFORE the spread overwrites inner.type
  // e.g. raw.node.type = "trigger:schedule" (a nodeType) vs raw.action = "add_node" (verb)
  const nestedNodeType =
    raw.node && typeof raw.node === 'object' && raw.node.type ? raw.node.type : null

  // Unwrap nested node/edge wrapper objects into a flat structure
  let inner = raw
  if (raw.node && typeof raw.node === 'object') {
    // Overwrite inner.type with the canonical verb (not the nested node-type string)
    inner = { ...raw, ...raw.node, type }
  }
  if (raw.edge && typeof raw.edge === 'object') {
    inner = { ...raw, ...raw.edge, type }
  }

  if (type === 'add_node') {
    // nodeType resolution priority:
    // 1. explicit nodeType field on inner or raw
    // 2. the nested raw.node.type we captured before the spread
    // 3. inner.type that looks like a nodeType (contains ":") — for flat drift like
    //    {"type":"trigger:schedule"} inside a bare object with no wrapper
    const nodeType =
      inner.nodeType ||
      raw.nodeType ||
      nestedNodeType ||
      (raw.type && raw.type.includes(':') ? raw.type : null)

    if (!nodeType) {
      console.warn('[workflowActions] Dropping add_node — missing nodeType:', raw)
      return null
    }

    const config = inner.config || raw.config || {}
    // Field alias: label → name inside config
    const name = inner.name || inner.label || config.name || config.label
    const resolvedConfig = name ? { ...config, name } : config

    return {
      type: 'add_node',
      id: inner.id || raw.id || undefined,
      nodeType,
      config: resolvedConfig,
      position: inner.position || raw.position || undefined,
    }
  }

  if (type === 'connect') {
    // Field aliases: from/to → source/target
    const source = inner.source || inner.from || raw.from
    const target = inner.target || inner.to || raw.to

    if (!source || !target) {
      console.warn('[workflowActions] Dropping connect — missing source or target:', raw)
      return null
    }

    return {
      type: 'connect',
      source,
      target,
      sourceHandle: inner.sourceHandle || undefined,
      targetHandle: inner.targetHandle || undefined,
    }
  }

  // For all other action types (remove_node, update_node, disconnect, set_meta,
  // load_template, clear, explain, validate, deploy, suggest): pass through with
  // the resolved type override and no further normalization.
  return { ...inner, type }
}

/**
 * Parse a Claude response for embedded workflow actions.
 *
 * Accepts the canonical quoxflow-action fence AND common LLM drift patterns:
 * - Alternative fence names: quoxflow_action, action, actions, json (bare JSON only)
 * - "action" field instead of "type" for the verb
 * - Nested node/edge wrapper objects
 * - Verb aliases (add_edge → connect, etc.)
 * - Field aliases (label → name, from/to → source/target)
 * - Bare single-line JSON objects/arrays in the response text (no fence)
 *
 * Everything is normalized to canonical shape before returning.
 *
 * @param {string} text - Raw Claude response text
 * @returns {{ actions: Array, cleanText: string }}
 */
export function parseActions(text) {
  if (!text) return { actions: [], cleanText: '' }

  const rawActions = []

  // --- Pass 1: scan named action fences ---
  // Matches: ```quoxflow-action, ```quoxflow_action, ```action, ```actions
  const ACTION_FENCE_RE = /```(?:quoxflow[-_]?action|actions?)\s*\n([\s\S]*?)```/gi
  let match
  while ((match = ACTION_FENCE_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      const items = Array.isArray(parsed) ? parsed : [parsed]
      rawActions.push(...items)
    } catch (e) {
      console.warn('[workflowActions] Failed to parse action fence block:', e.message)
    }
  }

  // --- Pass 2: scan ```json fences for action-shaped objects ---
  const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)```/gi
  while ((match = JSON_FENCE_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      const items = Array.isArray(parsed) ? parsed : [parsed]
      // Only include if items look like actions (have type or action field)
      const actionLike = items.filter(
        (obj) => obj && typeof obj === 'object' && (obj.type || obj.action)
      )
      rawActions.push(...actionLike)
    } catch (_) {
      // Not valid JSON or not action-shaped — skip silently
    }
  }

  // --- Pass 3: scan bare single-line JSON in the response (outside any fence) ---
  // Strip all code fences first to avoid double-counting
  const textWithoutFences = text.replace(/```[\s\S]*?```/g, '')

  for (const line of textWithoutFences.split('\n')) {
    const trimmed = line.trim()
    // Only attempt parse on lines that look like JSON objects or arrays
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        const actionLike = items.filter(
          (obj) => obj && typeof obj === 'object' && (obj.type || obj.action)
        )
        rawActions.push(...actionLike)
      } catch (_) {
        // Not valid JSON — skip
      }
    }
  }

  // --- Normalize all collected raw actions ---
  const actions = rawActions
    .map(normalizeAction)
    .filter(Boolean) // drop nulls (invalid actions)

  // --- Build cleanText: strip action fences AND bare JSON action lines ---
  // Strip named action fences
  let cleanText = text.replace(/```(?:quoxflow[-_]?action|actions?)\s*\n[\s\S]*?```/gi, '')

  // Strip bare JSON action lines (single-line objects/arrays that parsed as actions)
  // We re-identify them to strip from cleanText
  const actionLineSet = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        const hasActionShape = items.some(
          (obj) => obj && typeof obj === 'object' && (obj.type || obj.action)
        )
        if (hasActionShape) actionLineSet.add(line)
      } catch (_) {
        // ignore
      }
    }
  }

  if (actionLineSet.size > 0) {
    cleanText = cleanText
      .split('\n')
      .filter((line) => !actionLineSet.has(line))
      .join('\n')
  }

  return { actions, cleanText: cleanText.trim() }
}

/**
 * Execute a batch of parsed actions against the workflow builder hook.
 *
 * @param {Array} actions - Parsed action objects
 * @param {object} builder - The useWorkflowBuilder() return value
 * @returns {{ applied: number, errors: string[] }}
 */
export function executeActions(actions, builder) {
  // Preferred path: single state transition for the whole batch — avoids
  // per-action re-render flicker when WEAVER emits multi-action mutations.
  if (typeof builder.bulkApply === 'function') {
    return builder.bulkApply(actions)
  }

  const errors = []
  let applied = 0

  for (const action of actions) {
    try {
      switch (action.type) {
        case ACTION_TYPES.ADD_NODE: {
          // Pass action.id so WEAVER can reference her own node IDs in subsequent
          // connect / update_node actions. Falls back to auto-generated if omitted
          // or if the ID already exists (collision avoidance inside addNode).
          builder.addNode(action.nodeType, action.config || {}, action.position || null, action.id || null)
          applied++
          break
        }
        case ACTION_TYPES.REMOVE_NODE: {
          builder.removeNode(action.nodeId)
          applied++
          break
        }
        case ACTION_TYPES.UPDATE_NODE: {
          builder.updateNode(action.nodeId, action.changes || {})
          applied++
          break
        }
        case ACTION_TYPES.CONNECT: {
          builder.connectNodes(action.source, action.target, action.sourceHandle, action.targetHandle)
          applied++
          break
        }
        case ACTION_TYPES.DISCONNECT: {
          builder.disconnectEdge(action.edgeId)
          applied++
          break
        }
        case ACTION_TYPES.SET_META: {
          builder.updateMeta(action.meta || {})
          applied++
          break
        }
        case ACTION_TYPES.LOAD_TEMPLATE: {
          if (action.workflow) {
            builder.loadFromTemplate(action.workflow)
            applied++
          }
          break
        }
        case ACTION_TYPES.CLEAR: {
          builder.clear()
          applied++
          break
        }
        default:
          // EXPLAIN, VALIDATE, DEPLOY, SUGGEST are informational — no builder mutation
          break
      }
    } catch (e) {
      errors.push(`${action.type}: ${e.message}`)
    }
  }

  return { applied, errors }
}

/**
 * Build a context summary of the current workflow state for Claude.
 * Injected into the user message so Claude knows what exists.
 *
 * @param {object} builder - The useWorkflowBuilder() return value
 * @returns {string}
 */
export function buildWorkflowContext(builder) {
  const { nodes, edges, meta, validation } = builder

  if (nodes.length === 0) {
    return '[Workflow is empty — no nodes yet]'
  }

  const lines = []
  lines.push(`Workflow: "${meta.name || 'Untitled'}"`)
  if (meta.description) lines.push(`Description: ${meta.description}`)
  lines.push(`Nodes (${nodes.length}):`)

  for (const n of nodes) {
    const configKeys = Object.keys(n.config || {}).filter(k => k !== 'name')
    const configStr = configKeys.length > 0
      ? ` [${configKeys.map(k => `${k}=${JSON.stringify(n.config[k])}`).join(', ')}]`
      : ''
    lines.push(`  - ${n.id} (${n.type}) "${n.name}"${configStr}`)
  }

  if (edges.length > 0) {
    lines.push(`Edges (${edges.length}):`)
    for (const e of edges) {
      lines.push(`  - ${e.source} -> ${e.target}`)
    }
  }

  // Coarse validation (trigger present, orphan nodes) — comes from useWorkflowBuilder.
  if (validation.errors.length > 0) {
    lines.push(`Validation errors:`)
    validation.errors.forEach(e => lines.push(`  ! ${e.message}`))
  }
  if (validation.warnings.length > 0) {
    lines.push(`Warnings:`)
    validation.warnings.forEach(w => lines.push(`  ~ ${w.message}`))
  }

  // STUDY-REV W3 verify (2026-05-03): per-field schema validation. The Deploy
  // button gates on this — if WEAVER doesn't see these, it asks the user
  // "which node has validation errors" instead of reading the canvas itself.
  // Lazy-required so this module stays free of the JSX-side schema imports
  // for tests / non-builder callers.
  try {
    const { validateWorkflow } = require('../components/workflow/NodeConfigDrawer/fieldSchema')
    const schemaReport = validateWorkflow(nodes)
    if (schemaReport.issueCount > 0) {
      lines.push(`Per-field schema errors (${schemaReport.issueCount}):`)
      for (const issue of schemaReport.nodes) {
        const parts = []
        if (issue.missing?.length) parts.push(`missing: ${issue.missing.join(', ')}`)
        if (issue.placeholders?.length) parts.push(`placeholder values: ${issue.placeholders.join(', ')}`)
        lines.push(`  ! ${issue.nodeId} (${issue.type}) "${issue.name}" — ${parts.join('; ')}`)
      }
    }
  } catch {
    // Schema validator not available in this context (e.g., unit test) —
    // skip silently. The coarse validation above still runs.
  }

  return lines.join('\n')
}
