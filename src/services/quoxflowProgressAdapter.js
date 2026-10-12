/**
 * QuoxFlow Progress Adapter
 *
 * Maps QuoxFlow execution state into objective task-progress format
 * so the existing ObjectivesView UI can display QuoxFlow execution progress.
 *
 * Used when an objective template has been converted to a QuoxFlow workflow
 * and is executing via the QuoxFlow engine instead of the native task executor.
 *
 * AEE-FULL Gap 3: dual-reads both legacy `quox.flow.agent.*` and canonical
 * `quox.flow.llm.*` intent strings. Historical envelopes carry legacy intents
 * (WARD-witnessed; cannot be DB-migrated); new envelopes carry canonical
 * intents. This is the correct permanent shape, NOT transition debt.
 * See src/lib/aee/llmIntents.js for the union arrays and payload normalizer.
 */
import {
  LLM_INVOKED_INTENTS,
  LLM_COMPLETED_INTENTS,
  LLM_FAILED_INTENTS,
  normalizeLlmEnvelopePayload,
} from '../lib/aee/llmIntents.js'

/**
 * Map a QuoxFlow execution response into task-progress entries.
 *
 * @param {object} execution - QuoxFlow execution from GET /executions/:id
 *   Expected shape: { id, workflowId, status, output, envelopes[], duration }
 * @param {Array<{ taskIndex, taskTitle, agentId, nodeId, nodeType }>} nodeMapping
 *   The mapping returned by importObjectiveTemplate, linking task indices to node IDs.
 * @returns {Array<{ taskIndex, taskTitle, agentId, status, result, tokens_used, duration_ms }>}
 */
export function mapExecutionToProgress(execution, nodeMapping) {
  if (!execution || !nodeMapping) return []

  const envelopes = execution.envelopes || []
  const nodeStates = new Map()

  // Build node state from envelopes
  for (const env of envelopes) {
    const nodeId = env.payload?.nodeId
    if (!nodeId) continue

    const existing = nodeStates.get(nodeId) || { status: 'pending' }

    if (LLM_INVOKED_INTENTS.includes(env.intent) || env.intent === 'quox.flow.node.started') {
      existing.status = 'running'
      existing.startedAt = env.ts
    } else if (LLM_COMPLETED_INTENTS.includes(env.intent) || env.intent === 'quox.flow.node.completed') {
      existing.status = 'completed'
      existing.completedAt = env.ts
      // Normalize tokens via the dual-shape adapter so v1 envelopes get
      // tokens_input+output summed and legacy envelopes pass through the
      // opaque tokens_used scalar.
      const norm = normalizeLlmEnvelopePayload(env)
      if (norm) {
        existing.tokens_used = norm.tokensUsed ?? 0
        existing.tools_used = norm.toolsUsed
        existing.duration_ms = norm.durationMs ?? 0
      } else {
        // Non-LLM completion envelopes (e.g. quox.flow.node.completed for a
        // non-agent node) — fall back to legacy field reads.
        existing.tokens_used = env.payload?.tokens_used || 0
        existing.tools_used = env.payload?.tools_used || []
        existing.duration_ms = env.payload?.duration_ms || env.payload?.duration || 0
      }
    } else if (LLM_FAILED_INTENTS.includes(env.intent) || env.intent === 'quox.flow.node.failed') {
      existing.status = 'failed'
      existing.error = env.payload?.error_message || env.payload?.message || 'Unknown error'
    } else if (env.intent === 'quox.flow.node.skipped') {
      existing.status = 'skipped'
    }

    // Capture output from result envelopes
    if (env.type === 'result' && env.payload?.nodeId === nodeId) {
      existing.result = env.payload?.output_preview || env.payload
    }

    nodeStates.set(nodeId, existing)
  }

  // Also check execution.output for final node outputs
  const nodeOutputs = execution.output?.nodeOutputs || execution.nodeOutputs || {}
  for (const [nodeId, output] of Object.entries(nodeOutputs)) {
    const existing = nodeStates.get(nodeId) || { status: 'completed' }
    if (!existing.result) {
      const out = output?.result || output
      existing.result = typeof out === 'string' ? out : JSON.stringify(out)
    }
    nodeStates.set(nodeId, existing)
  }

  // Map node states to task progress via nodeMapping
  return nodeMapping.map(mapping => {
    const state = nodeStates.get(mapping.nodeId) || { status: 'pending' }

    return {
      taskIndex: mapping.taskIndex,
      taskTitle: mapping.taskTitle,
      agentId: mapping.agentId,
      nodeId: mapping.nodeId,
      status: state.status,
      result: state.result || null,
      error: state.error || null,
      tokens_used: state.tokens_used || 0,
      tools_used: state.tools_used || [],
      duration_ms: state.duration_ms || 0,
    }
  })
}

/**
 * Derive overall execution status from task progress entries.
 *
 * @param {Array<{ status }>} taskProgress - Output of mapExecutionToProgress
 * @returns {'pending'|'running'|'completed'|'completed_with_errors'|'failed'}
 */
export function deriveOverallStatus(taskProgress) {
  if (!taskProgress || taskProgress.length === 0) return 'pending'

  const statuses = taskProgress.map(t => t.status)

  const hasRunning = statuses.some(s => s === 'running')
  const hasFailed = statuses.some(s => s === 'failed')
  const hasCompleted = statuses.some(s => s === 'completed')
  const allDone = statuses.every(s => s === 'completed' || s === 'skipped' || s === 'failed')

  if (statuses.every(s => s === 'completed' || s === 'skipped')) return 'completed'
  // Still running — report as running even if some failed (not terminal yet)
  if (hasRunning) return 'running'
  // All done but some failed
  if (allDone && hasFailed) {
    return hasCompleted ? 'completed_with_errors' : 'failed'
  }
  if (hasFailed) return 'failed'
  return 'pending'
}

/**
 * Poll a QuoxFlow execution and call onProgress for each state change.
 *
 * @param {string} executionId
 * @param {Array} nodeMapping
 * @param {Function} onProgress - Called with (taskProgress, overallStatus)
 * @param {object} [options]
 * @param {number} [options.intervalMs=2000]
 * @param {number} [options.maxPollMs=600000]
 * @returns {{ stop: Function }} - Call stop() to cancel polling
 */
export function watchExecution(executionId, nodeMapping, onProgress, options = {}) {
  const intervalMs = options.intervalMs || 2000
  const maxPollMs = options.maxPollMs || 600000
  let stopped = false
  let lastStatusHash = ''
  let pendingTimer = null
  let consecutiveErrors = 0
  const startTime = Date.now()

  async function poll() {
    if (stopped) return

    try {
      // Dynamic import to avoid circular deps at module load
      const { getExecution, getExecutionEnvelopes } = await import('./quoxflowClient.js')

      const [execution, envelopesResp] = await Promise.all([
        getExecution(executionId),
        getExecutionEnvelopes(executionId),
      ])

      consecutiveErrors = 0

      const execWithEnvelopes = {
        ...execution,
        envelopes: envelopesResp?.data || envelopesResp || [],
      }

      const progress = mapExecutionToProgress(execWithEnvelopes, nodeMapping)
      const overall = deriveOverallStatus(progress)

      // Only call onProgress if something changed
      const statusHash = JSON.stringify(progress.map(p => p.status))
      if (statusHash !== lastStatusHash) {
        lastStatusHash = statusHash
        onProgress(progress, overall)
      }

      // Stop polling on terminal states
      if (overall === 'completed' || overall === 'failed' || overall === 'completed_with_errors') {
        stopped = true
        return
      }

      // Timeout guard
      if (Date.now() - startTime > maxPollMs) {
        stopped = true
        return
      }
    } catch {
      consecutiveErrors++
      // After 5 consecutive failures, stop polling to avoid infinite retries
      if (consecutiveErrors >= 5) {
        stopped = true
        return
      }
    }

    if (!stopped) {
      pendingTimer = setTimeout(poll, intervalMs)
    }
  }

  poll()

  return {
    stop() {
      stopped = true
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
    },
  }
}
