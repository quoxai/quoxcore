/**
 * Objectives AEE Audit Service
 * Fire-and-forget envelope logging for objective lifecycle operations.
 * Covers objective CRUD, lifecycle, task actions, checkpoints, and plan approval.
 *
 * Correlation chain: all events for a given objective share the same corr ID.
 * Priority: parentCorr (from originating chat) > OBJ_{objectiveId} > random.
 *
 * Every envelope payload captures WHO did WHAT, WHEN, and WHY — producing
 * an auditable chain that tells the full story of an objective's lifecycle.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const OBJ_INTENTS = {
  CREATED: 'quox.objective.created',
  UPDATED: 'quox.objective.updated',
  CANCELLED: 'quox.objective.cancelled',
  STARTED: 'quox.objective.started',
  PAUSED: 'quox.objective.paused',
  RESUMED: 'quox.objective.resumed',
  RERUN: 'quox.objective.rerun',
  TASK_RETRIED: 'quox.objective.task_retried',
  TASK_SKIPPED: 'quox.objective.task_skipped',
  CHECKPOINT_APPROVED: 'quox.objective.checkpoint_approved',
  CHECKPOINT_REJECTED: 'quox.objective.checkpoint_rejected',
  PLAN_APPROVED: 'quox.objective.plan_approved',
  PLAN_REJECTED: 'quox.objective.plan_rejected',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function objCorrelation(parentCorr, objectiveId) {
  // Prefer explicit parentCorr (e.g. from chat), then derive from objectiveId, then random
  return parentCorr || (objectiveId ? `OBJ_${objectiveId}` : prefixedUlid('OBJ'))
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[ObjectivesAudit]', err.message)) }
  catch (err) { console.warn('[ObjectivesAudit]', err.message) }
}

// Truncate long strings for envelope storage
function trunc(str, max = 500) {
  if (!str || typeof str !== 'string') return str
  return str.length > max ? str.slice(0, max) + '…' : str
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logObjectiveCreated(result, parentCorr) {
  fireAndForget(async () => {
    const objectiveId = result?.id
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.CREATED, {
      objectiveId,
      title: trunc(result?.title, 200),
      description: trunc(result?.description, 500),
      parentCorr: parentCorr || undefined,
      // Budget constraints
      max_tokens: result?.max_tokens || undefined,
      max_tool_calls: result?.max_tool_calls || undefined,
      max_duration_ms: result?.max_duration_ms || undefined,
      // HITL settings
      require_approval: result?.require_approval_before_start || false,
      checkpoint_after_each_task: result?.checkpoint_after_each_task || false,
      // Team context
      team_id: result?.team_id || undefined,
      team_instance_id: result?.team_instance_id || undefined,
      orchestrator_agent_id: result?.orchestrator_agent_id || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectiveUpdated(id, data, parentCorr) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.UPDATED, {
      objectiveId: id,
      title: data?.title || undefined,
      // Log field names AND values (not just names)
      changes: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, trunc(String(v), 200)])
      ),
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectiveCancelled(id, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.CANCELLED, {
      objectiveId: id,
      title: context?.title || undefined,
      status_at_cancel: context?.status || undefined,
      tasks_completed: context?.tasks_completed,
      tasks_failed: context?.tasks_failed,
      task_count: context?.task_count,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectiveStarted(id, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.STARTED, {
      objectiveId: id,
      title: context?.title || undefined,
      task_count: context?.task_count,
      team_id: context?.team_id || undefined,
      orchestrator_agent_id: context?.orchestrator_agent_id || undefined,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectivePaused(id, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.PAUSED, {
      objectiveId: id,
      title: context?.title || undefined,
      tasks_completed: context?.tasks_completed,
      tasks_failed: context?.tasks_failed,
      task_count: context?.task_count,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectiveResumed(id, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.RESUMED, {
      objectiveId: id,
      title: context?.title || undefined,
      tasks_completed: context?.tasks_completed,
      task_count: context?.task_count,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logObjectiveRerun(id, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, id)
    const event = createEvent('system.objectives', OBJ_INTENTS.RERUN, {
      objectiveId: id,
      previous_status: context?.previous_status || undefined,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logTaskRetried(objectiveId, taskId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.TASK_RETRIED, {
      objectiveId,
      taskId,
      task_title: context?.title || undefined,
      agent_id: context?.agent_id || undefined,
      retry_count: context?.retry_count,
      failure_reason: trunc(context?.failure_reason, 300),
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logTaskSkipped(objectiveId, taskId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.TASK_SKIPPED, {
      objectiveId,
      taskId,
      task_title: context?.title || undefined,
      agent_id: context?.agent_id || undefined,
      skip_reason: trunc(context?.reason, 300),
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logCheckpointApproved(objectiveId, checkpointId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.CHECKPOINT_APPROVED, {
      objectiveId,
      checkpointId,
      notes: trunc(context?.notes, 500),
      checkpoint_type: context?.type || undefined,
      task_title: context?.task_title || undefined,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logCheckpointRejected(objectiveId, checkpointId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.CHECKPOINT_REJECTED, {
      objectiveId,
      checkpointId,
      notes: trunc(context?.notes, 500),
      checkpoint_type: context?.type || undefined,
      task_title: context?.task_title || undefined,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logPlanApproved(objectiveId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.PLAN_APPROVED, {
      objectiveId,
      title: context?.title || undefined,
      task_count: context?.task_count,
      tasks: context?.tasks || undefined,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}

export function logPlanRejected(objectiveId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = objCorrelation(parentCorr, objectiveId)
    const event = createEvent('system.objectives', OBJ_INTENTS.PLAN_REJECTED, {
      objectiveId,
      title: context?.title || undefined,
      feedback: trunc(context?.feedback, 500),
      task_count: context?.task_count,
      parentCorr: parentCorr || undefined,
      timestamp: Date.now(),
    }, corr)
    await storeEnvelope(event)
  })
}
