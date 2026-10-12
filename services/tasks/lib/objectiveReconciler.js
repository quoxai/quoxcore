/**
 * Objective Reconciler — TRUST-GATE 1.2
 *
 * tasks-service executes objectives via QuoxFlow (quoxflowBridge.js) and
 * syncs status back through an in-process, fire-and-forget poller
 * (pollExecutionStatus). That poller only exists in the memory of the
 * process that started it — a restart orphans every objective that was
 * `running` at the time, because the row stays `running` forever and
 * nothing resumes polling.
 *
 * This module provides:
 *   1. A boot reconciler — run once at startup, sweeps all `running`
 *      objectives and either re-attaches a poller, syncs a final status
 *      that already landed at QuoxFlow, or marks the objective failed
 *      when the execution can no longer be found.
 *   2. A periodic reaper — runs on an interval for the lifetime of the
 *      process, catching objectives whose poller died mid-flight (crash,
 *      unhandled rejection, etc.) without a full service restart, and
 *      surfacing `decomposed` objectives that have sat awaiting human
 *      approval for too long (visibility only — approval is never
 *      automated).
 *
 * Concurrency safety: every reconcile attempt is guarded by
 * stateMachine.lockObjective (5-minute expiry), so overlapping reaper
 * ticks, or a reaper tick racing the boot reconciler, cannot double-fire
 * on the same objective.
 */

import { getDatabase } from '../db/index.js'
import { emitProgress } from './progress.js'
import { pollExecutionStatus } from './quoxflowBridge.js'
import { lockObjective, unlockObjective, transitionObjective } from './stateMachine.js'
import { getInstanceNumber, startAdaptiveInterval } from './configResolver.js'

const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200'

// Config — env-overridable, sane defaults.
export const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '300000', 10) // 5 min
export const REAPER_STALE_DECOMPOSED_MS = parseInt(process.env.REAPER_STALE_DECOMPOSED_MS || '1800000', 10) // 30 min
export const REAPER_STUCK_RUNNING_MS = parseInt(process.env.REAPER_STUCK_RUNNING_MS || '120000', 10) // 2 min grace before a poller-less `running` row is considered stuck

const INSTANCE_ID = `reconciler-${process.env.HOSTNAME || 'local'}-${process.pid}`

// objectiveId -> in-flight pollExecutionStatus promise. Process-local view
// of "is a poller currently attached to this objective". Reset on restart
// by definition (new process, empty Set) — that's exactly the condition
// the boot reconciler exists to handle.
const activePollers = new Set()

let reaperHandle = null

/**
 * Track a fire-and-forget pollExecutionStatus() promise against its
 * objective so the reaper can see it's attended. Used both by the normal
 * approve-plan flow (server.js) and by this module's own re-attachment.
 */
export function trackPoll(objectiveId, pollPromise) {
  activePollers.add(objectiveId)
  pollPromise.finally(() => activePollers.delete(objectiveId))
  return pollPromise
}

export function isObjectivePolling(objectiveId) {
  return activePollers.has(objectiveId)
}

/** Test-only: clear in-memory tracking between test cases. */
export function resetReconcilerState() {
  activePollers.clear()
}

/**
 * One-shot status check against QuoxFlow for a given execution id.
 * Returns null (never throws) if the execution can't be found or
 * QuoxFlow is unreachable — that null is the "vanished" signal callers
 * treat as an orphan.
 */
export async function fetchExecutionStatus(executionId, options = {}) {
  if (!executionId) return null
  const baseUrl = options.quoxflowUrl || QUOXFLOW_URL
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
  try {
    const res = await fetch(`${baseUrl}/api/executions/${executionId}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs || 10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const exec = data?.data || data
    return exec && exec.status ? exec : null
  } catch {
    return null
  }
}

/**
 * Mark an objective failed because its QuoxFlow execution can no longer
 * be reconciled (no execution id recorded, execution vanished/unreachable,
 * or an unexpected status). Never throws — best-effort audit trail.
 */
function markOrphaned(objective, origin, detail) {
  const db = getDatabase()
  const note = origin === 'boot'
    ? `orphaned by service restart, reconciled at boot: ${detail}`
    : `stuck objective detected by reaper, reconciled at runtime: ${detail}`

  try {
    transitionObjective(objective.id, 'failed')
  } catch (err) {
    console.error(`[Reconciler] Could not transition ${objective.id} to failed:`, err.message)
    return { action: 'skipped', reason: err.message }
  }

  db.prepare(`
    UPDATE objectives SET completed_at = datetime('now'), error_message = ? WHERE id = ?
  `).run(note.slice(0, 2000), objective.id)

  console.warn(`[Reconciler] ${note} (objective=${objective.id})`)
  emitProgress(objective.id, { type: 'objective_failed', message: note, reconciled: true, origin })

  return { action: 'orphaned', reason: detail }
}

/**
 * Reconcile a single `running` objective against QuoxFlow's view of its
 * execution. Caller is responsible for holding the objective's lock.
 *
 * - No execution id recorded, execution vanished, or unreachable ->
 *   orphaned (transition to `failed`, explicit audit note).
 * - Execution still running remotely -> re-attach the status poller
 *   (fire-and-forget, tracked in activePollers).
 * - Execution already terminal (completed/failed) -> sync the final
 *   status through the normal pollExecutionStatus path (awaited, since
 *   it resolves almost immediately for an already-terminal execution).
 */
export async function reconcileRunningObjective(objective, options = {}) {
  const { origin = 'reaper', quoxflowUrl, pollOptions = {} } = options
  const db = getDatabase()

  if (!objective.quoxflow_execution_id) {
    return markOrphaned(objective, origin, 'no QuoxFlow execution id recorded')
  }

  const exec = await fetchExecutionStatus(objective.quoxflow_execution_id, { quoxflowUrl })
  if (!exec) {
    return markOrphaned(objective, origin, `QuoxFlow execution ${objective.quoxflow_execution_id} unreachable or unknown`)
  }

  const tasks = db.prepare('SELECT id FROM tasks WHERE objective_id = ? ORDER BY sequence_num ASC').all(objective.id)
  const taskIds = tasks.map(t => t.id)

  if (exec.status === 'running') {
    console.log(`[Reconciler] Re-attaching poller for objective ${objective.id} (execution ${objective.quoxflow_execution_id} still running)`)
    emitProgress(objective.id, {
      type: 'objective_reconciled',
      message: 'Execution still running remotely — status polling re-attached',
      origin,
    })
    const pollPromise = pollExecutionStatus(objective.quoxflow_execution_id, objective.id, taskIds, {
      maxPollMs: pollOptions.maxPollMs ?? (objective.max_duration_ms || 900000),
      pollInterval: pollOptions.pollInterval,
      orgId: objective.org_id,
      quoxflowUrl,
    }).catch(err => {
      console.error(`[Reconciler] Re-attached poll error for ${objective.id}:`, err.message)
    })
    trackPoll(objective.id, pollPromise)
    return { action: 'reattached' }
  }

  if (exec.status === 'completed' || exec.status === 'failed') {
    console.log(`[Reconciler] Execution ${objective.quoxflow_execution_id} already ${exec.status} — syncing final status for objective ${objective.id}`)
    emitProgress(objective.id, {
      type: 'objective_reconciled',
      message: `Execution already ${exec.status} remotely — syncing final status`,
      origin,
    })
    await pollExecutionStatus(objective.quoxflow_execution_id, objective.id, taskIds, {
      maxPollMs: pollOptions.maxPollMs ?? 5000,
      pollInterval: pollOptions.pollInterval ?? 10,
      orgId: objective.org_id,
      quoxflowUrl,
    })
    return { action: 'synced' }
  }

  return markOrphaned(objective, origin, `QuoxFlow execution returned unexpected status '${exec.status}'`)
}

/**
 * Boot reconciler — run once at startup. Finds every objective left in
 * `running` and reconciles it. Never leaves a `running` row unattended
 * after it resolves (each row is either re-attached, synced to a
 * terminal status, or explicitly failed with an audit note).
 */
export async function runBootReconciler(options = {}) {
  const db = getDatabase()
  const running = db.prepare("SELECT * FROM objectives WHERE status = 'running'").all()

  if (running.length === 0) {
    console.log('[Reconciler] Boot sweep: no running objectives to reconcile')
    return []
  }

  console.log(`[Reconciler] Boot sweep: reconciling ${running.length} running objective(s)`)

  const results = []
  for (const objective of running) {
    if (!lockObjective(objective.id, INSTANCE_ID)) {
      results.push({ objectiveId: objective.id, action: 'skipped', reason: 'lock_held' })
      continue
    }
    try {
      const result = await reconcileRunningObjective(objective, { ...options, origin: 'boot' })
      results.push({ objectiveId: objective.id, ...result })
    } catch (err) {
      console.error(`[Reconciler] Boot reconcile failed for ${objective.id}:`, err.message)
      results.push({ objectiveId: objective.id, action: 'error', reason: err.message })
    } finally {
      unlockObjective(objective.id, INSTANCE_ID)
    }
  }

  return results
}

/**
 * Periodic reaper scan:
 *   (a) `running` objectives with no attached in-process poller that
 *       have been running longer than REAPER_STUCK_RUNNING_MS -> same
 *       reconcile logic as the boot sweep.
 *   (b) `decomposed` objectives older than REAPER_STALE_DECOMPOSED_MS ->
 *       emit a visibility event only. Approval stays a human decision.
 *
 * Idempotent / double-fire safe: every reconcile attempt is guarded by
 * lockObjective, so an overlapping scan (or the boot reconciler racing a
 * reaper tick) skips an objective that's already being handled.
 */
export async function runReaperScan(options = {}) {
  const db = getDatabase()
  // SETEC S3: stored REAPER_* settings win over env/code defaults, resolved per scan.
  const stuckRunningMs = options.stuckRunningMs ?? await getInstanceNumber('REAPER_STUCK_RUNNING_MS', REAPER_STUCK_RUNNING_MS)
  const staleDecomposedMs = options.staleDecomposedMs ?? await getInstanceNumber('REAPER_STALE_DECOMPOSED_MS', REAPER_STALE_DECOMPOSED_MS)

  const summary = { reconciledRunning: [], flaggedStaleDecomposed: [] }

  // (a) Stuck running objectives.
  const stuckRunning = db.prepare(`
    SELECT * FROM objectives
    WHERE status = 'running'
    AND (started_at IS NULL OR started_at < datetime('now', ?))
  `).all(`-${Math.max(1, Math.floor(stuckRunningMs / 1000))} seconds`)

  for (const objective of stuckRunning) {
    if (isObjectivePolling(objective.id)) continue // has an attached poller — leave it alone

    if (!lockObjective(objective.id, INSTANCE_ID)) {
      summary.reconciledRunning.push({ objectiveId: objective.id, action: 'skipped', reason: 'lock_held' })
      continue
    }
    try {
      const result = await reconcileRunningObjective(objective, { ...options, origin: 'reaper' })
      summary.reconciledRunning.push({ objectiveId: objective.id, ...result })
    } catch (err) {
      console.error(`[Reaper] Reconcile failed for ${objective.id}:`, err.message)
      summary.reconciledRunning.push({ objectiveId: objective.id, action: 'error', reason: err.message })
    } finally {
      unlockObjective(objective.id, INSTANCE_ID)
    }
  }

  // (b) Stale decomposed objectives — visibility only, never auto-approved.
  const staleDecomposed = db.prepare(`
    SELECT * FROM objectives
    WHERE status = 'decomposed'
    AND created_at < datetime('now', ?)
  `).all(`-${Math.max(1, Math.floor(staleDecomposedMs / 1000))} seconds`)

  for (const objective of staleDecomposed) {
    if (!lockObjective(objective.id, INSTANCE_ID)) {
      summary.flaggedStaleDecomposed.push({ objectiveId: objective.id, action: 'skipped', reason: 'lock_held' })
      continue
    }
    try {
      const note = `Objective has been awaiting plan approval since ${objective.created_at} (over ${Math.round(staleDecomposedMs / 60000)}m) — human approval required, not auto-approved`
      console.warn(`[Reaper] ${note} (objective=${objective.id})`)
      emitProgress(objective.id, {
        type: 'objective_stale_decomposed',
        message: note,
        created_at: objective.created_at,
        reconciled: false,
      })
      summary.flaggedStaleDecomposed.push({ objectiveId: objective.id, action: 'flagged' })
    } finally {
      unlockObjective(objective.id, INSTANCE_ID)
    }
  }

  return summary
}

// --- Start / Stop ---

export function startReaper() {
  if (reaperHandle) return
  console.log(`[Reaper] Starting (interval every ${REAPER_INTERVAL_MS}ms)`)
  // SETEC S3: REAPER_INTERVAL_MS stored setting re-read each tick (live, no restart)
  reaperHandle = startAdaptiveInterval('REAPER_INTERVAL_MS', REAPER_INTERVAL_MS, () => {
    runReaperScan().catch(err => {
      console.error('[Reaper] Scan error:', err.message)
    })
  }, { unref: true })
}

export function stopReaper() {
  if (reaperHandle) {
    reaperHandle.stop()
    reaperHandle = null
  }
  console.log('[Reaper] Stopped')
}
