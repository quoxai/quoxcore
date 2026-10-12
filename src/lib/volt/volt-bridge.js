/**
 * VOLT-AEE Bridge (Spec-Aligned)
 *
 * Connects VOLT event recording to the AEE pipeline.
 * Uses an observer pattern — intercepts AEE envelope storage and
 * AOCL layer events to create VOLT trace records automatically.
 *
 * Enable with: voltBridge.enable()
 * Disable with: voltBridge.disable()
 *
 * Run management:
 *   - A new VOLT run is started for each new AEE correlation ID
 *   - Runs are completed when an AOCL run.complete event is observed
 *   - Active runs are tracked by correlation ID
 *
 * Event type mapping (spec §8):
 *   task envelope    → aee.envelope.received
 *   result envelope  → aee.envelope.sent
 *   model response   → model.responded
 *   HITL requested   → hitl.requested
 *   HITL approved    → hitl.approved
 *   HITL denied      → hitl.denied
 *   Vendor types     → credential.accessed, aocl.layer.completed (per §20.2)
 */

import { startRun, recordEvent, completeRun, getActiveRuns, getRunSnapshot } from './volt-recorder.js'
import { persistContent } from './volt-store.js'
import { sha256 } from './volt-canonical.js'

/** Map of corr → { run_id, created_at } for active runs */
const corrToRun = new Map()

/** Max age for orphaned runs before cleanup (1 hour) */
const MAX_RUN_AGE_MS = 60 * 60 * 1000

/** Whether the bridge is active */
let enabled = false

/** Whether v0.2 content capture is active (opt-in, separate from bridge enable) */
let contentCaptureEnabled = false

/** Which event types capture content (configurable) */
const contentCaptureTypes = new Set([
  'tool.call.executed',
  'model.responded',
  'aee.envelope.received',
  'aee.envelope.sent',
])

/** Observability counters - exposed via getBridgeStats() */
const counters = {
  eventsRecorded: 0,
  eventsFailed: 0,
  runsStarted: 0,
  runsCompleted: 0,
  envelopesProcessed: 0,
  contentCaptured: 0,
  contentFailed: 0,
  enabledAt: null
}

/**
 * Prunes orphaned entries from corrToRun that exceed MAX_RUN_AGE_MS.
 * Called periodically from ensureRun to prevent unbounded growth.
 */
function pruneStaleCorrelations() {
  const now = Date.now()
  for (const [corr, entry] of corrToRun) {
    if (now - entry.created_at > MAX_RUN_AGE_MS) {
      corrToRun.delete(corr)
    }
  }
}

/**
 * Captures content for a VOLT event (v0.2).
 * Stores content separately from the event metadata, linked by event_id.
 * Fire-and-forget - content failures never break event recording.
 *
 * @param {Object} event - The recorded VOLT event
 * @param {Object} content - Content to capture (prompts, tool I/O, etc.)
 */
async function captureContent(event, content) {
  if (!contentCaptureEnabled) return
  if (!contentCaptureTypes.has(event.event_type)) return
  if (!content || Object.keys(content).length === 0) return

  try {
    const contentJson = JSON.stringify(content)
    const content_hash = await sha256(contentJson)

    await persistContent({
      event_id: event.event_id,
      run_id: event.run_id,
      event_type: event.event_type,
      content,
      content_hash,
    })
    counters.contentCaptured++
  } catch (err) {
    counters.contentFailed++
    console.warn('[VOLT Bridge] Content capture failed:', err.message)
  }
}

/**
 * Maps AEE envelope type + intent to VOLT event_type (spec §8).
 *
 * @param {Object} envelope - AEE envelope
 * @returns {string} VOLT event type
 */
function mapEnvelopeToEventType(envelope) {
  const { type, intent } = envelope

  // AOCL layer events (vendor namespace per §20.2)
  if (intent?.startsWith('aocl.layer.')) {
    return 'aocl.layer.completed'
  }
  if (intent?.startsWith('aocl.run.')) {
    const status = envelope.payload?.status
    if (status === 'start') return 'run.started'
    if (status === 'complete') return 'run.completed'
    if (status === 'error') return 'run.completed'
    return 'aocl.run.event'
  }

  // AOCL policy events (vendor namespace per §20.2)
  if (intent?.includes('policy')) {
    return 'aocl.policy.evaluated'
  }

  // HITL events (spec §8)
  if (intent?.includes('approval')) {
    if (type === 'task') return 'hitl.requested'
    if (type === 'result') {
      const approved = envelope.payload?.approved
      return approved ? 'hitl.approved' : 'hitl.denied'
    }
  }

  // Standard message types (spec §8)
  if (type === 'task') return 'aee.envelope.received'
  if (type === 'result') return 'aee.envelope.sent'
  if (type === 'error') return 'aee.envelope.sent'
  if (type === 'stream') return 'aee.envelope.sent'
  if (type === 'event') return 'aee.envelope.sent'

  return `aee.${type || 'unknown'}`
}

/**
 * Extracts the agent ID from an AEE envelope.
 * @param {Object} envelope
 * @returns {string}
 */
function extractAgentId(envelope) {
  // AEE from field is like "agent.sentinel" or "human.adam"
  const from = envelope.from || 'system'
  if (from.startsWith('agent.')) return from.slice(6)
  if (from.startsWith('human.')) return from.slice(6)
  if (from.startsWith('system.')) return from.slice(7)
  if (from.startsWith('tool.')) return from.slice(5)
  return from
}

/**
 * Extracts the actor_type from an AEE envelope's `from` field.
 * @param {Object} envelope
 * @returns {string}
 */
function extractActorType(envelope) {
  const from = envelope.from || 'system'
  if (from.startsWith('agent.')) return 'agent'
  if (from.startsWith('human.')) return 'human'
  if (from.startsWith('system.')) return 'system'
  if (from.startsWith('tool.')) return 'tool'
  return 'agent'
}

/**
 * Gets or creates a VOLT run for a given correlation ID.
 *
 * @param {string} corr - AEE correlation ID
 * @param {string} agent_id - Agent that triggered this
 * @returns {Promise<string>} run_id
 */
async function ensureRun(corr, agent_id) {
  // Periodically prune stale entries (cheap — only iterates on ensureRun calls)
  if (corrToRun.size > 50) {
    pruneStaleCorrelations()
  }

  const existing = corrToRun.get(corr)
  if (existing) {
    return existing.run_id
  }

  const { run_id } = await startRun({
    corr,
    agent_id,
    payload: { source: 'aee-bridge' }
  })

  corrToRun.set(corr, { run_id, created_at: Date.now() })
  counters.runsStarted++
  return run_id
}

/**
 * Records an AEE envelope as a VOLT trace event.
 * Called automatically when the bridge is enabled and an envelope is stored.
 *
 * @param {Object} envelope - AEE envelope
 * @returns {Promise<Object|null>} VOLT event or null if bridge disabled
 */
export async function onEnvelopeStored(envelope) {
  if (!enabled) return null
  if (!envelope?.corr) return null

  // Skip AOCL run start/complete events — these map to VOLT run lifecycle
  const intent = envelope.intent || ''
  if (intent === 'aocl.run.start' || intent === 'aocl.run.complete' || intent === 'aocl.run.error') {
    return handleRunLifecycle(envelope)
  }

  try {
    counters.envelopesProcessed++
    const agent_id = extractAgentId(envelope)
    const actor_type = extractActorType(envelope)
    const run_id = await ensureRun(envelope.corr, agent_id)
    const event_type = mapEnvelopeToEventType(envelope)

    const event = await recordEvent({
      run_id,
      event_type,
      agent_id,
      actor_type,
      corr: envelope.corr,
      envelope_id: envelope.id,
      payload: {
        envelope_type: envelope.type,
        intent,
        from: envelope.from,
        to: envelope.to,
        // Store payload summary, not full payload (can be large)
        payload_keys: Object.keys(envelope.payload || {}),
        priority: envelope.priority
      }
    })
    counters.eventsRecorded++

    // v0.2: Capture envelope content (fire-and-forget)
    if (envelope.payload) {
      captureContent(event, {
        envelope_payload: envelope.payload,
      })
    }

    return event
  } catch (err) {
    // VOLT recording failures should never break the AEE pipeline
    counters.eventsFailed++
    console.warn('[VOLT Bridge] Recording failed:', err.message)
    return null
  }
}

/**
 * Handles AOCL run lifecycle events (start/complete/error).
 * These map directly to VOLT run boundaries.
 *
 * @param {Object} envelope - AOCL run event envelope
 * @returns {Promise<Object|null>}
 */
async function handleRunLifecycle(envelope) {
  const status = envelope.payload?.status
  const corr = envelope.corr

  try {
    // AOCL run.start — ensure VOLT run exists with AOCL metadata
    if (status === 'start') {
      const agent_id = extractAgentId(envelope)
      await ensureRun(corr, agent_id)
      return null // Run creation is the side effect; no separate event needed
    }

    if (status === 'complete' || status === 'error') {
      const entry = corrToRun.get(corr)
      if (entry) {
        const run_id = entry.run_id
        const { event } = await completeRun({
          run_id,
          agent_id: extractAgentId(envelope),
          status: status === 'complete' ? 'success' : 'error',
          summary: {
            duration_ms: envelope.payload?.duration_ms,
            layers: envelope.payload?.layers,
            agent: envelope.payload?.agent
          }
        })
        corrToRun.delete(corr)
        counters.runsCompleted++
        counters.eventsRecorded++
        return event
      }
    }
  } catch (err) {
    counters.eventsFailed++
    console.warn('[VOLT Bridge] Run lifecycle handling failed:', err.message)
  }

  return null
}

/**
 * Records a tool call event.
 * Call this from tool execution middleware.
 *
 * @param {Object} options
 * @param {string} options.corr - AEE correlation ID
 * @param {string} options.agent_id - Agent calling the tool
 * @param {string} options.tool - Tool name
 * @param {string} [options.phase='requested'] - 'requested' or 'executed'
 * @param {Object} [options.result={}] - Tool result metadata (NOT raw output)
 * @param {Object} [options.content] - v0.2: Full tool args and output for content capture
 * @param {Object} [options.content.tool_args] - Arguments passed to the tool
 * @param {string} [options.content.tool_output] - Raw output from the tool
 * @returns {Promise<Object|null>}
 */
export async function onToolCall({ corr, agent_id, tool, phase = 'requested', result = {}, content }) {
  if (!enabled || !corr) return null

  try {
    const run_id = await ensureRun(corr, agent_id)
    const event = await recordEvent({
      run_id,
      event_type: phase === 'executed' ? 'tool.call.executed' : 'tool.call.requested',
      agent_id,
      actor_type: 'tool',
      corr,
      payload: {
        tool,
        ...result
      }
    })
    counters.eventsRecorded++

    // v0.2: Capture tool content (fire-and-forget)
    if (content) {
      captureContent(event, { tool_name: tool, ...content })
    }

    return event
  } catch (err) {
    counters.eventsFailed++
    console.warn('[VOLT Bridge] Tool call recording failed:', err.message)
    return null
  }
}

/**
 * Records a model response event (spec §8: model.responded).
 *
 * @param {Object} options
 * @param {string} options.corr - AEE correlation ID
 * @param {string} options.agent_id - Agent that invoked the model
 * @param {string} options.model_id - Model identifier (e.g., 'claude-sonnet-4-6')
 * @param {string} options.provider - Provider (e.g., 'anthropic')
 * @param {Object} [options.usage={}] - Token usage { input_tokens, output_tokens }
 * @param {string} [options.stop_reason] - Why the model stopped
 * @param {Object} [options.content] - v0.2: Full prompts and response for content capture
 * @param {string} [options.content.system_prompt] - System prompt sent to model
 * @param {string} [options.content.user_prompt] - User message / task prompt
 * @param {string} [options.content.model_response] - Model's full response
 * @returns {Promise<Object|null>}
 */
export async function onModelResponse({ corr, agent_id, model_id, provider, usage = {}, stop_reason, content }) {
  if (!enabled || !corr) return null

  try {
    const run_id = await ensureRun(corr, agent_id)
    const event = await recordEvent({
      run_id,
      event_type: 'model.responded',
      agent_id,
      actor_type: 'system',
      corr,
      payload: {
        model_id,
        provider,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        stop_reason
      }
    })
    counters.eventsRecorded++

    // v0.2: Capture model content (fire-and-forget)
    if (content) {
      captureContent(event, { model_id, provider, ...content })
    }

    return event
  } catch (err) {
    counters.eventsFailed++
    console.warn('[VOLT Bridge] Model response recording failed:', err.message)
    return null
  }
}

/**
 * Records a credential access event (vendor namespace per §20.2).
 *
 * @param {Object} options
 * @param {string} options.corr - AEE correlation ID
 * @param {string} options.credential_id - Vault credential ID (NOT the secret)
 * @param {string} options.credential_type - Integration type (e.g., 'openai')
 * @param {string} options.agent_id - Agent accessing the credential
 * @returns {Promise<Object|null>}
 */
export async function onCredentialAccessed({ corr, credential_id, credential_type, agent_id }) {
  if (!enabled || !corr) return null

  try {
    const run_id = await ensureRun(corr, agent_id)
    const event = await recordEvent({
      run_id,
      event_type: 'credential.accessed',
      agent_id,
      actor_type: 'agent',
      corr,
      payload: {
        credential_id,
        credential_type
      }
    })
    counters.eventsRecorded++
    return event
  } catch (err) {
    counters.eventsFailed++
    console.warn('[VOLT Bridge] Credential access recording failed:', err.message)
    return null
  }
}

/**
 * Gets the VOLT run ID for a given AEE correlation ID.
 * @param {string} corr
 * @returns {string|undefined}
 */
export function getRunForCorrelation(corr) {
  const entry = corrToRun.get(corr)
  return entry?.run_id
}

/**
 * Gets all correlation → run_id mappings.
 * @returns {Map<string, string>}
 */
export function getActiveCorrelations() {
  const result = new Map()
  for (const [corr, entry] of corrToRun) {
    result.set(corr, entry.run_id)
  }
  return result
}

/**
 * Returns bridge observability stats.
 * @returns {Object} Snapshot of counters + state
 */
export function getBridgeStats() {
  return {
    enabled,
    activeCorrelations: corrToRun.size,
    ...counters
  }
}

/** The bridge singleton */
const voltBridge = {
  /** Enable VOLT recording */
  enable() {
    enabled = true
    counters.enabledAt = Date.now()
    console.log('[VOLT] Bridge enabled - recording AEE events')
  },

  /** Disable VOLT recording */
  disable() {
    enabled = false
    console.log('[VOLT] Bridge disabled')
  },

  /** Check if bridge is active */
  isEnabled() {
    return enabled
  },

  /** Enable v0.2 content capture (stores full prompts, tool I/O, responses) */
  enableContentCapture() {
    contentCaptureEnabled = true
    console.log('[VOLT] Content capture enabled (v0.2)')
  },

  /** Disable content capture */
  disableContentCapture() {
    contentCaptureEnabled = false
  },

  /** Check if content capture is active */
  isContentCaptureEnabled() {
    return contentCaptureEnabled
  },

  /** Reset bridge state (for testing) */
  _reset() {
    enabled = false
    contentCaptureEnabled = false
    corrToRun.clear()
    counters.eventsRecorded = 0
    counters.eventsFailed = 0
    counters.runsStarted = 0
    counters.runsCompleted = 0
    counters.envelopesProcessed = 0
    counters.contentCaptured = 0
    counters.contentFailed = 0
    counters.enabledAt = null
  }
}

export default voltBridge
