/**
 * inboxPausedHelpers — utilities for inbox items that represent paused human:task runs
 *
 * P6.E (STUDY-REV-2): upstream envelope extraction + resume execution client.
 */

import { getExecutionEnvelopes } from '../services/quoxflowClient.js'

// =============================================================================
// Upstream node output extraction
// =============================================================================

/**
 * Given an array of execution envelopes and a paused node ID, return all
 * `quox.flow.node.completed` envelopes that are UPSTREAM of (i.e. completed
 * before) the paused node.
 *
 * Strategy: envelopes are ordered by their timestamp (ts). We find the most
 * recent `quox.flow.node.paused` envelope for the given nodeId to establish
 * the pause timestamp, then return every `quox.flow.node.completed` envelope
 * whose timestamp is earlier. If no pause envelope is found we return all
 * `node.completed` envelopes (safe fallback for runs where the pause envelope
 * was emitted under a different intent prefix).
 *
 * @param {Array<{intent?: string, ts?: string, payload?: object}>} envelopes
 * @param {string} pausedNodeId
 * @returns {Array<object>} upstream completed envelopes, newest first
 */
export function getUpstreamCompletedEnvelopes(envelopes, pausedNodeId) {
  if (!Array.isArray(envelopes) || !pausedNodeId) return []

  // Find the pause-marker for this node (prefer human_task.requested, fall
  // back to node.paused, fall back to just comparing node IDs in payload).
  const pauseEnv = envelopes.find(e =>
    e?.intent === 'ops.human_task.requested' && e?.payload?.nodeId === pausedNodeId
  ) || envelopes.find(e =>
    e?.intent === 'quox.flow.node.paused' && e?.payload?.nodeId === pausedNodeId
  )

  const pauseTs = pauseEnv?.ts ? new Date(pauseEnv.ts).getTime() : null

  const completed = envelopes.filter(e => {
    if (!e) return false
    const intent = e.intent || ''
    // Accept both dot-separated and slash-separated (some older envelopes used /)
    const isCompleted = intent === 'quox.flow.node.completed'
      || intent === 'quox/flow/node/completed'
    if (!isCompleted) return false
    // If we have a pause timestamp, only include envelopes before it
    if (pauseTs !== null && e.ts) {
      return new Date(e.ts).getTime() < pauseTs
    }
    return true
  })

  // Sort newest first (most-recent upstream context is most relevant)
  completed.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0
    const tb = b.ts ? new Date(b.ts).getTime() : 0
    return tb - ta
  })

  return completed
}

/**
 * Fetch envelopes for an execution and return the upstream completed ones.
 *
 * Returns `{ envelopes: [], error: string|null }`.
 * Never throws — always returns the shape so callers can render gracefully.
 */
export async function fetchUpstreamEnvelopes(executionId, pausedNodeId) {
  if (!executionId) return { envelopes: [], error: 'No execution ID' }
  try {
    const res = await getExecutionEnvelopes(executionId)
    // quoxflowClient returns parsed JSON; `data` may be array or wrapped object
    const raw = Array.isArray(res)
      ? res
      : Array.isArray(res?.data)
        ? res.data
        : []
    const upstream = getUpstreamCompletedEnvelopes(raw, pausedNodeId)
    return { envelopes: upstream, error: null }
  } catch (err) {
    return { envelopes: [], error: err?.message || 'Failed to load envelopes' }
  }
}

// =============================================================================
// Resume execution client
// =============================================================================

/**
 * Resume a paused QuoxFlow execution after a human:task response.
 *
 * Translates the inbox action model into the QuoxFlow resume schema:
 *   { approved, approver, reason?, data? }
 *
 * "approve"-family actions → approved: true
 * "deny"-family actions    → approved: false
 *
 * @param {object} opts
 * @param {Function} opts.authFetch  — authenticated fetch from useAuth()
 * @param {string}   opts.executionId
 * @param {string}   opts.action     — the chosen action value (e.g. "approve", "reject")
 * @param {string}   [opts.approver] — user identifier; defaults to "user"
 * @param {object}   [opts.fields]   — per-action form data to pass as `data`
 * @param {string}   [opts.comment]  — optional human comment (mapped to `reason`)
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function resumeExecution({ authFetch, executionId, action, approver, fields, comment }) {
  if (!authFetch || !executionId || !action) {
    return { success: false, error: 'authFetch, executionId, and action are required' }
  }

  // Determine approval polarity from action value
  const denyActions = ['deny', 'denied', 'reject', 'rejected', 'decline', 'declined', 'dismissed', 'cancel', 'cancelled']
  const approved = !denyActions.includes(String(action).toLowerCase())

  const body = {
    approved,
    approver: approver || 'user',
    ...(comment ? { reason: comment } : {}),
    ...(fields && Object.keys(fields).length > 0
      ? { data: { action, ...fields } }
      : { data: { action } }),
  }

  try {
    const res = await authFetch(`/quoxflow/api/executions/${executionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errBody = await res.json().catch(() => null)
      return {
        success: false,
        error: errBody?.error?.message || errBody?.message || `HTTP ${res.status}`,
      }
    }

    const data = await res.json().catch(() => null)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err?.message || 'Network error' }
  }
}
