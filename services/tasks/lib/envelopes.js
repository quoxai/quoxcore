// Server-side AEE envelope factory for the task service
// Lightweight envelope creation + SQLite storage (no IndexedDB)
// Also forwards envelopes to the collector AEE store for unified activity view.
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'

// SEC-PLUGIN-TRUST H2: /aee/sync is now gated (see collector
// utils/httpAuth.js requireAeeAuth). This forwarder previously sent no auth
// at all; add the internal service key so it keeps working once the
// collector flips AEE_ENDPOINT_AUTH_ENFORCE=true.
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

/**
 * AEE intent constants (server-side mirror of src/lib/aee/intents.js TASK_INTENTS)
 */
export const TASK_INTENTS = {
  OBJECTIVE_CREATED: 'quox.task.objective.created',
  OBJECTIVE_DECOMPOSED: 'quox.task.objective.decomposed',
  OBJECTIVE_STARTED: 'quox.task.objective.started',
  OBJECTIVE_PAUSED: 'quox.task.objective.paused',
  OBJECTIVE_COMPLETED: 'quox.task.objective.completed',
  OBJECTIVE_FAILED: 'quox.task.objective.failed',
  TASK_STARTED: 'quox.task.task.started',
  TASK_COMPLETED: 'quox.task.task.completed',
  TASK_FAILED: 'quox.task.task.failed',
  CHECKPOINT_CREATED: 'quox.task.checkpoint.created',
  CHECKPOINT_APPROVED: 'quox.task.checkpoint.approved',
  CHECKPOINT_REJECTED: 'quox.task.checkpoint.rejected',
  // Stream E4: Autonomous Workflows
  TEAM_SCHEDULE_TRIGGERED: 'quox.task.schedule.triggered',
  TEAM_SCHEDULE_COMPLETED: 'quox.task.schedule.completed',
  TEAM_SCHEDULE_FAILED: 'quox.task.schedule.failed',
}

/**
 * Create an AEE-shaped envelope object and store it in the database.
 *
 * @param {object} params
 * @param {string} params.type - Envelope type: 'event' | 'task' | 'result'
 * @param {string} params.from - Sender address (e.g., 'service.tasks')
 * @param {string} params.to - Recipient address (e.g., 'agent.quox')
 * @param {string} params.intent - Intent string (e.g., 'quox.task.task.started')
 * @param {object} params.payload - Event payload data
 * @param {string} params.corrId - AEE correlation ID
 * @param {string} [params.objectiveId] - Associated objective ID
 * @param {string} [params.taskId] - Associated task ID
 * @returns {object} The stored envelope
 */
export function createTaskEnvelope({ type, from, to, intent, payload, corrId, objectiveId, taskId }) {
  const envelope = {
    v: '1',
    id: ulid(),
    ts: new Date().toISOString(),
    type: type || 'event',
    from: from || 'service.tasks',
    to: to || 'system',
    intent,
    corr: corrId || null,
    reply_to: null,
    payload: payload || {}
  }

  // Store in database
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO envelopes (id, corr_id, type, intent, from_addr, to_addr, payload, objective_id, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.id,
      envelope.corr,
      envelope.type,
      envelope.intent,
      envelope.from,
      envelope.to,
      JSON.stringify(envelope.payload),
      objectiveId || null,
      taskId || null,
      envelope.ts
    )
  } catch (error) {
    console.error('[Envelopes] Storage error:', error.message)
  }

  // Forward to collector AEE store for unified activity view (fire-and-forget)
  forwardToCollector(envelope)

  return envelope
}

/**
 * Forward an envelope to the collector's AEE sync endpoint.
 * Fire-and-forget — failures are logged but don't block task execution.
 */
function forwardToCollector(envelope) {
  try {
    fetch(`${COLLECTOR_URL}/aee/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({ envelopes: [envelope] }),
    }).catch(err => {
      // Silent — collector may not be running during tests
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Envelopes] Forward to collector failed:', err.message)
      }
    })
  } catch {
    // fetch not available or other error — ignore
  }
}

/**
 * True when an envelope carrying this intent has already been written for
 * this task.
 *
 * The task poller is not run-once: objectiveReconciler re-polls an objective
 * whose in-process poller died with the box it ran on, so the same task can
 * be walked twice. The tasks-table UPDATE is idempotent, but an envelope
 * INSERT is not, and a lifecycle transition that happened once must appear
 * once in the evidence trail. Failure to read is treated as "not present":
 * a missing envelope is a worse outcome than a duplicate one.
 *
 * @param {string} taskId
 * @param {string} intent
 * @returns {boolean}
 */
export function hasTaskEnvelope(taskId, intent) {
  if (!taskId || !intent) return false
  try {
    const db = getDatabase()
    return !!db.prepare(
      'SELECT 1 AS found FROM envelopes WHERE task_id = ? AND intent = ? LIMIT 1'
    ).get(taskId, intent)
  } catch (error) {
    console.error('[Envelopes] Dedup lookup error:', error.message)
    return false
  }
}

/**
 * Retrieve all envelopes for an objective.
 * @param {string} objectiveId
 * @returns {object[]}
 */
export function getEnvelopesForObjective(objectiveId) {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT * FROM envelopes WHERE objective_id = ? ORDER BY created_at ASC
  `).all(objectiveId)

  return rows.map(row => ({
    v: '1',
    id: row.id,
    ts: row.created_at,
    type: row.type,
    from: row.from_addr,
    to: row.to_addr,
    intent: row.intent,
    corr: row.corr_id,
    payload: JSON.parse(row.payload || '{}'),
    objective_id: row.objective_id,
    task_id: row.task_id
  }))
}
