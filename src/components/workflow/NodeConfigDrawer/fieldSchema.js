/**
 * NODE_FIELD_SCHEMA — drawer-specific metadata for each node archetype.
 *
 * Parallel to NODE_ARCHETYPES.defaultConfig in useWorkflowBuilder.js. Kept
 * separate so the archetype map (read on every node add / bulkApply) stays
 * shape-stable, and so input-renderer hints live next to the drawer code.
 *
 * Schema shape per field:
 *   {
 *     input:    'text' | 'number' | 'toggle' | 'textarea' | 'segmented'
 *               | 'dropdown' | 'tag' | 'url' | 'expression' | 'cron'
 *               | 'timezone' | 'model' | 'agent' | 'tools' | 'workflowPicker',
 *     required?: boolean,                  // blocks deploy with a warning
 *     primary?:  boolean,                  // focused first when mode=create
 *     helper?:   string,                   // help text under the input
 *     options?:  string[] | { id, label }[]   // for segmented / dropdown
 *   }
 */

import { NODE_ARCHETYPES } from '../../../hooks/useWorkflowBuilder'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const LOG_LEVELS = ['debug', 'info', 'warn', 'error']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']
const MERGE_STRATEGIES = ['wait_all', 'wait_any', 'race']
const AGGREGATIONS = ['collect', 'count', 'sum', 'avg', 'min', 'max']
const WEBHOOK_AUTHS = ['none', 'basic', 'bearer', 'signature']

export const NODE_FIELD_SCHEMA = {
  'trigger:webhook': {
    method:         { input: 'segmented', options: HTTP_METHODS, required: true, helper: 'HTTP method this webhook accepts.' },
    path:           { input: 'url',       required: true, primary: true, helper: 'Path under /webhook. Supports {{PLACEHOLDERS}}.' },
    authentication: { input: 'dropdown',  options: WEBHOOK_AUTHS, required: true, helper: 'Scheme used to verify inbound requests.' },
  },
  'trigger:schedule': {
    cron:     { input: 'cron',     required: true, primary: true, helper: 'When this schedule fires.' },
    timezone: { input: 'timezone', required: true, helper: 'Reference timezone for the schedule.' },
    enabled:  { input: 'toggle',                   helper: 'Disabled schedules do not run.' },
  },
  'trigger:event': {
    event:  { input: 'text',       required: true, primary: true, helper: 'Event name to listen for.' },
    source: { input: 'text',                       helper: 'Optional source filter.' },
    filter: { input: 'expression',                 helper: 'JSONPath / template filter expression.' },
  },
  'flow:condition': {
    expression: { input: 'expression', required: true, primary: true, helper: 'Boolean expression. True branch fires when truthy.' },
    trueLabel:  { input: 'text',                       helper: 'Label for the true branch handle.' },
    falseLabel: { input: 'text',                       helper: 'Label for the false branch handle.' },
  },
  'flow:switch': {
    field: { input: 'expression', required: true, primary: true, helper: 'Field or expression to switch on.' },
    cases: { input: 'expression', required: true,                helper: 'JSON: { "matchValue": "caseId" }.' },
  },
  'flow:loop': {
    collection:    { input: 'expression', required: true, primary: true, helper: 'Array or iterable to loop over.' },
    maxIterations: { input: 'number',                                   helper: 'Hard cap to prevent runaways.' },
  },
  'flow:parallel': {
    maxConcurrency: { input: 'number', required: true, primary: true, helper: 'Max branches running simultaneously.' },
  },
  'flow:merge': {
    strategy: { input: 'dropdown', options: MERGE_STRATEGIES, required: true, primary: true, helper: 'How to combine incoming branches.' },
  },
  'call': {
    url:     { input: 'url',       required: true, primary: true, helper: 'Endpoint to call. Supports {{PLACEHOLDERS}}.' },
    method:  { input: 'segmented', options: HTTP_METHODS, required: true,        helper: 'HTTP method.' },
    timeout: { input: 'number',                                                  helper: 'Request timeout in milliseconds.' },
  },
  'data:transform': {
    expression:  { input: 'expression', required: true, primary: true, helper: 'Transform expression. Reads input as $input.' },
    outputField: { input: 'text',       required: true,                helper: 'Field name on the output object.' },
  },
  'data:set': {
    field: { input: 'text',       required: true, primary: true, helper: 'Output field name.' },
    value: { input: 'expression', required: true,                helper: 'Value or expression.' },
  },
  'data:aggregate': {
    operation: { input: 'dropdown', options: AGGREGATIONS, required: true, primary: true, helper: 'Aggregation operation.' },
    field:     { input: 'text',                                                            helper: 'Field to aggregate over (omit for count / collect).' },
  },
  'error:try': {
    retries:    { input: 'number', primary: true, helper: 'Number of retry attempts on failure.' },
    retryDelay: { input: 'number',                helper: 'Delay between retries in ms.' },
  },
  'error:catch': {
    errorTypes: { input: 'tag', primary: true, helper: 'Error types to catch. Empty = catch all.' },
  },
  'error:throw': {
    message: { input: 'textarea', required: true, primary: true, helper: 'Error message.' },
    code:    { input: 'text',                                    helper: 'Optional machine-readable error code.' },
  },
  'util:wait': {
    duration: { input: 'number', required: true, primary: true, helper: 'Wait time in milliseconds.' },
  },
  'util:log': {
    message: { input: 'textarea',  required: true, primary: true, helper: 'Log message. Supports {{PLACEHOLDERS}}.' },
    level:   { input: 'segmented', options: LOG_LEVELS, required: true,           helper: 'Log level.' },
  },
  'util:subworkflow': {
    workflowId: { input: 'workflowPicker', required: true, primary: true, helper: 'Workflow to invoke.' },
    passData:   { input: 'toggle',                                        helper: 'Pass current input through to the subworkflow.' },
  },
  'agent:agentic': {
    // Provider / model / apiKeyRef are gated off when the node is linked to
    // a specific agent (config.agent) — the agent owns those defaults. Drag
    // an agent from the palette to link; use the Detach control in the
    // drawer to switch to direct-LLM mode.
    provider:      { input: 'llmProvider', required: true,                gate: (cfg) => !cfg.agent, helper: 'LLM provider to call.' },
    model:         { input: 'llmModel',    required: true,                gate: (cfg) => !cfg.agent, helper: 'Model from the selected provider.' },
    apiKeyRef:     { input: 'credential',                                 gate: (cfg) => !cfg.agent, helper: 'Vault credential. Leave unset to fall back to system credentials.' },
    goal:          { input: 'textarea',    required: true, primary: true, helper: 'What the agent should accomplish. Supports {{PLACEHOLDERS}}.' },
    maxIterations: { input: 'number',                                     helper: 'Tool-loop iteration cap.' },
    tools:         { input: 'tools',                                      helper: "Tools available to the agent. Defaults to the agent's full tool list when linked." },
  },
  'human:task': {
    title:    { input: 'text',      required: true, primary: true, helper: 'Inbox subject line.' },
    message:  { input: 'textarea',                                 helper: 'Body of the request to the human.' },
    assignTo: { input: 'tag',       required: true,                helper: 'User IDs / role IDs / "*" for anyone.' },
    priority: { input: 'segmented', options: PRIORITIES, required: true,         helper: 'Inbox priority.' },
  },
}

const PLACEHOLDER_RE = /\{\{\s*[A-Z_][A-Z0-9_]*\s*\}\}/

export function getNodeFieldSchema(nodeType) {
  return NODE_FIELD_SCHEMA[nodeType] || null
}

export function getFieldSpec(nodeType, fieldKey) {
  return NODE_FIELD_SCHEMA[nodeType]?.[fieldKey] || null
}

export function getRequiredFields(nodeType, config = {}) {
  const schema = NODE_FIELD_SCHEMA[nodeType]
  if (!schema) return []
  return Object.entries(schema)
    .filter(([, spec]) => spec.required && (typeof spec.gate !== 'function' || spec.gate(config)))
    .map(([key]) => key)
}

/**
 * getVisibleFields — schema entries for which spec.gate(config) is true
 * (or absent). Returns ordered [key, spec] tuples — the drawer iterates
 * these and skips anything gated off.
 */
export function getVisibleFields(nodeType, config = {}) {
  const schema = NODE_FIELD_SCHEMA[nodeType]
  if (!schema) return []
  return Object.entries(schema).filter(([, spec]) => (
    typeof spec.gate !== 'function' || spec.gate(config)
  ))
}

export function getPrimaryField(nodeType) {
  const schema = NODE_FIELD_SCHEMA[nodeType]
  if (!schema) return null
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.primary) return key
  }
  // Fallback: first required, then first field.
  const required = getRequiredFields(nodeType)
  if (required.length) return required[0]
  return Object.keys(schema)[0] || null
}

function isEmptyValue(v) {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

function hasPlaceholder(v) {
  if (typeof v !== 'string') return false
  return PLACEHOLDER_RE.test(v)
}

/**
 * validateConfig — return {missing, placeholders} for one node's config.
 *  - missing: required field keys whose value is empty/missing
 *  - placeholders: field keys whose string value still contains {{TOKEN}}
 */
export function validateConfig(nodeType, config = {}) {
  const schema = NODE_FIELD_SCHEMA[nodeType]
  if (!schema) return { missing: [], placeholders: [] }

  const missing = []
  const placeholders = []

  for (const [key, spec] of Object.entries(schema)) {
    // Gated-off fields are not editable in the drawer for this config —
    // skip them entirely (no required check, no placeholder warning).
    if (typeof spec.gate === 'function' && !spec.gate(config)) continue

    const value = config[key]
    if (spec.required && isEmptyValue(value)) {
      missing.push(key)
      continue
    }
    if (hasPlaceholder(value)) {
      placeholders.push(key)
    }
  }

  return { missing, placeholders }
}

/**
 * validateWorkflow — aggregate validateConfig across all nodes.
 *  Returns { issueCount, nodes: [{nodeId, name, missing, placeholders}] }.
 */
export function validateWorkflow(nodes) {
  const result = { issueCount: 0, nodes: [] }
  if (!Array.isArray(nodes)) return result
  for (const node of nodes) {
    const { missing, placeholders } = validateConfig(node.type, node.config)
    if (missing.length || placeholders.length) {
      result.nodes.push({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        missing,
        placeholders,
      })
      result.issueCount += missing.length + placeholders.length
    }
  }
  return result
}

/** Test helper: archetype types with no schema entry (should always be []). */
export function archetypesMissingSchema() {
  return Object.keys(NODE_ARCHETYPES).filter((t) => !NODE_FIELD_SCHEMA[t])
}

export { PLACEHOLDER_RE }
