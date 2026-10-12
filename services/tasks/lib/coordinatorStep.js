/**
 * Coordinator Step — MACH-FOLLOWUP WI-C (MACHINERY item 4(c)).
 *
 * When a TEAM objective finalises, this module runs one bounded LLM
 * "coordinator" call that synthesises all members' task results — including
 * failures — into a consolidated outcome report. Wired into
 * dagUtils.checkObjectiveCompletion (see plan §4.3); this module itself is
 * side-effect-free apart from reading the team instance's shared context
 * and the team manifest (both read-only DB lookups) and the outbound
 * collector call.
 *
 * Pattern lifted from goalEvaluator.js / decomposer.js's collector call
 * (same endpoint, same auth, same envelope shape) so behaviour stays
 * consistent with the rest of the objectives machinery.
 *
 * Contract:
 *   runCoordinatorStep(objective, tasks, opts)
 *     → { success: true, summary: string } | { success: false, summary: null, reason: string }
 *   NEVER throws — a synthesis failure/timeout is always non-fatal to
 *   objective finalisation (the caller in dagUtils.js proceeds unchanged).
 */

import { getTeamContext, getTeamDefinition, buildTeamContextBlock } from './teamLoader.js'
import { canExecuteResource, recordResourceFailure, recordResourceSuccess, CircuitBreakerOpenError } from './resourceBreaker.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const DEFAULT_TIMEOUT_MS = 120_000

const COORDINATOR_INSTRUCTION = 'You are the team orchestrator. Synthesise the members\' ' +
  'results into a single consolidated outcome report: what was achieved, what failed and ' +
  'why, contradictions between member results, and concrete recommended follow-ups. Be ' +
  'specific; cite member results.'

/**
 * Format all terminal member-task results (completed, failed, AND skipped)
 * into a prompt-ready block. Deliberately broader than
 * dagUtils.buildDependencyResultsBlock (which only surfaces completed
 * dependencies with a result) — failures are exactly what a coordinator
 * must address, so they must not be silently omitted here.
 *
 * @param {Array<{id, title, agent_id, status, result}>} tasks
 * @param {object} [opts]
 * @param {number} [opts.maxResultLength=1500]
 * @returns {string} block, or '' when there are no terminal tasks
 */
function buildMemberResultsBlock(tasks, opts = {}) {
  const maxResultLength = opts.maxResultLength ?? 1500
  if (!Array.isArray(tasks) || tasks.length === 0) return ''

  const terminal = tasks.filter(t => t && ['completed', 'failed', 'skipped'].includes(t.status))
  if (terminal.length === 0) return ''

  const sections = terminal.map(t => {
    const result = String(t.result || '(no result recorded)')
    const truncated = result.length > maxResultLength
      ? `${result.slice(0, maxResultLength)}... [truncated]`
      : result
    return `### ${t.title} (${t.agent_id}) — ${t.status}\n${truncated}`
  })

  return `\n\n## Member task results\n\n${sections.join('\n\n')}`
}

/**
 * Build the coordinator synthesis prompt. Pure function — no DB, no
 * network — so unit-testable in isolation.
 *
 * @param {object} objective - objectives row (title, description, goal_condition)
 * @param {Array} tasks - all task rows for the objective (terminal member tasks)
 * @param {object|null} teamContext - team_instances.shared_context_json (parsed),
 *   as returned by teamLoader.getTeamContext()
 * @returns {string}
 */
export function buildCoordinatorPrompt(objective, tasks, teamContext) {
  const header = [
    `# Objective`,
    `Title: ${objective.title}`,
    objective.description ? `Description: ${objective.description}` : null,
    objective.goal_condition ? `Goal condition: ${objective.goal_condition}` : null,
  ].filter(Boolean).join('\n')

  const membersBlock = buildMemberResultsBlock(tasks)
  const history = Array.isArray(teamContext?.task_history) ? teamContext.task_history : []
  const contextBlock = buildTeamContextBlock(history)

  return `${header}${membersBlock}${contextBlock}\n\n${COORDINATOR_INSTRUCTION}`
}

/**
 * Run the coordinator synthesis step: build the prompt, invoke the team's
 * orchestrator agent (no_tools — pure reasoning, mirrors the decomposer/
 * goal-evaluator rationale), and return the synthesised summary.
 *
 * Same call shape as decomposer.js's collector invoke: POST
 * `${collectorUrl}/api/internal/agents/invoke` with the service-key header
 * and org_id/user_id carried in the JSON body (the collector route reads
 * org_id/user_id from req.body, not from a header — verified at
 * services/collector/server.js:5625-5663; there is no X-Org-Id header on
 * this internal call path).
 *
 * @param {object} objective - objectives row
 * @param {Array} tasks - all task rows for the objective
 * @param {object} [opts]
 * @param {string} [opts.collectorUrl]
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Promise<{success: boolean, summary: string|null, reason?: string}>}
 */
export async function runCoordinatorStep(objective, tasks, opts = {}) {
  try {
    const collectorUrl = opts.collectorUrl || COLLECTOR_URL
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS

    // QM-7 wiring: an OPEN llm breaker refuses fast, before the network is
    // touched. A refusal is NOT itself recorded as a failure — see
    // goalEvaluator.js's identical comment for why.
    if (!canExecuteResource('llm')) {
      const err = new CircuitBreakerOpenError('llm')
      console.warn(`[CoordinatorStep] ${err.message}`)
      return { success: false, summary: null, reason: err.message }
    }

    let teamContext = null
    try {
      if (objective.team_instance_id) teamContext = getTeamContext(objective.team_instance_id)
    } catch (err) {
      console.warn('[Tasks][WI-C] Failed to load team context for coordinator prompt:', err.message)
    }

    let manifest = null
    try {
      if (objective.team_id && objective.org_id) {
        const teamDef = getTeamDefinition(objective.org_id, objective.team_id)
        if (teamDef) manifest = teamDef.manifest
      }
    } catch (err) {
      console.warn('[Tasks][WI-C] Failed to load team manifest for coordinator agent:', err.message)
    }

    const agentId = objective.orchestrator_agent_id || manifest?.orchestrator?.agentId || 'quox'
    const prompt = buildCoordinatorPrompt(objective, tasks, teamContext)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await fetch(`${collectorUrl}/api/internal/agents/invoke`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Quox-Source': 'task-service',
          ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
        },
        body: JSON.stringify({
          agent_id: agentId,
          task: prompt,
          org_id: objective.org_id,
          user_id: objective.user_id,
          no_tools: true,
          max_duration_ms: timeoutMs,
          context: {
            source: 'task-service',
            purpose: 'coordinator_synthesis',
            objective_id: objective.id,
            team_id: objective.team_id || null,
            team_instance_id: objective.team_instance_id || null,
          },
        }),
      })
    } catch (err) {
      recordResourceFailure('llm')
      return { success: false, summary: null, reason: `Coordinator fetch failed: ${err && err.message ? err.message : String(err)}` }
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      recordResourceFailure('llm')
      return { success: false, summary: null, reason: `Coordinator HTTP ${res.status}` }
    }

    let body
    try {
      body = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text())
    } catch (err) {
      return { success: false, summary: null, reason: `Coordinator response not JSON: ${err.message}` }
    }

    if (body && body.success === false) {
      recordResourceFailure('llm')
      const errMsg = body.error || body.result || 'collector invocation failed'
      return { success: false, summary: null, reason: `Coordinator: ${errMsg}` }
    }

    // The collector/LLM call itself succeeded — an empty-summary check
    // below is a content-quality issue, not a resource failure.
    recordResourceSuccess('llm')

    const summary = (body && (body.result || body.response || body.text || body.content)) || ''
    if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
      return { success: false, summary: null, reason: 'Coordinator returned an empty summary' }
    }

    return { success: true, summary: summary.trim() }
  } catch (err) {
    // Belt-and-braces — runCoordinatorStep must NEVER throw.
    return { success: false, summary: null, reason: `Coordinator step threw: ${err && err.message ? err.message : String(err)}` }
  }
}
