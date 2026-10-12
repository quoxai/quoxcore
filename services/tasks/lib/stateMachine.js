/**
 * State Machine — Enforced status transitions for tasks and objectives
 *
 * Stream OE Phase OE-2: QuoxEngine reliability
 *
 * Prevents invalid state transitions (e.g., completed → running).
 * Provides atomic task claiming to prevent double execution.
 * Provides DB-level objective locking for horizontal scale safety.
 */

import { getDatabase } from '../db/index.js'

// ============================================================
// Valid Transitions
// ============================================================

/**
 * Task status transitions.
 * Key = current status, Value = array of valid next statuses.
 */
export const TASK_TRANSITIONS = {
  pending:       ['running', 'skipped', 'cancelled'],
  running:       ['completed', 'failed', 'cancelled', 'waiting_child'],  // AT-1: hierarchical sub-objective
  waiting_child: ['running', 'completed', 'failed'],  // AT-1: resume when child objective completes
  completed:     [],    // terminal
  failed:        ['pending'],  // retry resets to pending
  skipped:       [],    // terminal
  cancelled:     [],    // terminal
}

/**
 * Objective status transitions.
 * Key = current status, Value = array of valid next statuses.
 */
export const OBJECTIVE_TRANSITIONS = {
  pending:                ['decomposed', 'failed', 'cancelled'],
  decomposed:             ['running', 'pending', 'cancelled'],       // pending = reject-plan re-decompose
  running:                ['paused', 'completed', 'completed_with_errors', 'failed', 'cancelled'],
  paused:                 ['running', 'cancelled'],
  completed:              ['pending'],   // rerun
  completed_with_errors:  ['pending'],   // rerun
  failed:                 ['pending'],   // rerun
  cancelled:              ['pending'],   // rerun
}

// ============================================================
// Validation Helpers (check-only, no UPDATE)
// ============================================================

/**
 * Validate a task status transition without performing it.
 * @param {string} currentStatus
 * @param {string} newStatus
 * @returns {boolean} true if valid
 */
export function isValidTaskTransition(currentStatus, newStatus) {
  const valid = TASK_TRANSITIONS[currentStatus]
  return valid ? valid.includes(newStatus) : false
}

/**
 * Validate an objective status transition without performing it.
 * @param {string} currentStatus
 * @param {string} newStatus
 * @returns {boolean} true if valid
 */
export function isValidObjectiveTransition(currentStatus, newStatus) {
  const valid = OBJECTIVE_TRANSITIONS[currentStatus]
  return valid ? valid.includes(newStatus) : false
}

// ============================================================
// Task Transitions
// ============================================================

/**
 * Transition a task to a new status with validation.
 *
 * @param {string} taskId
 * @param {string} newStatus
 * @returns {{ changed: boolean, previousStatus: string }}
 * @throws {Error} if transition is invalid
 */
export function transitionTask(taskId, newStatus) {
  const db = getDatabase()

  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const validNextStatuses = TASK_TRANSITIONS[task.status]
  if (!validNextStatuses) {
    throw new Error(`Invalid task transition: unknown status '${task.status}'`)
  }
  if (!validNextStatuses.includes(newStatus)) {
    throw new Error(`Invalid task transition: ${task.status} → ${newStatus} (allowed: ${validNextStatuses.join(', ') || 'none — terminal state'})`)
  }

  const result = db.prepare(`
    UPDATE tasks SET status = ? WHERE id = ? AND status = ?
  `).run(newStatus, taskId, task.status)

  return {
    changed: result.changes > 0,
    previousStatus: task.status,
  }
}

// ============================================================
// Objective Transitions
// ============================================================

/**
 * Transition an objective to a new status with validation.
 *
 * @param {string} objectiveId
 * @param {string} newStatus
 * @returns {{ changed: boolean, previousStatus: string }}
 * @throws {Error} if transition is invalid
 */
export function transitionObjective(objectiveId, newStatus) {
  const db = getDatabase()

  const obj = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objectiveId)
  if (!obj) throw new Error(`Objective ${objectiveId} not found`)

  const validNextStatuses = OBJECTIVE_TRANSITIONS[obj.status]
  if (!validNextStatuses) {
    throw new Error(`Invalid objective transition: unknown status '${obj.status}'`)
  }
  if (!validNextStatuses.includes(newStatus)) {
    throw new Error(`Invalid objective transition: ${obj.status} → ${newStatus} (allowed: ${validNextStatuses.join(', ') || 'none — terminal state'})`)
  }

  const result = db.prepare(`
    UPDATE objectives SET status = ? WHERE id = ? AND status = ?
  `).run(newStatus, objectiveId, obj.status)

  return {
    changed: result.changes > 0,
    previousStatus: obj.status,
  }
}

// ============================================================
// Atomic Task Claim
// ============================================================

/**
 * Atomically claim a task for execution.
 * Only succeeds if the task is currently in 'pending' status.
 *
 * @param {string} taskId
 * @param {string} instanceId — identifier of the claiming scheduler instance
 * @returns {boolean} true if claim succeeded, false if already claimed
 */
export function claimTask(taskId, instanceId) {
  const db = getDatabase()

  const result = db.prepare(`
    UPDATE tasks
    SET status = 'running',
        started_at = datetime('now'),
        claimed_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(instanceId, taskId)

  return result.changes > 0
}

// ============================================================
// Objective DB Lock
// ============================================================

const LOCK_EXPIRY_SECONDS = 300  // 5 minutes

/**
 * Acquire a DB-level lock on an objective.
 * Succeeds if unlocked or if the existing lock has expired.
 *
 * @param {string} objectiveId
 * @param {string} instanceId — identifier of the locking scheduler
 * @returns {boolean} true if lock acquired
 */
export function lockObjective(objectiveId, instanceId) {
  const db = getDatabase()

  const result = db.prepare(`
    UPDATE objectives
    SET locked_by = ?, locked_at = datetime('now')
    WHERE id = ?
    AND (locked_by IS NULL OR locked_at < datetime('now', '-${LOCK_EXPIRY_SECONDS} seconds'))
  `).run(instanceId, objectiveId)

  return result.changes > 0
}

/**
 * Release a DB-level lock on an objective.
 * Only releases if the lock is held by the specified instance.
 *
 * @param {string} objectiveId
 * @param {string} instanceId
 */
export function unlockObjective(objectiveId, instanceId) {
  const db = getDatabase()

  db.prepare(`
    UPDATE objectives
    SET locked_by = NULL, locked_at = NULL
    WHERE id = ? AND locked_by = ?
  `).run(objectiveId, instanceId)
}
