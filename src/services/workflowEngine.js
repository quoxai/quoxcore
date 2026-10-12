/**
 * Unified Workflow Engine Adapter
 *
 * Routes all workflow operations to QuoxFlow.
 * n8n is no longer used as a workflow engine.
 *
 * Usage:
 *   import { listWorkflows, executeWorkflow } from './workflowEngine'
 *   const { workflows } = await listWorkflows()
 */

import * as quoxflow from './quoxflowClient'
import { parseWorkflowJson, summarizeWorkflow, exportWorkflowJson, getWorkflowTemplates, WORKFLOW_TEMPLATES } from './workflowUtils'

// Engine state
let quoxflowHealthy = null // null = unknown, true/false
let lastHealthCheck = 0
const HEALTH_CHECK_INTERVAL = 30000 // 30 seconds

/**
 * Set preferred workflow engine (kept for API compat — always uses QuoxFlow).
 */
export function setPreferredEngine(_engine) {
  // No-op: QuoxFlow is the only engine
}

/**
 * Get current engine status.
 */
export function getEngineStatus() {
  return {
    preferred: 'quoxflow',
    quoxflow: quoxflowHealthy,
    lastCheck: lastHealthCheck ? new Date(lastHealthCheck).toISOString() : null,
  }
}

/**
 * Refresh health status for QuoxFlow.
 */
async function refreshHealth() {
  const now = Date.now()
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) return
  lastHealthCheck = now

  try {
    const result = await quoxflow.testConnection()
    quoxflowHealthy = result?.connected ?? false
  } catch {
    quoxflowHealthy = false
  }
}

// =============================================================================
// CONNECTION
// =============================================================================

/**
 * Test connection to QuoxFlow.
 */
export async function testConnection() {
  return quoxflow.testConnection()
}

/**
 * Test connections to available engines.
 */
export async function testAllConnections() {
  const [qf] = await Promise.allSettled([
    quoxflow.testConnection(),
  ])
  return {
    quoxflow: qf.status === 'fulfilled' ? qf.value : { connected: false, error: qf.reason?.message },
  }
}

// =============================================================================
// WORKFLOW OPERATIONS
// =============================================================================

/**
 * List workflows from QuoxFlow.
 * Returns normalized shape: { workflows: [...] }
 */
export async function listWorkflows(options = {}) {
  const result = await quoxflow.listWorkflows(options)
  const workflows = result?.data || result?.workflows || []
  return {
    workflows: workflows.map(normalizeWorkflow),
    source: 'quoxflow',
  }
}

/**
 * Get a single workflow.
 */
export async function getWorkflow(workflowId) {
  const result = await quoxflow.getWorkflow(workflowId)
  return normalizeWorkflow(result?.data || result)
}

/**
 * Create a new workflow.
 *
 * The QuoxFlow API wraps responses as { success, data, meta }. Without
 * unwrapping, callers see the envelope (no top-level `id`) — that's why
 * deploy was rendering "(ID: undefined)".
 */
export async function createWorkflow(workflow) {
  const result = await quoxflow.createWorkflow(workflow)
  return normalizeWorkflow(result?.data || result)
}

/**
 * Update workflow metadata (name, description, tags, etc.).
 */
export async function updateWorkflow(workflowId, updates) {
  return quoxflow.updateWorkflow(workflowId, updates)
}

/**
 * Delete a workflow.
 */
export async function deleteWorkflow(workflowId) {
  return quoxflow.deleteWorkflow(workflowId)
}

/**
 * Activate a workflow — registers its triggers (schedule / event /
 * webhook) so the engine starts firing them. P6-phase-2 fix
 * (2026-05-03): was a stub returning a fake success message; now hits
 * the real lifecycle endpoint.
 */
export async function activateWorkflow(workflowId) {
  return quoxflow.activateWorkflow(workflowId)
}

/**
 * Deactivate a workflow — unregisters its triggers. Active webhooks
 * stop responding; cron schedules stop firing.
 */
export async function deactivateWorkflow(workflowId) {
  return quoxflow.deactivateWorkflow(workflowId)
}

// =============================================================================
// EXECUTION OPERATIONS
// =============================================================================

/**
 * Execute a workflow.
 * @param {string} workflowId
 * @param {object} [data] - Trigger data or options with workflowName
 */
function readActiveOrgId() {
  try { return localStorage.getItem('current_org_id') || undefined; } catch { return undefined; }
}

export async function executeWorkflow(workflowId, data = {}) {
  // `async` and `workflowName` / `nodeCount` are caller-options, not workflow
  // input. Anything else lands in triggerData (the actual workflow input).
  const { workflowName, nodeCount, async: asyncFlag, orgId: explicitOrgId, ...triggerData } = data
  const orgId = explicitOrgId ?? readActiveOrgId();
  return quoxflow.executeWorkflow(workflowId, {
    triggerData,
    workflowName,
    nodeCount,
    async: asyncFlag,
    ...(orgId ? { orgId } : {}),
  })
}

/**
 * List executions.
 * Returns normalized shape: { executions: [...] }
 */
export async function listExecutions(options = {}) {
  const result = await quoxflow.listExecutions(options)
  const executions = result?.data || result?.executions || []
  return {
    executions: executions.map(normalizeExecution),
    source: 'quoxflow',
  }
}

/**
 * Get execution details.
 */
export async function getExecution(executionId) {
  return quoxflow.getExecution(executionId)
}

// =============================================================================
// SCHEDULE OPERATIONS
// =============================================================================

/**
 * List active cron schedules.
 */
export async function listSchedules() {
  try {
    return await quoxflow.listSchedules()
  } catch (err) {
    console.warn('[WorkflowEngine] listSchedules failed:', err.message)
    return []
  }
}

/**
 * Update a schedule's cron expression, timezone, or paused state.
 */
export async function updateSchedule(workflowId, nodeId, updates) {
  return quoxflow.updateSchedule(workflowId, nodeId, updates)
}

/**
 * Pause a schedule.
 */
export async function pauseSchedule(workflowId, nodeId) {
  return quoxflow.pauseSchedule(workflowId, nodeId)
}

/**
 * Resume a paused schedule.
 */
export async function resumeSchedule(workflowId, nodeId) {
  return quoxflow.resumeSchedule(workflowId, nodeId)
}

// =============================================================================
// WORKFLOW VERSIONS — auth-service endpoints
// These call /api/orgs/:orgId/workflows/:workflowId/versions on the auth
// service (not quoxflow), so they accept authFetch from useAuth().
// =============================================================================

/**
 * List version history for a workflow (latest 50, newest-first).
 * @param {function} authFetch  — from useAuth()
 * @param {string}   orgId
 * @param {string}   workflowId
 * @param {boolean}  [includeDefinition=false] — set true to include definition_json in each row
 * @returns {Promise<Array>} array of {id, version, change_summary, created_by, created_by_name, created_at}
 */
export async function listWorkflowVersions(authFetch, orgId, workflowId, includeDefinition = false) {
  const qs = includeDefinition ? '?include=definition' : ''
  const res = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/workflows/${encodeURIComponent(workflowId)}/versions${qs}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const e = new Error(err.error || `Failed to list versions (${res.status})`)
    e.status = res.status
    throw e
  }
  const data = await res.json()
  return data.versions || []
}

/**
 * Restore a prior workflow version.
 * Creates a new highest-version row from the target version's definition.
 * @param {function} authFetch
 * @param {string}   orgId
 * @param {string}   workflowId
 * @param {number}   version  — the version number to restore
 * @returns {Promise<{restored: boolean, restored_from_version: number, new_version: number}>}
 */
export async function restoreWorkflowVersion(authFetch, orgId, workflowId, version) {
  const res = await authFetch(
    `/api/orgs/${encodeURIComponent(orgId)}/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}/restore`,
    { method: 'POST' }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Failed to restore version (${res.status})`)
  }
  return res.json()
}

// =============================================================================
// PURE UTILITY FUNCTIONS (engine-agnostic)
// Re-exported from workflowUtils
// =============================================================================

export { parseWorkflowJson, summarizeWorkflow, exportWorkflowJson, getWorkflowTemplates, WORKFLOW_TEMPLATES }

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

/**
 * Normalize a QuoxFlow workflow to n8n-compatible shape.
 * QuoxFlow workflows have different field names.
 */
function normalizeWorkflow(wf) {
  if (!wf) return wf
  // Already n8n format (has both nodes and connections)
  if (wf.nodes && wf.connections && Object.keys(wf.connections).length > 0) return wf

  // QuoxFlow wraps nodes/edges inside a `definition` object
  const def = wf.definition || {}
  const nodes = wf.nodes || def.nodes || []
  const edges = wf.edges || def.edges || []
  const connections = {}

  if (edges.length > 0 && nodes.length > 0) {
    // Build ID → name lookup
    const idToName = {}
    for (const n of nodes) {
      if (n.id && n.name) idToName[n.id] = n.name
    }
    // Convert each edge to n8n connection format
    for (const edge of edges) {
      const sourceName = idToName[edge.source] || edge.source
      const targetName = idToName[edge.target] || edge.target
      if (!connections[sourceName]) {
        connections[sourceName] = { main: [[]] }
      }
      const outputIdx = edge.sourceHandle ? parseInt(edge.sourceHandle.replace('output_', ''), 10) || 0 : 0
      // Ensure the output channel array exists
      while (connections[sourceName].main.length <= outputIdx) {
        connections[sourceName].main.push([])
      }
      connections[sourceName].main[outputIdx].push({
        node: targetName,
        index: edge.targetHandle ? parseInt(edge.targetHandle.replace('input_', ''), 10) || 0 : 0,
      })
    }
  }

  return {
    id: wf.id,
    name: wf.name,
    active: wf.active !== false, // QuoxFlow default: active
    nodes,
    edges,
    connections,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
    description: wf.description,
    tags: wf.tags || wf.metadata?.tags || [],
    metadata: wf.metadata,
    _source: 'quoxflow',
  }
}

/**
 * Normalize a QuoxFlow execution to n8n-compatible shape.
 */
function normalizeExecution(exec) {
  if (!exec) return exec
  return {
    id: exec.id,
    workflowId: exec.workflowId,
    status: exec.status === 'completed' ? 'success' : exec.status, // n8n uses 'success' not 'completed'
    startedAt: exec.startedAt,
    stoppedAt: exec.completedAt || exec.stoppedAt,
    mode: exec.mode || 'api',
    _source: 'quoxflow',
  }
}

// =============================================================================
// CLIENT OBJECT
// =============================================================================

export const workflowEngine = {
  // Engine control
  setPreferredEngine,
  getEngineStatus,
  testConnection,
  testAllConnections,

  // Workflows
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  activateWorkflow,
  deactivateWorkflow,

  // Executions
  executeWorkflow,
  listExecutions,
  getExecution,

  // Schedules
  listSchedules,
  updateSchedule,
  pauseSchedule,
  resumeSchedule,

  // Utilities
  parseWorkflowJson,
  summarizeWorkflow,
  exportWorkflowJson,
  getWorkflowTemplates,
}

export default workflowEngine
