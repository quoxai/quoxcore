/**
 * Approval AEE Audit Service
 * Fire-and-forget envelope logging for HITL approval operations.
 * Rich audit payloads capture who decided what, with reasoning.
 * Follows the objectivesAudit.js pattern.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function trunc(str, max = 500) {
  if (!str || typeof str !== 'string') return str
  return str.length > max ? str.slice(0, max) + '…' : str
}

// ─── Intents ─────────────────────────────────────────────────────────

export const APPROVAL_INTENTS = {
  REQUESTED:  'quox.approval.requested',
  GRANTED:    'quox.approval.granted',
  DENIED:     'quox.approval.denied',
  CANCELLED:  'quox.approval.cancelled',
  ESCALATED:  'quox.approval.escalated',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function apprCorrelation(parentCorr) {
  return parentCorr || prefixedUlid('APPR')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[ApprovalAudit]', err.message)) }
  catch (err) { console.warn('[ApprovalAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

/**
 * Log approval granted with full decision context.
 * @param {string} approvalId
 * @param {string} approver
 * @param {string} [comment] - Reviewer's comment
 * @param {string} [parentCorr]
 * @param {object} [context] - Additional context (workflow, node, execution)
 */
export function logApprovalGranted(approvalId, approver, comment, parentCorr, context) {
  fireAndForget(async () => {
    const event = createEvent(
      `human.${approver || 'unknown'}`,
      APPROVAL_INTENTS.GRANTED,
      {
        approvalId,
        approver: approver || 'unknown',
        comment: trunc(comment, 300),
        workflowId: context?.workflowId || undefined,
        workflowName: trunc(context?.workflowName, 200),
        executionId: context?.executionId || undefined,
        nodeId: context?.nodeId || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      apprCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

/**
 * Log approval denied with reasoning.
 * @param {string} approvalId
 * @param {string} approver
 * @param {string} [comment] - Denial reason
 * @param {string} [parentCorr]
 * @param {object} [context] - Additional context
 */
export function logApprovalDenied(approvalId, approver, comment, parentCorr, context) {
  fireAndForget(async () => {
    const event = createEvent(
      `human.${approver || 'unknown'}`,
      APPROVAL_INTENTS.DENIED,
      {
        approvalId,
        approver: approver || 'unknown',
        comment: trunc(comment, 300),
        workflowId: context?.workflowId || undefined,
        workflowName: trunc(context?.workflowName, 200),
        executionId: context?.executionId || undefined,
        nodeId: context?.nodeId || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      apprCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

/**
 * Log approval cancelled with context.
 * @param {string} approvalId
 * @param {string} [parentCorr]
 * @param {object} [context] - Additional context
 */
export function logApprovalCancelled(approvalId, parentCorr, context) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.hitl',
      APPROVAL_INTENTS.CANCELLED,
      {
        approvalId,
        workflowId: context?.workflowId || undefined,
        workflowName: trunc(context?.workflowName, 200),
        executionId: context?.executionId || undefined,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      apprCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}
