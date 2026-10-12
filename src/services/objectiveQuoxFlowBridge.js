/**
 * Objective ↔ QuoxFlow Bridge — QE2 Phase 6
 *
 * Bridges the Objectives UI page to QuoxFlow execution data.
 * Objectives that were routed through QuoxFlow (via executeViaQuoxFlow)
 * can be queried here for status, detail, and agentic thinking decisions.
 */

import { listExecutions, getExecution, getExecutionEnvelopes } from './quoxflowClient'

/**
 * Strip the "Objective: " prefix from workflow names to get a clean title.
 */
function stripObjectivePrefix(name) {
  if (!name) return ''
  return name.replace(/^Objective:\s*/i, '')
}

/**
 * List QuoxFlow executions that represent objectives.
 *
 * @param {object} [options]
 * @param {string} [options.orgId] - Filter by org
 * @returns {Array<{ executionId, workflowId, title, status, objectiveId, orgId, durationMs, nodeCount }>}
 */
export async function listObjectiveExecutions(options = {}) {
  try {
    const executions = await listExecutions({
      tag: 'objective',
      ...(options.orgId ? { orgId: options.orgId } : {}),
    })

    const list = Array.isArray(executions) ? executions : (executions?.data || [])

    return list.map(exec => ({
      executionId: exec.id,
      workflowId: exec.workflowId,
      title: stripObjectivePrefix(exec.workflowName),
      status: exec.status,
      objectiveId: exec.metadata?.objectiveId,
      orgId: exec.metadata?.orgId,
      durationMs: exec.durationMs,
      nodeCount: exec.nodeCount,
    }))
  } catch {
    return []
  }
}

/**
 * Get detailed execution data for a single objective, including
 * envelopes and agentic thinking decisions.
 *
 * @param {string} executionId
 * @returns {{ executionId, status, objectiveMet, actionLog, envelopes, thinkingDecisions } | null}
 */
export async function getObjectiveExecution(executionId) {
  try {
    const [exec, envelopes] = await Promise.all([
      getExecution(executionId),
      getExecutionEnvelopes(executionId),
    ])

    const execData = exec?.data || exec || {}
    const envelopeList = Array.isArray(envelopes) ? envelopes : (envelopes?.data || [])

    const thinkingDecisions = envelopeList
      .filter(env => env.intent === 'quox.agent.think.decide')
      .map(env => env.payload)

    return {
      executionId: execData.id,
      status: execData.status,
      objectiveMet: execData.output?.objective_met ?? false,
      actionLog: execData.output?.action_log,
      envelopes: envelopeList,
      thinkingDecisions,
    }
  } catch {
    return null
  }
}
