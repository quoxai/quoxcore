/**
 * Workflow AEE Audit Service
 * Fire-and-forget envelope logging for workflow lifecycle and execution events.
 * Covers CRUD (create/update/delete) and execution (triggered/completed/failed).
 * Follows the objectivesAudit.js pattern with rich audit payloads.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function trunc(str, max = 500) {
  if (!str || typeof str !== 'string') return str
  return str.length > max ? str.slice(0, max) + '…' : str
}

function wfCorrelation(parentCorr, workflowId) {
  return parentCorr || `WF_${workflowId || prefixedUlid('WF')}`
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[WorkflowAudit]', err.message)) }
  catch (err) { console.warn('[WorkflowAudit]', err.message) }
}

/**
 * Summarise a workflow's node types for audit context.
 */
function summariseNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined
  const types = {}
  for (const n of nodes) {
    const t = n.type || 'unknown'
    types[t] = (types[t] || 0) + 1
  }
  return types
}

/**
 * Extract trigger type from workflow nodes.
 */
function getTriggerType(workflow) {
  const nodes = workflow?.nodes || workflow?.definition?.nodes || []
  const trigger = nodes.find(n => n.type && n.type.startsWith('trigger:'))
  return trigger?.type || undefined
}

// ─── Intents ─────────────────────────────────────────────────────────

export const WORKFLOW_INTENTS = {
  CREATED: 'quox.workflow.created',
  UPDATED: 'quox.workflow.updated',
  DELETED: 'quox.workflow.deleted',
  EXECUTED: 'quox.workflow.executed',
  EXECUTION_COMPLETED: 'quox.workflow.execution.completed',
  EXECUTION_FAILED: 'quox.workflow.execution.failed',
  DUPLICATED: 'quox.workflow.duplicated',
  SCHEDULE_UPDATED: 'quox.workflow.schedule.updated',
  SCHEDULE_PAUSED: 'quox.workflow.schedule.paused',
  SCHEDULE_RESUMED: 'quox.workflow.schedule.resumed',
}

// ─── Logging Functions ───────────────────────────────────────────────

/**
 * Log workflow creation with full context.
 * @param {object} workflow - The created workflow object
 * @param {string} [parentCorr] - Originating correlation ID
 */
export function logWorkflowCreated(workflow, parentCorr) {
  fireAndForget(async () => {
    const nodes = workflow?.nodes || workflow?.definition?.nodes || []
    const corr = wfCorrelation(parentCorr, workflow?.id)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.CREATED,
      {
        workflowId: workflow?.id,
        name: trunc(workflow?.name, 200),
        description: trunc(workflow?.description),
        node_count: nodes.length || undefined,
        node_types: summariseNodes(nodes),
        trigger_type: getTriggerType(workflow),
        tags: workflow?.tags || workflow?.metadata?.tags || undefined,
        scope: workflow?.metadata?.scope || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow update with what changed.
 * @param {string} workflowId
 * @param {object} updates - The fields being updated
 * @param {string} [parentCorr]
 */
export function logWorkflowUpdated(workflowId, updates, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.UPDATED,
      {
        workflowId,
        fields: Object.keys(updates || {}),
        name: updates?.name ? trunc(updates.name, 200) : undefined,
        description: updates?.description ? trunc(updates.description) : undefined,
        tags: updates?.tags || undefined,
        scope: updates?.metadata?.scope || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow deletion with context.
 * @param {string} workflowId
 * @param {string} [parentCorr]
 * @param {object} [context] - Workflow metadata captured before deletion
 */
export function logWorkflowDeleted(workflowId, parentCorr, context) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.DELETED,
      {
        workflowId,
        name: trunc(context?.name, 200),
        had_nodes: context?.node_count || undefined,
        was_active: context?.active,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow execution triggered by user.
 * @param {string} workflowId
 * @param {object} [context] - Workflow + trigger context
 * @param {string} [parentCorr]
 */
export function logWorkflowExecuted(workflowId, context, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.EXECUTED,
      {
        workflowId,
        name: trunc(context?.name, 200),
        trigger: 'manual',
        has_trigger_data: !!context?.triggerData,
        trigger_data_keys: context?.triggerData ? Object.keys(context.triggerData) : undefined,
        node_count: context?.node_count || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow execution completed with results.
 * @param {string} workflowId
 * @param {object} result - Execution result from QuoxFlow
 * @param {object} [context] - Workflow context
 * @param {string} [parentCorr]
 */
export function logWorkflowExecutionCompleted(workflowId, result, context, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const execData = result?.data || result
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.EXECUTION_COMPLETED,
      {
        workflowId,
        name: trunc(context?.name, 200),
        executionId: execData?.executionId || execData?.stored?.id,
        duration: execData?.duration || undefined,
        envelope_count: execData?.envelopes?.length || undefined,
        was_paused: execData?.paused || false,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow execution failure with error context.
 * @param {string} workflowId
 * @param {Error|object} error - The error that occurred
 * @param {object} [context] - Workflow context
 * @param {string} [parentCorr]
 */
export function logWorkflowExecutionFailed(workflowId, error, context, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.EXECUTION_FAILED,
      {
        workflowId,
        name: trunc(context?.name, 200),
        error: trunc(error?.message || String(error), 500),
        error_type: error?.name || 'Error',
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log workflow duplication.
 * @param {string} sourceWorkflowId
 * @param {object} newWorkflow - The duplicated workflow
 * @param {string} [parentCorr]
 */
export function logWorkflowDuplicated(sourceWorkflowId, newWorkflow, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, newWorkflow?.id)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.DUPLICATED,
      {
        sourceWorkflowId,
        newWorkflowId: newWorkflow?.id,
        name: trunc(newWorkflow?.name, 200),
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log schedule update.
 * @param {string} workflowId
 * @param {string} nodeId
 * @param {object} updates
 * @param {string} [parentCorr]
 */
export function logScheduleUpdated(workflowId, nodeId, updates, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.SCHEDULE_UPDATED,
      {
        workflowId,
        nodeId,
        cron: updates?.cron || undefined,
        timezone: updates?.timezone || undefined,
        paused: updates?.paused,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log schedule pause.
 */
export function logSchedulePaused(workflowId, nodeId, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.SCHEDULE_PAUSED,
      {
        workflowId,
        nodeId,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}

/**
 * Log schedule resume.
 */
export function logScheduleResumed(workflowId, nodeId, parentCorr) {
  fireAndForget(async () => {
    const corr = wfCorrelation(parentCorr, workflowId)
    const event = createEvent(
      'system.workflows',
      WORKFLOW_INTENTS.SCHEDULE_RESUMED,
      {
        workflowId,
        nodeId,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      corr
    )
    await storeEnvelope(event)
  })
}
