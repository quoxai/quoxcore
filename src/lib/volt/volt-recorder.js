/**
 * VOLT Event Recorder — V0.1 (Spec-Aligned)
 *
 * Records trace events into hash-chained NDJSON runs.
 * Each event contains:
 *   volt_version, event_id, run_id, seq, ts, event_type,
 *   actor, context, payload, prev_hash, hash
 *
 * Hash chain: SHA-256 of canonical JSON (excluding the `hash` field itself).
 * Genesis event (seq 1) has prev_hash = 64 zeros.
 *
 * Supports multiple concurrent runs. Each run is independent.
 */

import { canonicalize, sha256 } from './volt-canonical.js'
import { prefixedUlid } from '../aee/ulid.js'

const VOLT_VERSION = '0.1'
const GENESIS_HASH = '0'.repeat(64)
const HASH_ALG = 'sha256'

/**
 * @typedef {Object} VoltActor
 * @property {string} actor_type - 'agent'|'human'|'system'|'tool'|'runner'
 * @property {string} actor_id - Unique identifier for the actor
 * @property {string} [display_name] - Optional display name
 * @property {string} [org_id] - Optional organization ID
 */

/**
 * @typedef {Object} VoltContext
 * @property {string} correlation_id - AEE correlation ID
 * @property {string} [aee_envelope_id] - AEE envelope ID (if applicable)
 * @property {string} [aocl_policy_id] - AOCL policy ID (if applicable)
 * @property {string[]} [tags] - Optional tags
 */

/**
 * @typedef {Object} VoltEvent
 * @property {string} volt_version - Schema version
 * @property {string} event_id - Unique event identifier (stable across redaction)
 * @property {string} run_id - Run identifier
 * @property {number} seq - Sequence number within run (starts at 1)
 * @property {string} ts - ISO 8601 timestamp
 * @property {string} event_type - Namespaced event type
 * @property {VoltActor} actor - Actor that produced this event
 * @property {VoltContext} context - Correlation and linkage context
 * @property {string} hash_alg - Hash algorithm used
 * @property {Object} payload - Event-specific data
 * @property {string} prev_hash - SHA-256 of previous event
 * @property {string} hash - SHA-256 of this event's canonical JSON
 */

/**
 * @typedef {Object} RunState
 * @property {string} run_id
 * @property {string} corr
 * @property {number} seq - Next sequence number
 * @property {string} head_hash - Hash of the most recent event
 * @property {VoltEvent[]} events - All events in this run
 * @property {string} status - 'active' | 'completed' | 'error'
 * @property {string} started_at - ISO timestamp
 * @property {string|null} completed_at - ISO timestamp
 */

/** Active runs keyed by run_id */
const runs = new Map()

/** Listener hooks for persistence layer */
const listeners = {
  onEvent: [],
  onRunChange: []
}

/**
 * Register a callback for every recorded event.
 * @param {function(VoltEvent): void} callback
 * @returns {function(): void} Unsubscribe function
 */
export function _onEvent(callback) {
  listeners.onEvent.push(callback)
  return () => {
    const idx = listeners.onEvent.indexOf(callback)
    if (idx >= 0) listeners.onEvent.splice(idx, 1)
  }
}

/**
 * Register a callback for run state changes (start, complete).
 * @param {function(RunState): void} callback
 * @returns {function(): void} Unsubscribe function
 */
export function _onRunChange(callback) {
  listeners.onRunChange.push(callback)
  return () => {
    const idx = listeners.onRunChange.indexOf(callback)
    if (idx >= 0) listeners.onRunChange.splice(idx, 1)
  }
}

/** Fire event listeners (fire-and-forget, non-blocking) */
function notifyEvent(event) {
  for (const cb of listeners.onEvent) {
    try { cb(event) } catch (_) { /* non-blocking */ }
  }
}

/** Fire run change listeners (fire-and-forget, non-blocking) */
function notifyRunChange(run_id) {
  const snapshot = getRunSnapshot(run_id)
  if (!snapshot) return
  for (const cb of listeners.onRunChange) {
    try { cb(snapshot) } catch (_) { /* non-blocking */ }
  }
}

/**
 * Computes the hash of a VOLT event.
 * The `hash` field is excluded from the computation.
 *
 * @param {Object} eventWithoutHash - Event object without the `hash` field
 * @returns {Promise<string>} SHA-256 hex string
 */
async function computeEventHash(eventWithoutHash) {
  const canonical = canonicalize(eventWithoutHash)
  return sha256(canonical)
}

/**
 * Starts a new VOLT run.
 *
 * @param {Object} options
 * @param {string} options.corr - AEE correlation ID
 * @param {string} [options.agent_id='system'] - Starting agent ID
 * @param {string} [options.actor_type='system'] - Actor type for genesis
 * @param {Object} [options.payload={}] - Additional run start metadata
 * @returns {Promise<{run_id: string, event: VoltEvent}>}
 */
export async function startRun({ corr, agent_id = 'system', actor_type = 'system', payload = {} }) {
  const run_id = prefixedUlid('RUN')
  const now = new Date().toISOString()

  const runState = {
    run_id,
    corr,
    seq: 1,
    head_hash: GENESIS_HASH,
    events: [],
    status: 'active',
    started_at: now,
    completed_at: null
  }

  runs.set(run_id, runState)

  const event = await recordEvent({
    run_id,
    event_type: 'run.started',
    agent_id,
    actor_type,
    corr,
    envelope_id: null,
    payload: { ...payload, started_at: now }
  })

  notifyRunChange(run_id)

  return { run_id, event }
}

/**
 * Records a single trace event into an active run.
 *
 * @param {Object} options
 * @param {string} options.run_id - Run to append to
 * @param {string} options.event_type - Event type (e.g., 'tool.call.executed')
 * @param {string} options.agent_id - Actor ID (convenience param, maps to actor.actor_id)
 * @param {string} [options.actor_type='agent'] - Actor type
 * @param {string} options.corr - AEE correlation ID (maps to context.correlation_id)
 * @param {string|null} [options.envelope_id=null] - AEE envelope ID (maps to context.aee_envelope_id)
 * @param {Object} [options.context={}] - Extra context fields
 * @param {Object} [options.payload={}] - Event payload
 * @returns {Promise<VoltEvent>}
 * @throws {Error} If run doesn't exist or is not active
 */
export async function recordEvent({
  run_id,
  event_type,
  agent_id,
  actor_type = 'agent',
  corr,
  envelope_id = null,
  context = {},
  payload = {}
}) {
  const run = runs.get(run_id)
  if (!run) {
    throw new Error(`VOLT: Run ${run_id} not found`)
  }
  if (run.status !== 'active') {
    throw new Error(`VOLT: Run ${run_id} is ${run.status}, cannot record events`)
  }

  const seq = run.seq
  const ts = new Date().toISOString()
  const prev_hash = run.head_hash
  const event_id = prefixedUlid('EVT')

  // Build structured actor object
  const actor = {
    actor_type,
    actor_id: agent_id
  }

  // Build structured context object
  const eventContext = {
    correlation_id: corr,
    ...(envelope_id ? { aee_envelope_id: envelope_id } : {}),
    ...context
  }

  // Build event without hash (hash is computed from canonical form of this)
  const eventBody = {
    volt_version: VOLT_VERSION,
    event_id,
    run_id,
    seq,
    ts,
    event_type,
    actor,
    context: eventContext,
    hash_alg: HASH_ALG,
    payload,
    prev_hash
  }

  const hash = await computeEventHash(eventBody)

  const event = { ...eventBody, hash }

  // Update run state
  run.events.push(event)
  run.seq = seq + 1
  run.head_hash = hash

  notifyEvent(event)

  return event
}

/**
 * Completes a run, recording the final event.
 *
 * @param {Object} options
 * @param {string} options.run_id - Run to complete
 * @param {string} [options.agent_id='system'] - Agent completing the run
 * @param {string} [options.status='success'] - Completion status
 * @param {Object} [options.summary={}] - Run summary data
 * @returns {Promise<{event: VoltEvent, run: RunState}>}
 * @throws {Error} If run doesn't exist or is not active
 */
export async function completeRun({
  run_id,
  agent_id = 'system',
  status = 'success',
  summary = {}
}) {
  const run = runs.get(run_id)
  if (!run) {
    throw new Error(`VOLT: Run ${run_id} not found`)
  }
  if (run.status !== 'active') {
    throw new Error(`VOLT: Run ${run_id} is ${run.status}, cannot complete`)
  }

  const now = new Date().toISOString()

  const event = await recordEvent({
    run_id,
    event_type: 'run.completed',
    agent_id,
    actor_type: 'system',
    corr: run.corr,
    envelope_id: null,
    payload: {
      status,
      completed_at: now,
      event_count: run.events.length + 1, // +1 for this event itself (already pushed by recordEvent)
      ...summary
    }
  })

  run.status = status === 'success' ? 'completed' : 'error'
  run.completed_at = now

  notifyRunChange(run_id)

  return { event, run: getRunSnapshot(run_id) }
}

/**
 * Gets a snapshot of a run's current state.
 *
 * @param {string} run_id
 * @returns {RunState|null}
 */
export function getRunSnapshot(run_id) {
  const run = runs.get(run_id)
  if (!run) return null

  return {
    run_id: run.run_id,
    corr: run.corr,
    seq: run.seq,
    head_hash: run.head_hash,
    events: [...run.events],
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at
  }
}

/**
 * Gets all events for a run as NDJSON string.
 *
 * @param {string} run_id
 * @returns {string|null} NDJSON string (one JSON object per line)
 */
export function exportRunAsNDJSON(run_id) {
  const run = runs.get(run_id)
  if (!run) return null

  return run.events.map(e => JSON.stringify(e)).join('\n') + '\n'
}

/**
 * Gets all active run IDs.
 * @returns {string[]}
 */
export function getActiveRuns() {
  return [...runs.entries()]
    .filter(([, r]) => r.status === 'active')
    .map(([id]) => id)
}

/**
 * Gets all run IDs (active + completed).
 * @returns {string[]}
 */
export function getAllRunIds() {
  return [...runs.keys()]
}

/**
 * Removes a completed/errored run from memory.
 * Active runs cannot be pruned.
 *
 * @param {string} run_id
 * @returns {boolean} True if removed
 */
export function pruneRun(run_id) {
  const run = runs.get(run_id)
  if (!run || run.status === 'active') return false
  runs.delete(run_id)
  return true
}

/**
 * Clears all runs and listeners. For testing purposes only.
 */
export function _resetAllRuns() {
  runs.clear()
  listeners.onEvent = []
  listeners.onRunChange = []
}

export { VOLT_VERSION, GENESIS_HASH, HASH_ALG }
