/**
 * Workflow Converter — QE2 Phase 4
 *
 * Converts the decomposer's task array into a QuoxFlow workflow JSON.
 * This is the bridge between "objectives" (planning layer) and
 * "QuoxFlow" (execution engine).
 *
 * Input:  [{title, agent_id, prompt, depends_on}]
 * Output: {id, name, nodes, edges, settings, metadata, tags}
 */

const BROWSER_ACTIONS = [
  'navigate', 'click', 'type', 'fill_form', 'scroll', 'wait',
  'screenshot', 'extract', 'select', 'find_element', 'analyze_forms',
  'login', 'done',
]

/**
 * Convert a decomposed task array into a QuoxFlow workflow.
 *
 * @param {Array} tasks - [{title, agent_id, prompt, depends_on}]
 * @param {Object} options
 * @param {string} options.objectiveId
 * @param {string} options.objectiveTitle
 * @param {string} [options.orgId]
 * @param {string} [options.userId]
 * @param {string} [options.teamId]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxToolCalls]
 * @param {number} [options.maxDurationMs]
 * @returns {Object} QuoxFlow workflow JSON
 */
export function convertTasksToWorkflow(tasks, options = {}) {
  const {
    objectiveId,
    objectiveTitle,
    orgId,
    userId,
    teamId,
    maxTokens,
    maxToolCalls,
    maxDurationMs,
  } = options

  // Dynamic per-node timeout: divide objective budget across nodes, clamp 180s–600s
  // Fleet SSH batches routinely take 3-5min per batch
  const perNodeTimeout = maxDurationMs && tasks.length > 0
    ? Math.max(180000, Math.min(600000, Math.floor(maxDurationMs / tasks.length)))
    : 300000

  const nodes = []
  const edges = []

  // Trigger node — every workflow starts with one
  nodes.push({
    id: 'trigger',
    type: 'trigger:webhook',
    name: 'Start',
    config: {
      path: `/objective/${objectiveId || 'unknown'}`,
      method: 'POST',
    },
  })

  // Convert each task to a node
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const nodeId = `task-${i}`
    const isBrowser = task.agent_id === 'browser-q'
    const isHuman = task.kind === 'human'

    if (isHuman) {
      // HV2-6: a human objective step pauses the workflow and lands in the
      // assignee's inbox; their response (approve / request-changes) resumes
      // execution via the human:task executor + ApprovalEngine.
      nodes.push({
        id: nodeId,
        type: 'human:task',
        name: task.title,
        config: {
          title: task.title,
          message: task.prompt || task.description || `Human step: ${task.title}`,
          ...(task.assignee_id ? { assignTo: [task.assignee_id] } : {}),
          actions: [
            { action: 'approve', label: 'Approve', style: 'primary' },
            { action: 'reject', label: 'Request changes', style: 'warning' },
          ],
          kind: 'objective_step',
          objective_id: objectiveId || undefined,
          org_id: orgId || undefined,
          timeout_ms: perNodeTimeout,
        },
      })
    } else if (isBrowser) {
      // Browser tasks get the agentic executor with observe-think-act loop + vision
      nodes.push({
        id: nodeId,
        type: 'agent:agentic',
        name: task.title,
        config: {
          objective: task.prompt,
          agent_id: 'browser-q',
          max_iterations: 15,
          available_actions: BROWSER_ACTIONS,
          objective_id: objectiveId || undefined,
          progress_callback_url: 'http://tasks:3104',
          // TRUST-GATE-MT: agentic executor reads config.org_id || trigger
          // input — NOT workflow.metadata (which only agent:invoke consults).
          // Without this, objective-driven agentic runs wrote evidence and
          // skill drafts to the 'default' org.
          org_id: orgId || undefined,
        },
      })
    } else {
      // All other agents use standard invoke
      nodes.push({
        id: nodeId,
        type: 'agent:invoke',
        name: task.title,
        config: {
          agent_id: task.agent_id,
          prompt: task.prompt,
          timeout_ms: perNodeTimeout,
          // MACH-FOLLOWUP WI-D: owner-authored persona/voice channel, rides
          // to the quoxflow executor body -> collector invoke -> /chat merge
          // (plan §4.4 step 5). `agent:agentic` (browser-q) has no persona
          // seam and is out of scope in v1 (see §4.1 non-goals).
          ...(task.system_prompt ? { system_prompt: task.system_prompt } : {}),
        },
      })
    }

    // Build edges from dependencies
    const deps = task.depends_on || []
    if (deps.length === 0) {
      // No dependencies → connect to trigger
      edges.push({ source: 'trigger', target: nodeId })
    } else {
      for (const depIndex of deps) {
        edges.push({ source: `task-${depIndex}`, target: nodeId })
      }
    }
  }

  // Build workflow object
  const workflow = {
    id: `wf-obj-${objectiveId || Date.now()}`,
    name: `Objective: ${(objectiveTitle || 'Untitled').substring(0, 60)}`,
    version: '1.0.0',
    description: objectiveTitle,
    tags: ['objective', ...(orgId ? [orgId] : [])],
    nodes,
    edges,
    metadata: {
      objectiveId,
      orgId: orgId || null,
      userId: userId || null,
      teamId: teamId || null,
      source: 'decomposer',
    },
  }

  // Budget settings
  if (maxTokens || maxToolCalls || maxDurationMs) {
    workflow.settings = {
      budget: {
        ...(maxTokens ? { maxTokens } : {}),
        ...(maxToolCalls ? { maxToolCalls } : {}),
        ...(maxDurationMs ? { maxDurationMs } : {}),
      },
    }
  }

  return workflow
}
