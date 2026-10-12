// API client for the Background Task Service (port 3104)
// Phase 4.B: approve/reject plan, envelopes endpoint, VOLT bridge integration

import {
  logObjectiveCreated, logObjectiveUpdated, logObjectiveCancelled,
  logObjectiveStarted,
  logPlanApproved, logPlanRejected,
} from './objectivesAudit'
import { TASKS_BASE, readTaskServiceJson, requestTaskServiceJson } from './taskServiceClient'

/**
 * QMH-5/3: fetch wisdom entries that influenced this objective's plan.
 * Backed by /api/wisdom/relevant which scores `execution_wisdom` rows
 * against the objective text. Returns the top 5 high-confidence entries.
 *
 * @param {Function} authFetch
 * @param {string} text - objective title + description (concatenated)
 * @param {number} [limit=5]
 */
export async function fetchRelevantWisdom(authFetch, text, limit = 5) {
  if (!text || !text.trim()) return { wisdom: [] }
  const params = new URLSearchParams({ text: text.slice(0, 500), limit: String(limit) })
  return requestTaskServiceJson(
    authFetch,
    `/api/wisdom/relevant?${params.toString()}`,
    { method: 'GET' },
    'Failed to fetch relevant wisdom',
  )
}

/**
 * QMH-5/3: fetch QuoxPredict aggregate stats for the chat advisor banner.
 * Returns the convention-shaped /api/engine/predict/stats response so the
 * UI can decide whether to surface a "low confidence" warning to the user.
 */
export async function fetchPredictStatsSummary(authFetch) {
  return requestTaskServiceJson(
    authFetch,
    '/api/engine/predict/stats',
    { method: 'GET' },
    'Failed to fetch predict stats',
  )
}

// Lazy import of VOLT bridge — avoid circular deps
let _voltBridge = null
function getVoltBridge() {
  if (_voltBridge === null) {
    try {
      // Dynamic import would be cleaner but this is sync context
      _voltBridge = window.__voltBridge || false
    } catch { _voltBridge = false }
  }
  return _voltBridge || null
}

/**
 * STUDY-REV-2 P1.E: Create an objective seeded from a chat card (Chat→Objective CTA).
 * Wraps createObjective with a convenience shape matching the data available on a
 * RichObjectCard — title, optional snippet (context), optional chatId for correlation.
 *
 * @param {Function} authFetch
 * @param {{ title: string, snippet?: string, chatId?: string }} opts
 */
export async function createFromChat(authFetch, { title, snippet, chatId }) {
  const data = {
    title: title || 'New objective',
    description: snippet || '',
  }
  return createObjective(authFetch, data, chatId || undefined)
}

/**
 * Create a new objective.
 * @param {Function} authFetch
 * @param {Object} data - objective payload
 * @param {string} [parentCorr] - originating conversation corr_id for correlation threading
 */
export async function createObjective(authFetch, data, parentCorr) {
  const body = parentCorr ? { ...data, corr_id: parentCorr } : data
  const result = await requestTaskServiceJson(authFetch, '/api/objectives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'Failed to create objective')
  logObjectiveCreated(result, parentCorr)
  return result
}

/**
 * List objectives with optional filters.
 */
export async function listObjectives(authFetch, { status, team_id, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (team_id) params.set('team_id', team_id)
  params.set('limit', String(limit))
  params.set('offset', String(offset))

  return requestTaskServiceJson(authFetch, `/api/objectives?${params}`, undefined, 'Failed to list objectives')
}

/**
 * Get a single objective with tasks and active checkpoint.
 */
export async function getObjective(authFetch, id) {
  return requestTaskServiceJson(authFetch, `/api/objectives/${id}`, undefined, 'Failed to load objective')
}

/**
 * Halt a running loop objective unconditionally (no pending gate needed).
 * Wraps the proven POST /api/objectives/:id/halt: fires the governed
 * signed-kill on the fleet host; the reason is witnessed server-side.
 */
export async function haltObjective(authFetch, id, notes) {
  return requestTaskServiceJson(authFetch, `/api/objectives/${id}/halt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notes ? { notes } : {}),
  }, 'Failed to halt loop')
}

/**
 * Update a pending objective.
 */
export async function updateObjective(authFetch, id, data, parentCorr) {
  const result = await requestTaskServiceJson(authFetch, `/api/objectives/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }, 'Failed to update objective')
  logObjectiveUpdated(id, data, parentCorr)
  return result
}

/**
 * Cancel an objective.
 */
export async function cancelObjective(authFetch, id, parentCorr) {
  // Fetch current state before cancelling for audit context
  let context = {}
  try {
    const infoRes = await authFetch(`${TASKS_BASE}/api/objectives/${id}`)
    if (infoRes.ok) context = await infoRes.json()
  } catch { /* non-critical */ }

  const result = await requestTaskServiceJson(authFetch, `/api/objectives/${id}`, {
    method: 'DELETE'
  }, 'Failed to cancel objective')
  logObjectiveCancelled(id, parentCorr, context)
  return result
}

/**
 * Start an objective (decompose + execute).
 */
export async function startObjective(authFetch, id, parentCorr) {
  const result = await requestTaskServiceJson(authFetch, `/api/objectives/${id}/start`, {
    method: 'POST'
  }, 'Failed to start objective')
  logObjectiveStarted(id, parentCorr, result)
  return result
}

// QE2: Legacy execution functions removed (pauseObjective, resumeObjective,
// rerunObjective, resumeSkippedTasks). Execution is managed by QuoxFlow.

// ── Template endpoints ──────────────────────────────────────────────

/**
 * Save a completed objective as a reusable template.
 */
export async function saveAsTemplate(authFetch, objectiveId, name, variables) {
  const body = { name }
  if (variables && variables.length > 0) body.variables = variables
  return requestTaskServiceJson(authFetch, `/api/objectives/${objectiveId}/save-as-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'Failed to save objective as template')
}

/**
 * List all templates for the org.
 */
export async function listTemplates(authFetch) {
  return requestTaskServiceJson(authFetch, '/api/templates', undefined, 'Failed to list templates')
}

/**
 * Create an objective from a template.
 */
export async function instantiateTemplate(authFetch, templateId, autoStart = false, variableValues) {
  const body = { autoStart }
  if (variableValues && Object.keys(variableValues).length > 0) body.variableValues = variableValues
  return requestTaskServiceJson(authFetch, `/api/templates/${templateId}/instantiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'Failed to instantiate template')
}

/**
 * Delete a template.
 */
export async function deleteTemplate(authFetch, templateId) {
  return requestTaskServiceJson(authFetch, `/api/templates/${templateId}`, { method: 'DELETE' }, 'Failed to delete template')
}

// QE2: Legacy task-level functions removed (retryTask, skipTask). QuoxFlow manages task execution.
// P6.B: approveCheckpoint / rejectCheckpoint re-added — these resolve HITL checkpoints
// (checkpoint_after_each_task) which are distinct from plan approval and remain valid.

/**
 * Approve an active HITL checkpoint.
 * @param {Function} authFetch
 * @param {string} objectiveId
 * @param {string} checkpointId
 * @param {string} [notes]
 */
export async function approveCheckpoint(authFetch, objectiveId, checkpointId, notes) {
  return requestTaskServiceJson(
    authFetch,
    `/api/objectives/${objectiveId}/checkpoints/${checkpointId}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes || null }),
    },
    'Failed to approve checkpoint',
  )
}

/**
 * Reject an active HITL checkpoint.
 * @param {Function} authFetch
 * @param {string} objectiveId
 * @param {string} checkpointId
 * @param {string} [notes]
 */
export async function rejectCheckpoint(authFetch, objectiveId, checkpointId, notes) {
  return requestTaskServiceJson(
    authFetch,
    `/api/objectives/${objectiveId}/checkpoints/${checkpointId}/reject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes || null }),
    },
    'Failed to reject checkpoint',
  )
}

/**
 * Approve a decomposed plan and start execution.
 */
export async function approvePlan(authFetch, objectiveId, parentCorr) {
  const result = await requestTaskServiceJson(authFetch, `/api/objectives/${objectiveId}/approve-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }, 'Failed to approve plan')
  logPlanApproved(objectiveId, parentCorr, {
    title: result?.title,
    task_count: result?.task_count,
    tasks: result?.tasks?.map(t => ({ title: t.title, agent_id: t.agent_id }))
  })
  return result
}

/**
 * Reject a decomposed plan and reset to pending.
 * @param {string} [feedback] - Optional adjustment feedback for re-decomposition
 */
export async function rejectPlan(authFetch, objectiveId, feedback, parentCorr) {
  const opts = { method: 'POST' }
  if (feedback) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify({ feedback })
  }
  const result = await requestTaskServiceJson(authFetch, `/api/objectives/${objectiveId}/reject-plan`, opts, 'Failed to reject plan')
  logPlanRejected(objectiveId, parentCorr, { feedback })
  return result
}

/**
 * Get AEE envelopes for an objective (audit trail).
 */
export async function getEnvelopes(authFetch, objectiveId) {
  return requestTaskServiceJson(authFetch, `/api/objectives/${objectiveId}/envelopes`, undefined, 'Failed to load objective envelopes')
}

/**
 * Get execution logs.
 */
export async function getObjectiveLogs(authFetch, objectiveId, limit = 100) {
  return requestTaskServiceJson(authFetch, `/api/objectives/${objectiveId}/logs?limit=${limit}`, undefined, 'Failed to load objective logs')
}

/**
 * Subscribe to SSE progress stream for an objective.
 * Returns an EventSource instance.
 */
export function subscribeToProgress(objectiveId, token, onEvent) {
  const url = `${TASKS_BASE}/api/objectives/${objectiveId}/stream`
  const eventSource = new EventSource(url)

  const eventTypes = [
    'connected', 'decomposition_started', 'decomposition_completed',
    'task_started', 'task_completed', 'task_failed', 'task_skipped',
    'checkpoint_created', 'checkpoint_approved', 'checkpoint_rejected',
    'budget_warning', 'objective_completed', 'objective_failed',
    'objective_paused', 'objective_resumed', 'objective_cancelled'
  ]

  for (const type of eventTypes) {
    eventSource.addEventListener(type, (event) => {
      try {
        const data = JSON.parse(event.data)
        onEvent(type, data)

        // Step 15: Forward envelope data to VOLT bridge for auto-recording
        if (data.envelope) {
          const voltBridge = getVoltBridge()
          if (voltBridge && typeof voltBridge.onEnvelopeStored === 'function') {
            voltBridge.onEnvelopeStored(data.envelope)
          }
        }
      } catch {
        onEvent(type, { raw: event.data })
      }
    })
  }

  eventSource.onerror = () => {
    onEvent('error', { message: 'SSE connection error' })
  }

  return eventSource
}

/**
 * Check task service health.
 */
export async function checkHealth() {
  try {
    const res = await fetch(`${TASKS_BASE}/health`)
    if (!res.ok) return { status: 'error', code: res.status }
    return await readTaskServiceJson(res, 'Failed to load task service health', { fallback: { status: 'ok' } })
  } catch {
    return { status: 'unreachable' }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// P6.B: Server-side user UI prefs
// Replaces localStorage for template var history and PRISM collapse state.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get a user UI preference from the server.
 * @param {Function} authFetch
 * @param {string} key
 * @returns {Promise<any>} the value, or null if not set
 */
export async function getUIPref(authFetch, key) {
  const result = await requestTaskServiceJson(
    authFetch,
    `/api/prefs/${encodeURIComponent(key)}`,
    undefined,
    `Failed to get UI pref: ${key}`,
  )
  return result?.value ?? null
}

/**
 * Set a user UI preference on the server.
 * @param {Function} authFetch
 * @param {string} key
 * @param {any} value — any JSON-serialisable value
 */
export async function setUIPref(authFetch, key, value) {
  return requestTaskServiceJson(
    authFetch,
    `/api/prefs/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    `Failed to set UI pref: ${key}`,
  )
}
