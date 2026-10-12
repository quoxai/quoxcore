/**
 * Browser-Q Service — API wrapper for ScreenCap service calls.
 *
 * All calls go through the collector's tool execution API:
 *   POST /collector/api/v1/tools/execute
 *
 * The collector proxies to the ScreenCap service (port 3300) internally.
 */

const TOOLS_API = '/collector/api/v1/tools/execute'

/**
 * Execute a screencap tool via the collector.
 * @param {Function} authFetch - Authenticated fetch from AuthContext
 * @param {string} toolName - Tool name (e.g. 'browser_session_list')
 * @param {object} input - Tool input parameters
 * @param {string} [orgId] - Organisation ID (injected into input if provided)
 * @returns {Promise<object>}
 */
async function execTool(authFetch, toolName, input = {}, orgId) {
  const body = {
    tool_name: toolName,
    input: orgId ? { ...input, org_id: orgId } : input,
    agent_id: 'browser-q'
  }
  if (orgId) body.org_id = orgId

  const res = await authFetch(TOOLS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tool ${toolName} failed (${res.status}): ${text}`)
  }

  return res.json()
}

// ─── Session APIs ────────────────────────────────────────────────────

export async function listSessions(authFetch, orgId) {
  return execTool(authFetch, 'browser_session_list', { org_id: orgId })
}

export async function destroySession(authFetch, sessionId) {
  return execTool(authFetch, 'browser_session_destroy', { session_id: sessionId })
}

// ─── Sequence / Recorder APIs ────────────────────────────────────────

export async function listSequences(authFetch, orgId) {
  return execTool(authFetch, 'browser_sequence_list', {}, orgId)
}

export async function loadSequence(authFetch, orgId, sequenceId) {
  return execTool(authFetch, 'browser_sequence_load', { sequence_id: sequenceId }, orgId)
}

export async function deleteSequence(authFetch, orgId, sequenceId) {
  return execTool(authFetch, 'browser_sequence_delete', { sequence_id: sequenceId }, orgId)
}

export async function replaySequence(authFetch, orgId, sequenceId, variables = {}) {
  return execTool(authFetch, 'browser_replay', {
    sequence_id: sequenceId,
    variables
  }, orgId)
}

// ─── Monitor APIs ────────────────────────────────────────────────────

export async function listMonitors(authFetch, orgId) {
  return execTool(authFetch, 'browser_monitor_list', {}, orgId)
}

export async function createMonitor(authFetch, orgId, { url, name, cronExpression, threshold }) {
  return execTool(authFetch, 'browser_monitor_create', {
    url,
    name,
    cron_expression: cronExpression,
    threshold
  }, orgId)
}

export async function deleteMonitor(authFetch, orgId, monitorId) {
  return execTool(authFetch, 'browser_monitor_delete', { monitor_id: monitorId }, orgId)
}

export async function checkMonitor(authFetch, orgId, monitorId) {
  return execTool(authFetch, 'browser_monitor_check', { monitor_id: monitorId }, orgId)
}

export async function getMonitorHistory(authFetch, orgId, monitorId, limit = 20) {
  return execTool(authFetch, 'browser_monitor_history', { monitor_id: monitorId, limit }, orgId)
}

// ─── Video APIs ──────────────────────────────────────────────────────

export async function listVideos(authFetch, orgId) {
  return execTool(authFetch, 'browser_video_list', {}, orgId)
}

export async function deleteVideo(authFetch, orgId, videoId) {
  return execTool(authFetch, 'browser_video_delete', { video_id: videoId }, orgId)
}

// ─── Audit Log ───────────────────────────────────────────────────────
// The audit log endpoint (GET /actions/audit-log) lives on the screencap
// service and requires X-Service-Key. There is no tool wrapper for it yet.
// When a proxy or tool is added, wire it here. For now, audit entries are
// best viewed via chat ("Show Browser-Q audit log").

// ─── Browser Objectives (W2-1 / W2-2) ──────────────────────────────
// Direct to screencap via nginx proxy (no service key needed on /api/ endpoints)

const SCREENCAP_API = '/screencap/api'

export async function createBrowserObjective(authFetch, { url, intent, needsLogin, recordVideo, orgId, credentialId }) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, intent, needs_login: needsLogin, record_video: recordVideo, org_id: orgId || 'default', credential_id: credentialId || null })
  })
  if (!res.ok) throw new Error(`Create objective failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function planBrowserObjective(authFetch, objectiveId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}/plan?org_id=${encodeURIComponent(orgId || 'default')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Plan failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function executeBrowserObjective(authFetch, objectiveId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}/execute?org_id=${encodeURIComponent(orgId || 'default')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Execute failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function getBrowserObjective(authFetch, objectiveId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}?org_id=${encodeURIComponent(orgId || 'default')}`)
  if (!res.ok) throw new Error(`Get failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function approveStep(authFetch, objectiveId, stepId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}/approve-step/${stepId}?org_id=${encodeURIComponent(orgId || 'default')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Approve failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function cancelBrowserObjective(authFetch, objectiveId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}/cancel?org_id=${encodeURIComponent(orgId || 'default')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Cancel failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

export async function saveAsSequence(authFetch, objectiveId, orgId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-objectives/${objectiveId}/save-sequence?org_id=${encodeURIComponent(orgId || 'default')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Save failed (${res.status}): ${await res.text().catch(() => '')}`)
  return res.json()
}

// ─── Schedule API (BQ-W2-5) ─────────────────────────────────────────

/**
 * Create a schedule that triggers a saved browser sequence.
 * Uses the org-level schedule endpoint (POST /tasks/api/schedules).
 */
export async function scheduleBrowserAutomation(authFetch, { sequenceId, cronExpression, name, url, intent }) {
  const TASKS_BASE = '/tasks'
  const res = await authFetch(`${TASKS_BASE}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `[Browser-Q] ${name || 'Automation'}`,
      cron_expression: cronExpression,
      enabled: true,
      objectiveTemplate: {
        type: 'browser_automation',
        sequence_id: sequenceId,
        url,
        intent,
        agent_id: 'browser-q'
      }
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Schedule creation failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ─── Gallery APIs (BQ-W2-4) ─────────────────────────────────────────

export async function listGalleryScreenshots(authFetch, orgId, limit = 50) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/gallery?org_id=${encodeURIComponent(orgId)}&limit=${limit}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`List gallery failed (${res.status}): ${text}`)
  }
  return res.json()
}

export async function deleteGalleryScreenshot(authFetch, orgId, screenshotId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/gallery/${screenshotId}?org_id=${encodeURIComponent(orgId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Delete screenshot failed (${res.status}): ${text}`)
  }
  return res.json()
}

export async function keepGalleryScreenshot(authFetch, orgId, screenshotId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/gallery/${screenshotId}/keep?org_id=${encodeURIComponent(orgId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Keep screenshot failed (${res.status}): ${text}`)
  }
  return res.json()
}

/**
 * Get the URL for a gallery screenshot image (thumbnail or full).
 */
export function getGalleryImageUrl(orgId, screenshotId, type = 'thumb') {
  return `${SCREENCAP_API}/browser-q/gallery/${screenshotId}/image?org_id=${encodeURIComponent(orgId)}&type=${type}`
}

/**
 * Create an SSE connection for live objective streaming (BQ-W2-3).
 * Returns an EventSource. Caller should close it when done.
 */
export function createObjectiveStream(objectiveId) {
  // SSE goes direct to screencap via nginx proxy (no auth needed for SSE)
  const url = `/screencap/api/browser-objectives/${objectiveId}/stream`
  return new EventSource(url)
}

// ─── Objective History ────────────────────────────────────────────────

export async function listBrowserObjectives(authFetch, orgId, limit = 20) {
  try {
    const res = await authFetch(`${SCREENCAP_API}/browser-objectives?org_id=${encodeURIComponent(orgId || 'default')}&limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.objectives || []
  } catch {
    return []
  }
}

/**
 * List agentic browser runs from the tasks service (Fix 4).
 * These are objectives with browser-q agent tasks routed through QuoxFlow.
 */
export async function listAgenticBrowserRuns(authFetch, orgId, limit = 20) {
  try {
    const res = await authFetch(`/tasks/api/objectives?limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    const objectives = data.objectives || data || []
    // Filter to only those with browser-q tasks
    return objectives
      .filter(o => (o.tasks || []).some(t => t.agent_id === 'browser-q') ||
        o.title?.toLowerCase().includes('browser') ||
        o.description?.toLowerCase().includes('navigate'))
      .map(o => ({
        ...o,
        _source: 'agentic',
        intent: o.title,
        url: o.description?.match(/https?:\/\/[^\s,]+/)?.[0] || '',
      }))
  } catch {
    return []
  }
}

// ─── Stats (computed from other calls) ───────────────────────────────

export async function fetchDashboardStats(authFetch, orgId) {
  const [sessionsRes, sequencesRes, monitorsRes, videosRes, galleryRes, automationsRes, screencapRunsRes, agenticRunsRes] = await Promise.allSettled([
    listSessions(authFetch, orgId),
    listSequences(authFetch, orgId),
    listMonitors(authFetch, orgId),
    listVideos(authFetch, orgId),
    listGalleryScreenshots(authFetch, orgId, 15),
    listAutomationsApi(authFetch, orgId),
    listBrowserObjectives(authFetch, orgId, 50),
    listAgenticBrowserRuns(authFetch, orgId, 30),
  ])

  const sessions = sessionsRes.status === 'fulfilled' ? (sessionsRes.value?.sessions || []) : []
  const sequences = sequencesRes.status === 'fulfilled' ? (sequencesRes.value?.sequences || []) : []
  const monitors = monitorsRes.status === 'fulfilled' ? (monitorsRes.value?.monitors || []) : []
  const videos = videosRes.status === 'fulfilled' ? (videosRes.value?.videos || []) : []
  const gallery = galleryRes.status === 'fulfilled' ? (galleryRes.value?.screenshots || []) : []
  const automations = automationsRes.status === 'fulfilled' ? (automationsRes.value || []) : []
  const screencapRuns = screencapRunsRes.status === 'fulfilled' ? screencapRunsRes.value : []
  const agenticRuns = agenticRunsRes.status === 'fulfilled' ? agenticRunsRes.value : []

  // Merge screencap + agentic runs, sorted newest first
  const objectives = [...screencapRuns.map(o => ({ ...o, _source: o._source || 'screencap' })), ...agenticRuns]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))

  // BQF-4: Track which APIs failed so frontend can show a warning
  const failures = []
  if (sessionsRes.status === 'rejected') failures.push('sessions')
  if (sequencesRes.status === 'rejected') failures.push('sequences')
  if (monitorsRes.status === 'rejected') failures.push('monitors')
  if (videosRes.status === 'rejected') failures.push('videos')
  if (galleryRes.status === 'rejected') failures.push('gallery')

  return { sessions, sequences, monitors, videos, gallery, automations, objectives, failures }
}

// ─── Org Settings (BQF — domain allowlist persistence) ──────────────

export async function getOrgSettings(authFetch, orgId) {
  try {
    const res = await authFetch(`${SCREENCAP_API}/browser-q/settings?org_id=${encodeURIComponent(orgId)}`)
    if (!res.ok) return { allowed_domains: [] }
    const data = await res.json()
    return data.settings || { allowed_domains: [] }
  } catch {
    return { allowed_domains: [] }
  }
}

export async function saveOrgSettings(authFetch, orgId, settings) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/settings?org_id=${encodeURIComponent(orgId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId, settings })
  })
  if (!res.ok) throw new Error(`Save settings failed (${res.status})`)
  return res.json()
}

// ─── Vault: Website Login Credentials ────────────────────────────────

/**
 * Fetch browser_login credentials from the vault for the credential picker.
 * Falls back gracefully if vault is unavailable.
 */
export async function listBrowserCredentials(authFetch, orgId) {
  try {
    const res = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/integrations?type=browser_login`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.credentials || data.integrations || []).map(c => ({
      id: c.id,
      label: c.label || c.name || 'Unnamed',
      domain: c.metadata?.domain || c.endpoint_url || '',
      username: c.metadata?.username || c.key_preview || '',
      lastUsed: c.last_used_at
    }))
  } catch {
    return []
  }
}

/**
 * Quick-create a browser_login credential in the vault.
 */
export async function createBrowserCredential(authFetch, orgId, { domain, username, password, label }) {
  const res = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/integrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      integration_type: 'browser_login',
      label: label || `${domain} — ${username}`,
      credentials: { domain, username, password },
      endpoint_url: domain,
      description: `Browser-Q login for ${domain}`
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to save credential (${res.status}): ${text}`)
  }
  return res.json()
}

// ─── Automations API (BQ-W2R Phase 3) ──────────────────────────────

export async function listAutomationsApi(authFetch, orgId, limit = 50) {
  try {
    const res = await authFetch(`${SCREENCAP_API}/browser-q/automations?org_id=${encodeURIComponent(orgId)}&limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.automations || []
  } catch { return [] }
}

export async function createAutomationFromRun(authFetch, orgId, objectiveId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/automations/from-run/${objectiveId}?org_id=${encodeURIComponent(orgId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Save as automation failed (${res.status})`)
  return res.json()
}

export async function runAutomationApi(authFetch, orgId, automationId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/automations/${automationId}/run?org_id=${encodeURIComponent(orgId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Run automation failed (${res.status})`)
  return res.json()
}

export async function deleteAutomationApi(authFetch, orgId, automationId) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/automations/${automationId}?org_id=${encodeURIComponent(orgId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Delete automation failed (${res.status})`)
  return res.json()
}

// ─── QuoxFlow Agentic Browser Automation (QE2 Phase 3) ─────────────

import { createWorkflow, executeWorkflow } from './quoxflowClient'

/**
 * Create and execute a browser automation via QuoxFlow's agentic engine.
 * This replaces the screencap-native objective flow with a unified execution.
 *
 * Creates a QuoxFlow workflow with a single agent:agentic node that:
 * - Takes the user's objective as input
 * - Uses browser tools (navigate, click, type, fill_form, screenshot, etc.)
 * - Observes the page after each action (screenshot + DOM context)
 * - Thinks about what to do next (LLM decision)
 * - Loops until the objective is achieved
 *
 * Returns the QuoxFlow execution result with full AOCL evidence trail.
 */
export async function createAgenticBrowserRun(intent, url, options = {}) {
  const { credentialId, needsLogin, maxIterations = 10 } = options

  // Build a QuoxFlow workflow with one agentic node
  const workflow = {
    name: `Browser: ${intent.substring(0, 60)}`,
    description: intent,
    tags: ['browser-q', 'agentic'],
    nodes: [
      {
        id: 'trigger',
        type: 'trigger:webhook',
        name: 'Start',
      },
      {
        id: 'agent',
        type: 'agent:agentic',
        name: 'Browser Agent',
        config: {
          objective: `${intent}. Start by navigating to ${url}.${needsLogin ? ' Login is required — use vault credentials.' : ''}${credentialId ? ` Credential ID: ${credentialId}` : ''}`,
          agent_id: 'browser-q',
          max_iterations: maxIterations,
          available_actions: [
            'navigate', 'click', 'type', 'fill_form', 'scroll', 'wait',
            'screenshot', 'extract', 'select', 'find_element', 'analyze_forms',
            'login', 'done',
          ],
        },
      },
    ],
    edges: [
      { source: 'trigger', target: 'agent' },
    ],
  }

  // Create the workflow
  const created = await createWorkflow(workflow)
  if (!created?.id) throw new Error('Failed to create workflow')

  // Execute it
  let activeOrgId
  try { activeOrgId = localStorage.getItem('current_org_id') || undefined } catch {}
  const execution = await executeWorkflow(created.id, {
    triggerData: { url, intent, credentialId, needsLogin },
    async: true, // Don't wait for completion — the UI polls
    workflowName: workflow.name,
    nodeCount: workflow.nodes.length,
    ...(activeOrgId ? { orgId: activeOrgId } : {}),
  })

  return {
    workflowId: created.id,
    executionId: execution?.executionId || execution?.id,
    status: 'running',
    intent,
    url,
  }
}

// ─── Extraction Results API (BQ-CA-1) ──────────────────────────────

export async function listExtractions(authFetch, orgId, { limit = 50, type } = {}) {
  try {
    const params = new URLSearchParams({ org_id: orgId, limit: String(limit) })
    if (type) params.set('type', type)
    const res = await authFetch(`${SCREENCAP_API}/browser-q/extractions?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.extractions || []
  } catch { return [] }
}

export async function getExtraction(authFetch, orgId, id) {
  try {
    const res = await authFetch(`${SCREENCAP_API}/browser-q/extractions/${id}?org_id=${encodeURIComponent(orgId)}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.extraction || null
  } catch { return null }
}

export async function deleteExtraction(authFetch, orgId, id) {
  const res = await authFetch(`${SCREENCAP_API}/browser-q/extractions/${id}?org_id=${encodeURIComponent(orgId)}`, { method: 'DELETE' })
  return res.ok
}

export function getExtractionExportUrl(orgId, id, format = 'csv') {
  return `${SCREENCAP_API}/browser-q/extractions/${id}/export?org_id=${encodeURIComponent(orgId)}&format=${format}`
}

// ─── Browser Files API (BQ-CA-3) ──────────────────────────────────

export async function listBrowserFilesApi(authFetch, orgId) {
  try {
    const res = await authFetch(`${SCREENCAP_API}/browser-q/files?org_id=${encodeURIComponent(orgId)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.files || []
  } catch { return [] }
}

export function getBrowserFileDownloadUrl(orgId, fileId) {
  return `${SCREENCAP_API}/browser-q/files/${fileId}/download?org_id=${encodeURIComponent(orgId)}`
}
