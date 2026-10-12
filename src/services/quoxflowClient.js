/**
 * QuoxFlow API Client
 *
 * Client for interacting with QuoxFlow's REST API.
 * QuoxFlow runs on port 3200, proxied through nginx at /quoxflow/.
 * Uses JWT auth from the auth service (not API key like n8n).
 *
 * Usage:
 *   import { quoxflowClient } from './quoxflowClient'
 *   const workflows = await quoxflowClient.listWorkflows()
 */

import { csrfFetch } from '../utils/csrfFetch'
import { logApprovalGranted, logApprovalDenied, logApprovalCancelled } from './approvalAudit'
import {
  logWorkflowCreated, logWorkflowUpdated, logWorkflowDeleted,
  logWorkflowExecuted, logWorkflowExecutionCompleted, logWorkflowExecutionFailed,
  logWorkflowDuplicated, logScheduleUpdated, logSchedulePaused, logScheduleResumed,
} from './workflowAudit'

// QuoxFlow API base URL - proxied through nginx or via env override
const QUOXFLOW_API_BASE = import.meta.env.VITE_QUOXFLOW_API_URL || '/quoxflow/api'

export const QUOXFLOW_CONNECTION_ERROR =
  'Cannot connect to QuoxFlow. Start the workflow service and verify the /quoxflow proxy.'

export const QUOXFLOW_HTML_RESPONSE_ERROR =
  'QuoxFlow returned HTML instead of JSON. The /quoxflow proxy may be missing or the service may be unavailable.'

export const QUOXFLOW_INVALID_JSON_ERROR =
  'QuoxFlow returned invalid JSON.'

function looksLikeHtml(text = '', contentType = '') {
  const normalizedType = String(contentType || '').toLowerCase()
  if (normalizedType.includes('text/html')) return true
  return /^\s*<(?:!doctype|html|head|body|script|div)\b/i.test(String(text || ''))
}

/**
 * Make authenticated request to QuoxFlow API.
 * Auth uses httpOnly cookies (access_token) set by the auth service.
 * credentials: 'include' sends cookies automatically — no manual token injection needed.
 */
async function quoxflowFetch(endpoint, options = {}) {
  const url = `${QUOXFLOW_API_BASE}${endpoint}`
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  }

  try {
    const response = await csrfFetch(url, {
      ...options,
      headers
    })

    const contentType = response?.headers?.get?.('content-type')
      || response?.headers?.get?.('Content-Type')
      || ''
    const text = typeof response?.text === 'function' ? await response.text() : ''

    if (looksLikeHtml(text, contentType)) {
      throw new Error(QUOXFLOW_HTML_RESPONSE_ERROR)
    }

    if (!text || text.trim() === '') {
      if (!response.ok) {
        throw new Error(`QuoxFlow API error: ${response.status}`)
      }
      return null
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(QUOXFLOW_INVALID_JSON_ERROR)
    }

    if (!response.ok) {
      const errorMessage = data?.error?.message
        || (typeof data?.error === 'string' ? data.error : null)
        || data?.message
        || `QuoxFlow API error: ${response.status}`
      const err = new Error(errorMessage)
      // QSKL-SAFETY Gap 5: preserve structured error envelope so callers can
      // render rule-id + offending span (firewall) instead of a generic message.
      if (data?.error && typeof data.error === 'object') {
        if (typeof data.error.code === 'string') err.code = data.error.code
        if (data.error.data !== undefined) err.data = data.error.data
      }
      err.status = response.status
      throw err
    }

    return data
  } catch (err) {
    const message = String(err?.message || err || '')
    if (
      message.includes('Failed to fetch')
      || message.includes('NetworkError')
      || message.includes('Load failed')
    ) {
      throw new Error(QUOXFLOW_CONNECTION_ERROR)
    }
    throw err
  }
}

// =============================================================================
// CONNECTION
// =============================================================================

/**
 * Test QuoxFlow connection
 * @returns {{ connected: boolean, version?: string, error?: string }}
 */
export async function testConnection() {
  try {
    const health = await fetch(
      `${QUOXFLOW_API_BASE.replace('/api', '')}/health`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!health.ok) return { connected: false, error: `HTTP ${health.status}` }
    const data = await health.json()
    return { connected: true, version: data.version }
  } catch (err) {
    return { connected: false, error: err.message }
  }
}

// =============================================================================
// WORKFLOW OPERATIONS
// =============================================================================

/**
 * List workflows
 * @param {object} [options]
 * @param {boolean} [options.active] - Filter by active status
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function listWorkflows(options = {}) {
  const params = new URLSearchParams()
  if (options.active !== undefined) params.set('active', String(options.active))
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/workflows${query ? '?' + query : ''}`)
}

/**
 * Get a single workflow by ID
 */
export async function getWorkflow(workflowId) {
  return quoxflowFetch(`/workflows/${workflowId}`)
}

/**
 * Create a new workflow
 * @param {object} workflow - QuoxFlow workflow definition
 */
export async function createWorkflow(workflow) {
  const result = await quoxflowFetch('/workflows', {
    method: 'POST',
    body: JSON.stringify(workflow)
  })
  logWorkflowCreated({ ...workflow, ...result })
  return result
}

/**
 * Update workflow metadata (name, description, metadata, tags)
 */
export async function updateWorkflow(workflowId, updates) {
  const result = await quoxflowFetch(`/workflows/${workflowId}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })
  logWorkflowUpdated(workflowId, updates)
  return result
}

/**
 * Duplicate a workflow (create copy with modified name).
 * Separated from createWorkflow to capture source lineage in audit trail.
 */
export async function duplicateWorkflow(sourceWorkflowId, newWorkflow) {
  const result = await quoxflowFetch('/workflows', {
    method: 'POST',
    body: JSON.stringify(newWorkflow)
  })
  logWorkflowDuplicated(sourceWorkflowId, { ...newWorkflow, ...result })
  return result
}

/**
 * Delete a workflow
 */
export async function deleteWorkflow(workflowId) {
  // Fetch workflow info before deletion for audit context
  let context = {}
  try {
    const info = await quoxflowFetch(`/workflows/${workflowId}`)
    const wf = info?.data || info
    context = { name: wf?.name, node_count: wf?.nodes?.length || wf?.definition?.nodes?.length, active: wf?.active }
  } catch { /* non-critical */ }

  const result = await quoxflowFetch(`/workflows/${workflowId}`, {
    method: 'DELETE'
  })
  logWorkflowDeleted(workflowId, undefined, context)
  return result
}

/**
 * Validate a workflow definition
 */
export async function validateWorkflow(workflowId) {
  return quoxflowFetch(`/workflows/${workflowId}/validate`, {
    method: 'POST'
  })
}

/**
 * Import an n8n workflow JSON into QuoxFlow format.
 *
 * N8N-ERADICATE: this is the one surviving n8n capability — importing a legacy
 * n8n export as a one-off migration into QuoxFlow, not connecting to a live
 * n8n instance (that live-connection code path was removed from n8nClient.js).
 *
 * Does NOT throw on a 400 "conversion failed" response — QuoxFlow's
 * /import-n8n route returns `warnings`/`nodeMapping` alongside a failure
 * envelope, and callers (the Import dialog) need those even when the import
 * only partially succeeds. Network/parse errors still throw.
 *
 * @param {object} n8nWorkflow - n8n workflow JSON (nodes, connections, etc.)
 * @param {object} [options]
 * @param {boolean} [options.generateIds]
 * @param {boolean} [options.includePositions]
 * @returns {{ success: boolean, data?: { workflow, warnings, nodeMapping }, error?: { code, message, details }, warnings?: array, nodeMapping?: object, status: number }}
 */
export async function importN8nWorkflow(n8nWorkflow, options = {}) {
  const url = `${QUOXFLOW_API_BASE}/workflows/import-n8n`
  let response
  try {
    response = await csrfFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: n8nWorkflow, options })
    })
  } catch (err) {
    const message = String(err?.message || err || '')
    if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('Load failed')) {
      throw new Error(QUOXFLOW_CONNECTION_ERROR)
    }
    throw err
  }

  const contentType = response?.headers?.get?.('content-type') || response?.headers?.get?.('Content-Type') || ''
  const text = typeof response?.text === 'function' ? await response.text() : ''

  if (looksLikeHtml(text, contentType)) {
    throw new Error(QUOXFLOW_HTML_RESPONSE_ERROR)
  }

  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(QUOXFLOW_INVALID_JSON_ERROR)
  }

  if (!data) {
    throw new Error(response.ok ? QUOXFLOW_INVALID_JSON_ERROR : `QuoxFlow API error: ${response.status}`)
  }

  const result = { ...data, status: response.status }

  if (result.success && result.data?.workflow) {
    logWorkflowCreated(result.data.workflow)
  }

  return result
}

// =============================================================================
// EXECUTION OPERATIONS
// =============================================================================

/**
 * Execute a workflow
 * @param {string} workflowId
 * @param {object} [options]
 * @param {object} [options.triggerData] - Input data
 * @param {boolean} [options.async] - If true, returns immediately with executionId
 */
export async function executeWorkflow(workflowId, options = {}) {
  const triggerData = options.triggerData || options.data
  const wfContext = { name: options.workflowName, triggerData, node_count: options.nodeCount }

  // Audit: log execution triggered
  logWorkflowExecuted(workflowId, wfContext)

  // QuoxFlow returns HTTP 500 when the workflow *nodes* fail, even though
  // the execution itself was processed and recorded.  We must parse the
  // response body regardless of status code so the UI can show the
  // execution result (ID, envelopes, duration, etc.).
  const url = `${QUOXFLOW_API_BASE}/workflows/${workflowId}/execute`

  // P8.F HITL-ORGID-PLUMB: inject orgId from options into POST body.
  // This ensures the QuoxFlow engine has first-class orgId on the execution
  // record, which then flows through to HV2 inbox item creation.
  // Don't double-set if options.orgId is already present as a direct option.
  const executeBody = {
    triggerData,
    async: options.async ?? false,
    ...(options.orgId ? { orgId: options.orgId } : {}),
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(executeBody)
  })

  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* ignore */ }

  // If the response contains execution data, return it even on HTTP 500
  const execData = body?.data || body
  if (execData?.executionId || execData?.stored?.id) {
    // Audit: log execution result (success or partial failure)
    if (execData?.success === false || execData?.error) {
      logWorkflowExecutionFailed(workflowId, execData.error || { message: 'Execution failed' }, wfContext)
    } else {
      logWorkflowExecutionCompleted(workflowId, body, wfContext)
    }
    return body
  }

  // Otherwise, surface the error
  if (!response.ok) {
    const msg = body?.error?.message || body?.message || `QuoxFlow API error: ${response.status}`
    const err = new Error(msg)
    logWorkflowExecutionFailed(workflowId, err, wfContext)
    throw err
  }

  // Successful response without execution ID — still log completion
  logWorkflowExecutionCompleted(workflowId, body, wfContext)
  return body
}

/**
 * List executions
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {string} [options.status] - running | completed | failed
 * @param {string} [options.since] - ISO date
 * @param {string} [options.until] - ISO date
 * @param {string} [options.tag] - Filter by tag
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function listExecutions(options = {}) {
  const params = new URLSearchParams()
  if (options.workflowId) params.set('workflowId', options.workflowId)
  if (options.status) params.set('status', options.status)
  if (options.since) params.set('since', options.since)
  if (options.until) params.set('until', options.until)
  if (options.tag) params.set('tag', options.tag)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/executions${query ? '?' + query : ''}`)
}

/**
 * Get execution details (by ID or correlation ID)
 */
export async function getExecution(executionId) {
  return quoxflowFetch(`/executions/${executionId}`)
}

/**
 * Get envelopes for an execution
 */
export async function getExecutionEnvelopes(executionId) {
  return quoxflowFetch(`/executions/${executionId}/envelopes`)
}

// =============================================================================
// ENVELOPE OPERATIONS
// =============================================================================

/**
 * Query envelopes
 * @param {object} [options]
 * @param {string} [options.corr] - Correlation ID
 * @param {string} [options.intent]
 * @param {string} [options.type]
 * @param {string} [options.since] - ISO date
 * @param {string} [options.until] - ISO date
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function queryEnvelopes(options = {}) {
  const params = new URLSearchParams()
  if (options.corr) params.set('corr', options.corr)
  if (options.intent) params.set('intent', options.intent)
  if (options.type) params.set('type', options.type)
  if (options.since) params.set('since', options.since)
  if (options.until) params.set('until', options.until)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/envelopes${query ? '?' + query : ''}`)
}

/**
 * Get a single envelope by ID
 */
export async function getEnvelope(envelopeId) {
  return quoxflowFetch(`/envelopes/${envelopeId}`)
}

/**
 * Get the full causality chain for an envelope
 */
export async function getEnvelopeChain(envelopeId) {
  return quoxflowFetch(`/envelopes/${envelopeId}/chain`)
}

// =============================================================================
// POLICY OPERATIONS
// =============================================================================

/**
 * List policies
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string} [options.workflowId]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function listPolicies(options = {}) {
  const params = new URLSearchParams()
  if (options.enabled !== undefined) params.set('enabled', String(options.enabled))
  if (options.workflowId) params.set('workflowId', options.workflowId)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/policies${query ? '?' + query : ''}`)
}

/**
 * Create a new policy
 */
export async function createPolicy(policy) {
  return quoxflowFetch('/policies', {
    method: 'POST',
    body: JSON.stringify(policy)
  })
}

/**
 * Get a policy by ID
 */
export async function getPolicy(policyId) {
  return quoxflowFetch(`/policies/${policyId}`)
}

/**
 * Update a policy
 */
export async function updatePolicy(policyId, updates) {
  return quoxflowFetch(`/policies/${policyId}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })
}

/**
 * Delete a policy
 */
export async function deletePolicy(policyId) {
  return quoxflowFetch(`/policies/${policyId}`, {
    method: 'DELETE'
  })
}

/**
 * Test a saved policy with input data
 */
export async function testPolicy(policyId, input, variables = {}) {
  return quoxflowFetch(`/policies/${policyId}/test`, {
    method: 'POST',
    body: JSON.stringify({ input, variables })
  })
}

/**
 * Test an inline policy definition (without saving)
 */
export async function testInlinePolicy(policy, input, variables = {}) {
  return quoxflowFetch('/policies/test', {
    method: 'POST',
    body: JSON.stringify({ policy, input, variables })
  })
}

// =============================================================================
// APPROVAL OPERATIONS
// =============================================================================

/**
 * List approvals
 * @param {object} [options]
 * @param {string} [options.status] - pending | approved | denied | cancelled | expired
 * @param {string} [options.workflowId]
 * @param {string} [options.approver]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function listApprovals(options = {}) {
  const params = new URLSearchParams()
  if (options.status) params.set('status', options.status)
  if (options.workflowId) params.set('workflowId', options.workflowId)
  if (options.approver) params.set('approver', options.approver)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/approvals${query ? '?' + query : ''}`)
}

/**
 * Get pending approvals for a specific approver
 */
export async function getPendingApprovals(approver) {
  return quoxflowFetch(`/approvals/pending/${encodeURIComponent(approver)}`)
}

/**
 * Get approval statistics
 */
export async function getApprovalStats() {
  return quoxflowFetch('/approvals/stats')
}

/**
 * Get approval by ID
 */
export async function getApproval(approvalId) {
  return quoxflowFetch(`/approvals/${approvalId}`)
}

/**
 * Approve a request
 */
export async function approveRequest(approvalId, approver, comment) {
  // Fetch approval context before deciding — so audit trail has workflow/node info
  let approvalContext = {}
  try {
    const info = await quoxflowFetch(`/approvals/${approvalId}`)
    const appr = info?.data || info
    approvalContext = {
      workflowId: appr?.workflowId,
      workflowName: appr?.workflowName,
      executionId: appr?.executionId,
      nodeId: appr?.nodeId,
    }
  } catch { /* non-critical */ }

  const result = await quoxflowFetch(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ approver, comment })
  })
  logApprovalGranted(approvalId, approver, comment, undefined, approvalContext)
  return result
}

/**
 * Deny a request
 */
export async function denyRequest(approvalId, approver, comment) {
  // Fetch approval context for audit trail
  let approvalContext = {}
  try {
    const info = await quoxflowFetch(`/approvals/${approvalId}`)
    const appr = info?.data || info
    approvalContext = {
      workflowId: appr?.workflowId,
      workflowName: appr?.workflowName,
      executionId: appr?.executionId,
      nodeId: appr?.nodeId,
    }
  } catch { /* non-critical */ }

  const result = await quoxflowFetch(`/approvals/${approvalId}/deny`, {
    method: 'POST',
    body: JSON.stringify({ approver, comment })
  })
  logApprovalDenied(approvalId, approver, comment, undefined, approvalContext)
  return result
}

/**
 * Cancel a pending approval
 */
export async function cancelApproval(approvalId) {
  // Fetch approval context for audit trail
  let approvalContext = {}
  try {
    const info = await quoxflowFetch(`/approvals/${approvalId}`)
    const appr = info?.data || info
    approvalContext = {
      workflowId: appr?.workflowId,
      workflowName: appr?.workflowName,
      executionId: appr?.executionId,
    }
  } catch { /* non-critical */ }

  const result = await quoxflowFetch(`/approvals/${approvalId}/cancel`, {
    method: 'POST'
  })
  logApprovalCancelled(approvalId, undefined, approvalContext)
  return result
}

// =============================================================================
// EVIDENCE OPERATIONS
// =============================================================================

/**
 * List evidence records
 * @param {object} [options]
 * @param {string} [options.corr]
 * @param {string} [options.envelopeId]
 * @param {string} [options.workflowId]
 * @param {string} [options.executionId]
 * @param {string} [options.type]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 */
export async function listEvidence(options = {}) {
  const params = new URLSearchParams()
  if (options.corr) params.set('corr', options.corr)
  if (options.envelopeId) params.set('envelopeId', options.envelopeId)
  if (options.workflowId) params.set('workflowId', options.workflowId)
  if (options.executionId) params.set('executionId', options.executionId)
  if (options.type) params.set('type', options.type)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  return quoxflowFetch(`/evidence${query ? '?' + query : ''}`)
}

/**
 * Get evidence metadata by ID
 */
export async function getEvidence(evidenceId) {
  return quoxflowFetch(`/evidence/${evidenceId}`)
}

/**
 * Get evidence content (binary) by ID
 * Returns a Blob for download/display
 */
export async function getEvidenceContent(evidenceId) {
  const url = `${QUOXFLOW_API_BASE}/evidence/${evidenceId}/content`
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok) {
    throw new Error(`Failed to fetch evidence content: ${response.status}`)
  }
  return response.blob()
}

/**
 * Delete evidence by ID
 */
export async function deleteEvidence(evidenceId) {
  return quoxflowFetch(`/evidence/${evidenceId}`, { method: 'DELETE' })
}

/**
 * Get all evidence for an envelope
 */
export async function getEvidenceByEnvelope(envelopeId) {
  return quoxflowFetch(`/evidence/envelope/${envelopeId}`)
}

/**
 * Get all evidence for a correlation ID
 */
export async function getEvidenceByCorrelation(correlationId) {
  return quoxflowFetch(`/evidence/correlation/${correlationId}`)
}

// =============================================================================
// SCHEDULES
// =============================================================================

/**
 * List active cron schedules.
 * Returns workflows with active trigger:schedule nodes and their next run times.
 */
export async function listSchedules() {
  const result = await quoxflowFetch('/schedules')
  return result?.data || []
}

/**
 * Update a schedule's cron expression, timezone, or paused state.
 */
export async function updateSchedule(workflowId, nodeId, updates) {
  const result = await quoxflowFetch(`/schedules/${workflowId}/${nodeId}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })
  logScheduleUpdated(workflowId, nodeId, updates)
  return result
}

/**
 * Pause a running schedule.
 */
export async function pauseSchedule(workflowId, nodeId) {
  const result = await quoxflowFetch(`/schedules/${workflowId}/${nodeId}/pause`, {
    method: 'POST'
  })
  logSchedulePaused(workflowId, nodeId)
  return result
}

/**
 * Resume a paused schedule.
 */
export async function resumeSchedule(workflowId, nodeId) {
  const result = await quoxflowFetch(`/schedules/${workflowId}/${nodeId}/resume`, {
    method: 'POST'
  })
  logScheduleResumed(workflowId, nodeId)
  return result
}

// =============================================================================
// OBJECTIVE TEMPLATE IMPORT
// =============================================================================

/**
 * Import an objective template as a QuoxFlow workflow.
 * Converts tasks to agent:invoke nodes, dependencies to edges,
 * {{variables}} to ${vars.variable} expressions.
 *
 * @param {object} template - Objective template JSON (from WC-1 saveObjectiveTemplate)
 * @param {object} [options]
 * @param {{ cron: string, timezone?: string }} [options.schedule] - Attach schedule trigger
 * @param {boolean} [options.activate] - Auto-activate after import
 * @param {boolean} [options.includeApprovalGate] - Insert approval gate before first task
 * @returns {{ workflow, warnings, nodeMapping, activated?, triggersRegistered? }}
 */
export async function importObjectiveTemplate(template, options = {}) {
  const result = await quoxflowFetch('/workflows/import-objective', {
    method: 'POST',
    body: JSON.stringify({
      template,
      schedule: options.schedule,
      options: {
        activate: options.activate,
        includeApprovalGate: options.includeApprovalGate,
      },
    })
  })
  return result?.data || result
}

// =============================================================================
// SKILL LIBRARY (STUDY-REV W4)
// =============================================================================

/**
 * List skills (latest version per source workflow) for the current org.
 * Service callers can pass orgId explicitly; otherwise the auth user's org_id is used.
 */
export async function listSkills({ orgId } = {}) {
  const params = new URLSearchParams()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const result = await quoxflowFetch(`/skills${query ? '?' + query : ''}`)
  return result?.data || []
}

/**
 * Fetch one skill by id.
 */
export async function getSkill(skillId) {
  const result = await quoxflowFetch(`/skills/${skillId}`)
  return result?.data || null
}

/**
 * STUDY-REV-2 P6 phase 2: actually wire activate/deactivate to the API.
 * The quoxflow lifecycle routes have existed since W2; the dashboard
 * functions in workflowEngine.js were stubs returning fake success.
 */
export async function activateWorkflow(workflowId) {
  return quoxflowFetch(`/workflows/${workflowId}/activate`, { method: 'POST' })
}

export async function deactivateWorkflow(workflowId) {
  return quoxflowFetch(`/workflows/${workflowId}/deactivate`, { method: 'POST' })
}

/**
 * STUDY-REV SV-3: list every version of a skill for one source workflow.
 * Used by the version-history accordion in CrystalsLibraryView.
 */
export async function listSkillVersions(sourceWorkflowId, { orgId } = {}) {
  if (!sourceWorkflowId) throw new Error('sourceWorkflowId is required')
  const params = new URLSearchParams()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const path = `/skills/by-source/${encodeURIComponent(sourceWorkflowId)}${query ? '?' + query : ''}`
  const result = await quoxflowFetch(path)
  return result?.data || []
}

/**
 * STUDY-REV SV-3: roll a skill back to an older version. The server writes
 * a NEW version that copies the target's content (latest pointer stays
 * the active one; audit trail preserved via 'rolled-back' tags).
 *
 * @returns {{ skill: object, created: boolean }} — created=true on 201
 *    (new rollback version written), false on 200 (target was already
 *    the current latest, no-op).
 * @throws {Error & { code?: string, status?: number }} on 4xx/5xx.
 *    404 = no versions for that source. 422 with code='TARGET_VERSION_NOT_FOUND'
 *    when the version doesn't exist in this org's history.
 */
export async function rollbackSkill({ sourceWorkflowId, targetVersion } = {}) {
  if (!sourceWorkflowId) throw new Error('sourceWorkflowId is required')
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error('targetVersion must be a positive integer')
  }
  const url = `${QUOXFLOW_API_BASE}/skills/rollback-to-version`
  const response = await csrfFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceWorkflowId, targetVersion }),
  })
  const text = typeof response?.text === 'function' ? await response.text() : ''
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(QUOXFLOW_INVALID_JSON_ERROR)
  }
  if (!response.ok) {
    const err = new Error(data?.error?.message || `QuoxFlow API error: ${response.status}`)
    err.code = data?.error?.code
    err.status = response.status
    throw err
  }
  return { skill: data?.data || null, created: response.status === 201 }
}

/**
 * Manually crystallise a workflow into a skill (the "Package as Skill" action).
 * Idempotent: if a skill already exists, the existing record is returned.
 *
 * @returns {{ skill: object, created: boolean }} — created=true on 201, false on 200.
 * @throws {Error & { code?: string }} on 4xx/5xx; 422 with code='NOT_READY' is the
 *    common case when the workflow doesn't yet have enough successful runs.
 */
export async function packageSkillFromExecution({ workflowId, workflowName } = {}) {
  if (!workflowId) {
    throw new Error('workflowId is required')
  }
  // Custom call so we can distinguish 201 vs 200 (idempotent path).
  const url = `${QUOXFLOW_API_BASE}/skills/from-execution`
  const response = await csrfFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId, workflowName })
  })
  const text = typeof response?.text === 'function' ? await response.text() : ''
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(QUOXFLOW_INVALID_JSON_ERROR)
  }
  if (!response.ok) {
    const err = new Error(data?.error?.message || `QuoxFlow API error: ${response.status}`)
    err.code = data?.error?.code
    err.status = response.status
    throw err
  }
  return { skill: data?.data || null, created: response.status === 201 }
}

/** Alias — Crystal branding. Calls the same endpoint; kept for backcompat during P1.G rename audit. */
export const packageCrystalFromExecution = packageSkillFromExecution

// P1.G Crystal-named aliases for the Skill Library functions.
// The originals remain exported for backwards compatibility (tests + engine).
/** @see listSkills */
export const listCrystals = listSkills
/** @see listSkillVersions */
export const listCrystalVersions = listSkillVersions
/** @see rollbackSkill */
export const rollbackCrystal = rollbackSkill

// =============================================================================
// QUOX SKILLS (QSKL-1)
// =============================================================================

/**
 * Get the current org_id from localStorage (mirrors the pattern used across
 * other service clients in this project).
 */
function getCurrentOrgId() {
  try { return localStorage.getItem('current_org_id') || undefined } catch { return undefined }
}

/**
 * List QuoxSkills for the current org with optional filters.
 * Maps to GET /api/quox-skills
 *
 * @param {object} [options]
 * @param {string} [options.category]
 * @param {string} [options.edition]
 * @param {string} [options.agentId]
 * @param {string} [options.tag]
 * @param {number} [options.limit]
 */
export async function listQuoxSkills({ category, edition, agentId, tag, limit } = {}) {
  const params = new URLSearchParams()
  const orgId = getCurrentOrgId()
  if (orgId) params.set('orgId', orgId)
  if (category) params.set('category', category)
  if (edition) params.set('edition', edition)
  if (agentId) params.set('agentId', agentId)
  if (tag) params.set('tag', tag)
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  const result = await quoxflowFetch(`/quox-skills${query ? '?' + query : ''}`)
  return result?.data || []
}

/**
 * Get a single QuoxSkill by ID.
 * Maps to GET /api/quox-skills/:id
 */
export async function getQuoxSkillById(id) {
  const result = await quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}`)
  return result?.data || null
}

/**
 * Get a QuoxSkill by name (within current org).
 * Maps to GET /api/quox-skills/by-name/:name?orgId=X
 */
export async function getQuoxSkillByName(name) {
  const params = new URLSearchParams()
  const orgId = getCurrentOrgId()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const result = await quoxflowFetch(
    `/quox-skills/by-name/${encodeURIComponent(name)}${query ? '?' + query : ''}`
  )
  return result?.data || null
}

/**
 * Get all versions of a QuoxSkill by name.
 * Maps to GET /api/quox-skills/versions?orgId=X&name=Y
 */
export async function getQuoxSkillVersions(name) {
  const params = new URLSearchParams()
  const orgId = getCurrentOrgId()
  if (orgId) params.set('orgId', orgId)
  if (name) params.set('name', name)
  const query = params.toString()
  const result = await quoxflowFetch(`/quox-skills/versions${query ? '?' + query : ''}`)
  return result?.data || []
}

/**
 * Create a new QuoxSkill.
 * Maps to POST /api/quox-skills
 *
 * @param {object} input - QuoxSkillInput (orgId, name, category, description, bodyMd, ...)
 */
export async function createQuoxSkill(input) {
  const orgId = getCurrentOrgId()
  const body = { ...(orgId ? { orgId } : {}), ...input }
  const result = await quoxflowFetch('/quox-skills', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return result?.data || result
}

/**
 * Update an existing QuoxSkill.
 * Maps to PATCH /api/quox-skills/:id
 *
 * @param {string} id
 * @param {object} patch - Partial QuoxSkillInput
 */
export async function updateQuoxSkill(id, patch) {
  const result = await quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return result?.data || result
}

/**
 * Delete a QuoxSkill by ID.
 * Maps to DELETE /api/quox-skills/:id
 */
export async function deleteQuoxSkill(id) {
  return quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/**
 * Run the declared test-pairs for a QuoxSkill.
 * Maps to POST /api/quox-skills/:id/run-tests
 *
 * Returns the full response envelope so the caller can inspect .success / .error / .data.
 * Does NOT throw on 503 TESTS_NOT_CONFIGURED — returns { success: false, error: { code, message } }.
 *
 * @param {string} id - Skill ID
 * @returns {{ success: boolean, data?: { skillId, summary, results }, error?: { code, message } }}
 */
export async function runQuoxSkillTests(id) {
  try {
    const result = await quoxflowFetch(
      `/quox-skills/${encodeURIComponent(id)}/run-tests`,
      { method: 'POST', body: JSON.stringify({}) }
    )
    return result
  } catch (err) {
    // Surface structured envelope so caller can inspect error.code
    const code = err?.code || (err?.message?.includes('TESTS_NOT_CONFIGURED') ? 'TESTS_NOT_CONFIGURED' : undefined)
    return { success: false, error: { code, message: err?.message || String(err) } }
  }
}

/**
 * Fetch the stored evals for a QuoxSkill.
 * Maps to GET /api/quox-skills/:id/evals
 *
 * @param {string} id - Skill ID
 * @returns {{ tests?: object, [key: string]: any } | null}
 */
export async function getQuoxSkillEvals(id) {
  const result = await quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}/evals`)
  return result?.data || null
}

/**
 * List version patches for a QuoxSkill.
 * Maps to GET /api/quox-skills/:id/patches
 *
 * @param {string} id - Skill ID
 * @returns {{ patches: object[], versions: object[] }}
 */
export async function listSkillPatches(id) {
  const params = new URLSearchParams()
  const orgId = getCurrentOrgId()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const result = await quoxflowFetch(
    `/quox-skills/${encodeURIComponent(id)}/patches${query ? '?' + query : ''}`
  )
  return result?.data || { patches: [], versions: [] }
}

/**
 * Revert a QuoxSkill to a prior version body.
 * Maps to POST /api/quox-skills/:id/revert
 * Throws with error code PATCH_CRYSTALS_REGRESSED or INVALID_TARGET_VERSION on failure.
 *
 * @param {string} id - Skill ID
 * @param {{ toVersion: string, reason?: string }} opts
 * @returns {{ skill: object, patch: object }}
 */
export async function revertSkill(id, { toVersion, reason }) {
  const result = await quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}/revert`, {
    method: 'POST',
    body: JSON.stringify({ to_version: toVersion, reason }),
  })
  return result?.data || result
}

/**
 * Fetch the scoreboard row for a single QuoxSkill.
 * Maps to GET /api/quox-skills/:id/scoreboard
 * Returns null when no row exists (404) or scoreboard is not configured (503).
 *
 * @param {string} id - Skill ID
 * @returns {object|null}
 */
export async function getSkillScoreboard(id) {
  try {
    const result = await quoxflowFetch(`/quox-skills/${encodeURIComponent(id)}/scoreboard`)
    return result?.data || null
  } catch {
    return null
  }
}

/**
 * Fetch all scoreboard rows (bulk).
 * Maps to GET /api/quox-skills/scoreboards
 * Returns empty array when scoreboard is not configured.
 *
 * @returns {object[]}
 */
export async function listSkillScoreboards() {
  try {
    const result = await quoxflowFetch('/quox-skills/scoreboards')
    return result?.data || []
  } catch {
    return []
  }
}

/**
 * QSKL-11a: Archive a skill (manual one-click on decay-flagged skill).
 * Maps to POST /api/quox-skills/:id/archive
 *
 * @param {string} id - Skill ID
 * @param {string} [orgId] - Optional orgId override; falls back to localStorage current_org_id
 * @returns {object} Updated skill record
 */
export async function archiveQuoxSkill(id, orgId) {
  const effectiveOrgId = orgId || getCurrentOrgId()
  const params = new URLSearchParams()
  if (effectiveOrgId) params.set('orgId', effectiveOrgId)
  const query = params.toString()
  const result = await quoxflowFetch(
    `/quox-skills/${encodeURIComponent(id)}/archive${query ? '?' + query : ''}`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  return result?.data || result
}

/**
 * QSKL-11a: Bulk lookup edition + decayState for a list of skill IDs.
 * Used by CrystalsLibraryView to render the decay-warning badge.
 * Maps to GET /api/quox-skills/with-status?ids=a,b,c
 * @param {string[]} ids - Skill IDs to look up
 * @param {string} [orgId] - Optional orgId override; falls back to localStorage current_org_id
 * @returns {Array<{id: string, edition: string, decayState: string}>}
 */
export async function getQuoxSkillsWithStatus(ids, orgId) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const effectiveOrgId = orgId || getCurrentOrgId()
  const params = new URLSearchParams({ ids: ids.join(',') })
  if (effectiveOrgId) params.set('orgId', effectiveOrgId)
  return quoxflowFetch(`/quox-skills/with-status?${params.toString()}`)
}

// =============================================================================
// SKILL REVIEW QUEUE (QSKL-SAFETY.F)
// =============================================================================

/**
 * List skill review queue items for the current org.
 * Maps to GET /api/quox-skills/review-queue?status=...
 *
 * @param {object} [options]
 * @param {'pending'|'approved'|'rejected'} [options.status] defaults to 'pending'
 */
export async function listSkillReviewQueue({ status } = {}) {
  const params = new URLSearchParams()
  const orgId = getCurrentOrgId()
  if (orgId) params.set('orgId', orgId)
  if (status) params.set('status', status)
  const query = params.toString()
  const result = await quoxflowFetch(`/quox-skills/review-queue${query ? '?' + query : ''}`)
  return result?.data || []
}

/**
 * Get a single skill review queue item by id.
 * Maps to GET /api/quox-skills/review-queue/:id
 *
 * @param {string} id - queue row id
 */
export async function getSkillReviewQueueItem(id) {
  const result = await quoxflowFetch(`/quox-skills/review-queue/${encodeURIComponent(id)}`)
  return result?.data || null
}

/**
 * Approve a skill review queue item.
 * Maps to POST /api/quox-skills/review-queue/:id/approve
 *
 * @param {string} id - queue row id
 * @param {object} [options]
 * @param {string} [options.comment]
 */
export async function approveSkillReview(id, { comment } = {}) {
  const orgId = getCurrentOrgId()
  const params = new URLSearchParams()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const result = await quoxflowFetch(
    `/quox-skills/review-queue/${encodeURIComponent(id)}/approve${query ? '?' + query : ''}`,
    { method: 'POST', body: JSON.stringify({ comment: comment || null }) }
  )
  return result?.data || result
}

/**
 * Reject a skill review queue item.
 * Maps to POST /api/quox-skills/review-queue/:id/reject
 *
 * @param {string} id - queue row id
 * @param {object} [options]
 * @param {string} [options.comment]
 */
export async function rejectSkillReview(id, { comment } = {}) {
  const orgId = getCurrentOrgId()
  const params = new URLSearchParams()
  if (orgId) params.set('orgId', orgId)
  const query = params.toString()
  const result = await quoxflowFetch(
    `/quox-skills/review-queue/${encodeURIComponent(id)}/reject${query ? '?' + query : ''}`,
    { method: 'POST', body: JSON.stringify({ comment: comment || null }) }
  )
  return result?.data || result
}

// =============================================================================
// CLIENT OBJECT
// =============================================================================

export const quoxflowClient = {
  // Connection
  testConnection,

  // Workflows
  listWorkflows,
  getWorkflow,
  createWorkflow,
  duplicateWorkflow,
  deleteWorkflow,
  validateWorkflow,
  importN8nWorkflow,
  activateWorkflow,
  deactivateWorkflow,

  // Executions
  executeWorkflow,
  listExecutions,
  getExecution,
  getExecutionEnvelopes,

  // Envelopes
  queryEnvelopes,
  getEnvelope,
  getEnvelopeChain,

  // Policies
  listPolicies,
  createPolicy,
  getPolicy,
  updatePolicy,
  deletePolicy,
  testPolicy,
  testInlinePolicy,

  // Approvals
  listApprovals,
  getPendingApprovals,
  getApprovalStats,
  getApproval,
  approveRequest,
  denyRequest,
  cancelApproval,

  // Evidence
  listEvidence,
  getEvidence,
  getEvidenceContent,
  deleteEvidence,
  getEvidenceByEnvelope,
  getEvidenceByCorrelation,

  // Schedules
  listSchedules,
  updateSchedule,
  pauseSchedule,
  resumeSchedule,

  // Objective Template Import
  importObjectiveTemplate,

  // Skill Library (W4)
  listSkills,
  listCrystals,           // P1.G alias
  getSkill,
  packageSkillFromExecution,
  packageCrystalFromExecution,  // already added P1.B
  // Skill versioning (Sprint 2 SV)
  listSkillVersions,
  listCrystalVersions,    // P1.G alias
  rollbackSkill,
  rollbackCrystal,        // P1.G alias

  // QuoxSkills (QSKL-1)
  listQuoxSkills,
  getQuoxSkillById,
  getQuoxSkillByName,
  getQuoxSkillVersions,
  createQuoxSkill,
  updateQuoxSkill,
  deleteQuoxSkill,

  // QuoxSkill version history + revert (QSKL-4.F)
  listSkillPatches,
  revertSkill,

  // QuoxSkill evals + test runner (QSKL-5.G)
  runQuoxSkillTests,
  getQuoxSkillEvals,

  // QuoxSkill scoreboard (QSKL-7.7b)
  getSkillScoreboard,
  listSkillScoreboards,

  // QuoxSkill archive (QSKL-11a)
  archiveQuoxSkill,

  // QuoxSkill bulk status / decay badge (QSKL-11a)
  getQuoxSkillsWithStatus,

  // Skill Review Queue (QSKL-SAFETY.F)
  listSkillReviewQueue,
  getSkillReviewQueueItem,
  approveSkillReview,
  rejectSkillReview,
}

export default quoxflowClient
