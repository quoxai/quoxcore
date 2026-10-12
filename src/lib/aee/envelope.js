/**
 * AEE Envelope Factory
 * Factory functions for creating AEE envelopes
 *
 * @fileoverview Provides convenient functions to create valid AEE envelopes
 */

import { ulid, prefixedUlid } from './ulid.js'
import { PROTOCOL_VERSION, validateEnvelope } from './types.js'
import { CHAT_INTENTS, QuoxAgent_INTENTS, AOCL_INTENTS, getResponseIntent } from './intents.js'

// ============================================================================
// AOCL Layer Metadata
// ============================================================================

/**
 * AOCL Layer definitions with metadata for visualization and tracking
 * Each layer has a name, label, and color for consistent UI display
 */
export const AOCL_LAYERS = {
  L0: { name: 'ingress.normalize', label: 'Normalize', color: '#6b7280', description: 'Event normalization and parsing' },
  L1: { name: 'identity.scope', label: 'Scope', color: '#3b82f6', description: 'Identity and permissions' },
  L2: { name: 'route.smart', label: 'Route', color: '#3b82f6', description: 'Smart Router classification' },
  L3: { name: 'policy.gate', label: 'Policy', color: '#f59e0b', description: 'Safety and compliance checks' },
  L4: { name: 'plan.decompose', label: 'Plan', color: '#8b5cf6', description: 'Intent decomposition' },
  L5: { name: 'context.retrieve', label: 'Context', color: '#8b5cf6', description: 'Memory and context retrieval' },
  L6: { name: 'shape.rewrite', label: 'Shape', color: '#6366f1', description: 'Prompt restructuring' },
  L7: { name: 'delegate.execute', label: 'Execute', color: '#f97316', description: 'LLM/tool execution' },
  L8: { name: 'verify.check', label: 'Verify', color: '#14b8a6', description: 'Response validation' },
  L9: { name: 'assemble.respond', label: 'Respond', color: '#22c55e', description: 'Response assembly' },
  L10: { name: 'audit.writeback', label: 'Audit', color: '#6b7280', description: 'Trace persistence' },
  L11: { name: 'config.plane', label: 'Config', color: '#38bdf8', description: 'REGULA configuration plane — settings reads and changes' }
}

/**
 * Layer display order (top to bottom in OSI-style visualization)
 */
export const AOCL_LAYER_ORDER = ['L11', 'L10', 'L9', 'L8', 'L7', 'L6', 'L5', 'L4', 'L3', 'L2', 'L1', 'L0']

/**
 * Get layer metadata by ID
 * @param {string} layerId - Layer ID (L0-L10)
 * @returns {Object|null} Layer metadata
 */
export function getLayerMetadata(layerId) {
  return AOCL_LAYERS[layerId] || null
}

/**
 * Creates a base envelope with required fields
 * @param {Object} params
 * @param {string} params.type - Envelope type
 * @param {string} params.from - Sender identifier
 * @param {string} params.to - Recipient identifier
 * @param {string} params.intent - Intent string
 * @param {string} [params.corr] - Correlation ID (generated if not provided)
 * @param {string|null} [params.reply_to] - Parent message ID
 * @param {Object} [params.payload] - Intent-specific data
 * @param {Object} [params.options] - Additional optional fields
 * @returns {import('./types.js').AEEEnvelope}
 */
function createBaseEnvelope({ type, from, to, intent, corr, reply_to = null, payload = {}, options = {} }) {
  const envelope = {
    v: PROTOCOL_VERSION,
    id: ulid(),
    ts: new Date().toISOString(),
    type,
    from,
    to,
    intent,
    corr: corr || prefixedUlid('CONV'),
    reply_to,
    payload,
    ...options
  }

  return envelope
}

/**
 * Creates a TASK envelope (request expecting a response)
 *
 * @param {string} from - Sender identifier
 * @param {string} to - Recipient identifier
 * @param {string} intent - Intent string
 * @param {Object} payload - Task data
 * @param {string} [corr] - Correlation ID (new conversation if not provided)
 * @param {Object} [options] - Additional options (priority, requires, trace)
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const task = createTask(
 *   'human.adam',
 *   'agent.cipher',
 *   'quox.chat.query',
 *   { text: 'Check disk on kuma01' }
 * )
 */
export function createTask(from, to, intent, payload, corr, options = {}) {
  return createBaseEnvelope({
    type: 'task',
    from,
    to,
    intent,
    corr,
    payload,
    options
  })
}

/**
 * Creates a RESULT envelope (response to a task)
 *
 * @param {import('./types.js').AEEEnvelope} replyTo - The task envelope being replied to
 * @param {Object} payload - Result data
 * @param {Object} [options] - Additional options
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const result = createResult(taskEnvelope, {
 *   text: 'Disk usage: 60%',
 *   success: true
 * })
 */
export function createResult(replyTo, payload, options = {}) {
  const responseIntent = getResponseIntent(replyTo.intent) || replyTo.intent.replace('.query', '.response')

  return createBaseEnvelope({
    type: 'result',
    from: replyTo.to,  // Swap from/to
    to: replyTo.from,
    intent: responseIntent,
    corr: replyTo.corr,
    reply_to: replyTo.id,
    payload,
    options
  })
}

/**
 * Creates an EVENT envelope (notification, no reply expected)
 *
 * @param {string} from - Sender identifier
 * @param {string} intent - Intent string
 * @param {Object} payload - Event data
 * @param {string} [corr] - Correlation ID
 * @param {Object} [options] - Additional options
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const heartbeat = createEvent(
 *   'quoxagent.docker01',
 *   'quoxagent.heartbeat.report',
 *   { cpu: 23.4, memory: 58.2 },
 *   'quoxagent_docker01_session'
 * )
 */
export function createEvent(from, intent, payload, corr, options = {}) {
  return createBaseEnvelope({
    type: 'event',
    from,
    to: 'system',  // Events are typically broadcast
    intent,
    corr,
    payload,
    options
  })
}

/**
 * Creates an ERROR envelope (error response)
 *
 * @param {import('./types.js').AEEEnvelope} replyTo - The envelope that caused the error
 * @param {Object} error - Error details
 * @param {string} error.code - Error code
 * @param {string} error.message - Human-readable error message
 * @param {Object} [error.details] - Additional error details
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const error = createError(taskEnvelope, {
 *   code: 'TIMEOUT',
 *   message: 'Operation timed out after 30s'
 * })
 */
export function createError(replyTo, error) {
  return createBaseEnvelope({
    type: 'error',
    from: replyTo.to,
    to: replyTo.from,
    intent: 'aee.protocol.error',
    corr: replyTo.corr,
    reply_to: replyTo.id,
    payload: {
      error_code: error.code || 'UNKNOWN',
      error_message: error.message || 'An unknown error occurred',
      details: error.details || {},
      original_intent: replyTo.intent
    }
  })
}

/**
 * Creates a STREAM envelope (chunk of streaming response)
 *
 * @param {import('./types.js').AEEEnvelope} replyTo - The task being streamed
 * @param {Object} chunk - Stream chunk data
 * @param {number} chunk.index - Chunk index
 * @param {string} chunk.content - Chunk content
 * @param {boolean} [chunk.done] - Whether stream is complete
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createStream(replyTo, chunk) {
  return createBaseEnvelope({
    type: 'stream',
    from: replyTo.to,
    to: replyTo.from,
    intent: 'quox.chat.stream_chunk',
    corr: replyTo.corr,
    reply_to: replyTo.id,
    payload: {
      index: chunk.index,
      content: chunk.content,
      done: chunk.done || false
    }
  })
}

// ============================================================================
// QUOX-Specific Convenience Functions
// ============================================================================

/**
 * Creates a chat query envelope
 *
 * @param {string} text - User's query text
 * @param {Object} [options]
 * @param {string} [options.agent] - Target agent (defaults to 'agent.quox')
 * @param {string} [options.user] - User identifier (defaults to 'human.user')
 * @param {string} [options.corr] - Correlation ID for continuing conversation
 * @param {Object} [options.context] - Additional context
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const query = createChatQuery('What is the status of docker01?')
 * const followUp = createChatQuery('And kuma01?', { corr: query.corr })
 */
export function createChatQuery(text, options = {}) {
  const {
    agent = 'agent.quox',
    user = 'human.user',
    corr,
    context = {}
  } = options

  return createTask(user, agent, CHAT_INTENTS.QUERY, {
    text,
    timestamp: Date.now(),
    ...context
  }, corr)
}

/**
 * Creates a chat response envelope
 *
 * @param {import('./types.js').AEEEnvelope} queryEnvelope - The query being responded to
 * @param {string} text - Response text
 * @param {Object} [metadata] - Additional response metadata
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createChatResponse(queryEnvelope, text, metadata = {}) {
  return createResult(queryEnvelope, {
    text,
    timestamp: Date.now(),
    ...metadata
  })
}

/**
 * Creates an QuoxAgent heartbeat envelope
 *
 * @param {string} hostId - Host identifier (e.g., 'docker01')
 * @param {Object} metrics - Heartbeat metrics
 * @param {Object} metrics.status - Health status
 * @param {Object} metrics.resources - Resource usage
 * @param {Object} metrics.agent - Agent info
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createHeartbeat(hostId, metrics) {
  return createEvent(
    `quoxagent.${hostId}`,
    QuoxAgent_INTENTS.HEARTBEAT,
    {
      status: metrics.status,
      resources: metrics.resources,
      agent: metrics.agent,
      collected_at: new Date().toISOString()
    },
    `quoxagent_${hostId}_session`
  )
}

/**
 * Creates an QuoxAgent job submission envelope
 *
 * @param {string} hostId - Target host
 * @param {string} command - Command to execute
 * @param {Object} [options]
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.user] - User submitting the job
 * @param {string} [options.corr] - Correlation ID
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createQuoxAgentJob(hostId, command, options = {}) {
  const {
    timeout = 30000,
    user = 'human.user',
    corr
  } = options

  return createTask(user, `quoxagent.${hostId}`, QuoxAgent_INTENTS.JOB_SUBMIT, {
    command,
    timeout,
    submitted_at: new Date().toISOString()
  }, corr, {
    requires: { timeout_ms: timeout }
  })
}

/**
 * Creates an QuoxAgent job result envelope
 *
 * @param {import('./types.js').AEEEnvelope} jobEnvelope - The job submission envelope
 * @param {Object} result - Job result
 * @param {string} result.output - Command output
 * @param {number} result.exit_code - Exit code
 * @param {number} [result.duration_ms] - Execution duration
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createQuoxAgentJobResult(jobEnvelope, result) {
  return createResult(jobEnvelope, {
    output: result.output,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms || 0,
    completed_at: new Date().toISOString()
  })
}

/**
 * Creates an approval request envelope
 *
 * @param {string} from - Requester
 * @param {string} action - Action requiring approval
 * @param {Object} details - Action details
 * @param {string} [corr] - Correlation ID
 * @returns {import('./types.js').AEEEnvelope}
 */
export function createApprovalRequest(from, action, details, corr) {
  return createTask(from, 'human.user', 'ops.approval.request', {
    action,
    details,
    requested_at: new Date().toISOString()
  }, corr, {
    requires: { approval: true }
  })
}

/**
 * Validates and normalizes an envelope
 *
 * @param {Object} envelope - Envelope to validate
 * @returns {{valid: boolean, envelope: import('./types.js').AEEEnvelope|null, errors: string[]}}
 */
export function validateAndNormalize(envelope) {
  const validation = validateEnvelope(envelope)

  if (!validation.valid) {
    return {
      valid: false,
      envelope: null,
      errors: validation.errors
    }
  }

  // Normalize the envelope
  const normalized = {
    v: PROTOCOL_VERSION,
    id: envelope.id,
    ts: envelope.ts,
    type: envelope.type,
    from: envelope.from,
    to: envelope.to,
    intent: envelope.intent,
    corr: envelope.corr,
    reply_to: envelope.reply_to || null,
    payload: envelope.payload || {}
  }

  // Copy optional fields if present
  if (envelope.trace) normalized.trace = envelope.trace
  if (envelope.priority) normalized.priority = envelope.priority
  if (envelope.requires) normalized.requires = envelope.requires
  if (envelope.sig) normalized.sig = envelope.sig
  if (envelope.evidence_refs) normalized.evidence_refs = envelope.evidence_refs

  return {
    valid: true,
    envelope: normalized,
    errors: []
  }
}

/**
 * Extracts conversation summary from an envelope
 *
 * @param {import('./types.js').AEEEnvelope} envelope
 * @returns {string} - Human-readable summary
 */
export function getEnvelopeSummary(envelope) {
  const { type, from, to, intent, payload, corr, ts } = envelope || {}

  // Fallback if the server returned no firstMessage (common for CHAT_*)
  // We derive something readable from the correlation id + timestamp.
  if (!type && !intent && (!payload || Object.keys(payload).length === 0)) {
    const label = deriveLabelFromCorr(corr)
    const when = ts ? formatRelativeShort(ts) : ''
    return when ? `${label} · ${when}` : label
  }

  const p = payload || {}

  // Try to extract meaningful text
  const text = p.text || p.command || p.action || ''
  const preview = text.length > 50 ? text.slice(0, 47) + '...' : text

  if (preview) {
    return preview
  }

  // Chat session start — from the MCP bridge / collector session-started event
  if (intent === 'quox.session.started') {
    const agent = p.agent_name || p.agent || 'agent'
    const kind = p.session_type === 'terminal' ? 'Terminal'
      : p.session_type === 'chat_assistant' ? 'Chat with'
      : (p.session_type || 'Session')
    return `${kind} ${agent}`.trim()
  }

  // Chat success/failure event — summarise with response length + tool count
  if (intent && intent.startsWith('quox.chat.')) {
    const action = intent.replace('quox.chat.', '')
    const agent = p.agent || (from && from.replace(/^agent\./, '')) || ''
    const tools = p.tools_used_count
    const parts = []
    if (agent) parts.push(agent)
    parts.push(action)
    if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  // Shell open event — show host + mode
  if (intent === 'quox.shell.open') {
    const host = p.hostId || p.host || 'host'
    const mode = p.mode || 'shell'
    return `${mode.toUpperCase()} → ${host}`
  }

  // Memory events
  if (intent && intent.startsWith('quox.memory.')) {
    const action = intent.replace('quox.memory.', '')
    const key = p.key || p.kind || ''
    return key ? `Memory ${action}: ${key}` : `Memory ${action}`
  }

  // For objective events, use the title if available
  if (intent && intent.startsWith('quox.objective.')) {
    const title = payload.title || payload.objective_title
    const action = intent.split('.').pop()
    if (title) return `${title} — ${action}`
    return `Objective ${action}`
  }

  // For task service events (task execution, kickback, checkpoint)
  if (intent && intent.startsWith('quox.task.')) {
    const taskTitle = payload.title || payload.task_title
    const action = intent.replace('quox.task.', '').replace(/\./g, ' ')
    if (taskTitle) return `${taskTitle} — ${action}`
    if (payload.objective_title) return `${payload.objective_title} — ${action}`
    return `Task ${action}`
  }

  // For workflow CRUD events (quox.workflow.*)
  if (intent && intent.startsWith('quox.workflow.')) {
    const wfName = payload.name || payload.workflowName
    const action = intent.replace('quox.workflow.', '').replace(/\./g, ' ')
    if (wfName) return `${wfName} — ${action}`
    return `Workflow ${action}`
  }

  // For workflow execution events (quox.flow.*)
  if (intent && intent.startsWith('quox.flow.')) {
    const wfName = payload.workflowName || payload.name
    const actionMap = {
      'quox.flow.started': 'started',
      'quox.flow.completed': 'completed',
      'quox.flow.failed': 'failed',
      'quox.flow.paused': 'paused',
      'quox.flow.resumed': 'resumed',
      'quox.flow.node.started': 'node started',
      'quox.flow.node.completed': 'node completed',
      'quox.flow.node.failed': 'node failed',
      'quox.flow.node.skipped': 'node skipped',
    }
    const action = actionMap[intent] || intent.replace('quox.flow.', '').replace(/\./g, ' ')
    if (wfName) {
      const nodeName = payload.nodeName || payload.nodeId ? ` (${payload.nodeName || payload.nodeId})` : ''
      return `${wfName}${nodeName} — ${action}`
    }
    return `Workflow ${action}`
  }

  // For approval events (quox.approval.*)
  if (intent && intent.startsWith('quox.approval.')) {
    const action = intent.split('.').pop()
    const who = payload.approver
    const wfName = payload.workflowName
    if (wfName && who) return `${wfName} — ${action} by ${who}`
    if (who) return `Approval ${action} by ${who}`
    return `Approval ${action}`
  }

  // Last-resort: if we have at least a corr, derive a label from it.
  if (corr) {
    const label = deriveLabelFromCorr(corr)
    const tail = [type, intent].filter(Boolean).join(' / ')
    return tail ? `${label} · ${tail}` : label
  }
  return `${type || 'envelope'}: ${intent || 'unknown'}`
}

/**
 * Produce a readable label from a correlation id prefix.
 * e.g. "CHAT_1776604891303_2d1eab26" → "Chat session"
 *      "mcp-1776604891523" → "MCP session"
 *      "SHELL_abc..." → "Shell session"
 * Keeps it short; callers typically append a timestamp.
 */
function deriveLabelFromCorr(corr) {
  if (!corr) return 'Untitled'
  if (corr.startsWith('CONV_') || corr.startsWith('CHAT_')) return 'Chat session'
  if (corr.startsWith('mcp-') || corr.startsWith('MCP_')) return 'MCP session'
  if (corr.startsWith('SHELL_') || corr.startsWith('shell-')) return 'Shell session'
  if (corr.startsWith('TERM_') || corr.startsWith('term-')) return 'Terminal session'
  if (corr.startsWith('WF_') || corr.startsWith('wf-') || corr.startsWith('FLOW_')) return 'Workflow run'
  if (corr.startsWith('OBJ_') || corr.startsWith('OBJECTIVE_')) return 'Objective'
  if (corr.startsWith('ACTION_')) return 'Action run'
  if (corr.startsWith('BQ_') || corr.startsWith('BROWSER_')) return 'Browser-Q run'
  if (corr.startsWith('INBOX_')) return 'Inbox item'
  if (corr.startsWith('AOCL_')) return 'AOCL run'
  if (corr.startsWith('FLEET_')) return 'Fleet op'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(corr)) return 'Chat (UUID)'
  // Matrix room-DAG receipt (`!<roomId>:quox`) or agent turn
  // (`matrix_<roomId>`) — the room id is the only display handle available,
  // so truncate it rather than falling through to the generic 'Activity' label.
  if (corr.startsWith('!')) {
    const truncated = corr.length > 24 ? corr.slice(0, 21) + '...' : corr
    return `Room ${truncated}`
  }
  if (corr.startsWith('matrix_')) {
    const roomPart = corr.slice(7)
    const truncated = roomPart.length > 20 ? roomPart.slice(0, 17) + '...' : roomPart
    return `Matrix turn ${truncated}`
  }
  // Take the prefix up to the first separator as a hint
  const m = corr.match(/^([A-Za-z]+)[_-]/)
  return m ? `${m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()} session` : 'Activity'
}

/**
 * Compact relative-time string for summary fallbacks.
 * e.g. "14:03", "Fri 11:22", "3 Apr"
 */
function formatRelativeShort(ts) {
  try {
    const d = new Date(ts)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const diffMs = now - d
    if (diffMs < 7 * 86400000) {
      return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' +
             d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

// ============================================================================
// AOCL Layer Event Factories
// ============================================================================

/**
 * Creates an AOCL layer event envelope
 *
 * Layer events track the progression through the AOCL processing pipeline.
 * Each layer can emit start, complete, bypass, or reject events.
 *
 * @param {string} layerId - Layer identifier (L0-L10)
 * @param {'start'|'complete'|'bypass'|'reject'} status - Event status
 * @param {Object} payload - Event-specific data
 * @param {string} corr - Correlation ID (links to parent run)
 * @param {Object} [options] - Additional options
 * @param {string} [options.runId] - Run ID for grouping layers
 * @param {string} [options.agent] - Current agent ID
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * const event = createLayerEvent('L2', 'complete', {
 *   handled: true,
 *   pattern: 'fleet_status',
 *   confidence: 0.92,
 *   duration_ms: 145
 * }, correlationId, { runId, agent: 'quox' })
 */
export function createLayerEvent(layerId, status, payload, corr, options = {}) {
  const layer = AOCL_LAYERS[layerId]
  if (!layer) {
    console.warn(`[AOCL] Unknown layer: ${layerId}`)
  }

  // Map status to intent
  const intentMap = {
    start: AOCL_INTENTS.LAYER_START,
    complete: AOCL_INTENTS.LAYER_COMPLETE,
    bypass: AOCL_INTENTS.LAYER_BYPASS,
    reject: AOCL_INTENTS.LAYER_REJECT
  }
  const intent = intentMap[status] || AOCL_INTENTS.LAYER_START

  return createEvent(
    options.from || 'system.aocl',
    intent,
    {
      layer: layerId,
      layerName: layer?.name || layerId,
      layerLabel: layer?.label || layerId,
      status,
      runId: options.runId,
      agent: options.agent,
      timestamp: Date.now(),
      ...payload
    },
    corr,
    {
      priority: 'low', // Layer events are observability, not critical path
      ...options
    }
  )
}

/**
 * Creates an AOCL run event envelope
 *
 * Run events mark the beginning and end of a complete AOCL processing run.
 * A run encompasses all layer events for a single request.
 *
 * @param {'start'|'complete'|'error'} status - Run status
 * @param {Object} payload - Run data
 * @param {string} corr - Correlation ID
 * @param {Object} [options] - Additional options
 * @returns {import('./types.js').AEEEnvelope}
 *
 * @example
 * // At start of processing
 * const runStart = createRunEvent('start', {
 *   query: userMessage,
 *   agent: 'quox'
 * }, correlationId)
 *
 * // After completion
 * const runComplete = createRunEvent('complete', {
 *   duration_ms: 3200,
 *   layers: ['L0', 'L2', 'L5', 'L7', 'L9'],
 *   success: true
 * }, correlationId)
 */
export function createRunEvent(status, payload, corr, options = {}) {
  const intentMap = {
    start: AOCL_INTENTS.RUN_START,
    complete: AOCL_INTENTS.RUN_COMPLETE,
    error: AOCL_INTENTS.RUN_ERROR
  }
  const intent = intentMap[status] || AOCL_INTENTS.RUN_START

  const runId = options.runId || prefixedUlid('RUN')

  return createEvent(
    options.from || 'system.aocl',
    intent,
    {
      runId,
      status,
      timestamp: Date.now(),
      ...payload
    },
    corr,
    {
      priority: 'low',
      ...options
    }
  )
}
