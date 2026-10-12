/**
 * Goal Evaluator — STUDY-REV R3.2.
 *
 * Asks the collector LLM whether an objective's goal_condition is met,
 * given the completed tasks so far. Wired into checkObjectiveCompletion()
 * by R3.3 to drive the re-observe loop.
 *
 * Contract:
 *   evaluateGoal(objective, completedTasks)
 *     → { met: boolean, reason: string, suggestedNextTasks?: string }
 *
 * Fail-soft: any LLM/network/parse error returns met=false with a
 * descriptive reason. The caller (re-observe loop) treats met=false as
 * "consume an iteration and decompose more tasks" — so a bad evaluator
 * call costs one cycle but doesn't lose the objective. The user sees the
 * reason in goal_evaluation_log.
 *
 * Pattern lifted from decomposer.js's collector call (same endpoint,
 * same auth, same envelope shape) so behaviour stays consistent.
 */

import { canExecuteResource, recordResourceFailure, recordResourceSuccess, CircuitBreakerOpenError } from './resourceBreaker.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const DEFAULT_TIMEOUT_MS = 30_000
// "QUOX" is the orchestrator agent the existing decomposer talks to; the
// evaluator is a similar pure-reasoning call, so re-use it.
const EVALUATOR_AGENT_ID = process.env.GOAL_EVALUATOR_AGENT_ID || 'quox'

function summariseTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return '(no completed tasks yet)'
  return tasks.map((t, i) => {
    const idx = i + 1
    const title = t.title || t.id || 'task'
    const status = t.status || 'unknown'
    const result = (t.result || t.result_structured || t.output || '').toString().slice(0, 400)
    return `${idx}. [${status}] ${title}${result ? `\n   → ${result}` : ''}`
  }).join('\n')
}

function buildPrompt(objective, completedTasks) {
  return [
    `You are evaluating whether an objective has been met based on completed tasks.`,
    ``,
    `# Objective`,
    `Title: ${objective.title}`,
    objective.description ? `Description: ${objective.description}` : null,
    ``,
    `# Goal condition (the SUCCESS criterion to evaluate)`,
    objective.goal_condition,
    ``,
    `# Completed tasks so far`,
    summariseTasks(completedTasks),
    ``,
    `# Your job`,
    `Decide whether the goal condition is fully satisfied by the completed tasks.`,
    `Reply with ONE single-line JSON object — no prose, no code fences, no extra fields:`,
    `{"met": true|false, "reason": "<one sentence>", "suggested_next_tasks": "<optional: comma-separated task descriptions if NOT met>"}`,
  ].filter(Boolean).join('\n')
}

function tryParse(raw) {
  if (typeof raw !== 'string') return null
  // Tolerate code-fenced answers — strip ```json ... ``` if present.
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  // Fast path: whole response is JSON.
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  // Slow path: extract the first {...} block.
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function normalise(parsed) {
  const met = parsed && typeof parsed.met === 'boolean' ? parsed.met : false
  const reason = parsed && typeof parsed.reason === 'string' && parsed.reason.length > 0
    ? parsed.reason
    : (met ? 'Goal evaluator returned met=true with no reason.' : 'Goal evaluator did not provide a reason.')
  const suggestedNextTasks = parsed && typeof parsed.suggested_next_tasks === 'string' && parsed.suggested_next_tasks.length > 0
    ? parsed.suggested_next_tasks
    : undefined
  return { met, reason, ...(suggestedNextTasks ? { suggestedNextTasks } : {}) }
}

/**
 * Evaluate whether an objective's goal_condition is met.
 *
 * @param {object} objective  Row from the objectives table. MUST have
 *                            goal_condition; throws TypeError otherwise.
 * @param {Array}  completedTasks  Task rows that have completed in the
 *                            current iteration. May be empty.
 * @param {object} [opts]     { timeoutMs, collectorUrl }
 * @returns {Promise<{ met: boolean, reason: string, suggestedNextTasks?: string }>}
 */
export async function evaluateGoal(objective, completedTasks, opts = {}) {
  if (!objective || typeof objective.goal_condition !== 'string' || objective.goal_condition.trim().length === 0) {
    throw new TypeError('evaluateGoal: objective.goal_condition is required (non-empty string)')
  }

  const collectorUrl = opts.collectorUrl || COLLECTOR_URL
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS

  // QM-7 wiring: an OPEN llm breaker refuses fast, before the network is
  // touched at all. A refusal is NOT itself recorded as a failure — doing
  // so would push lastFailure forward on every refused retry and the reset
  // window would never elapse.
  if (!canExecuteResource('llm')) {
    const err = new CircuitBreakerOpenError('llm')
    console.warn(`[GoalEvaluator] ${err.message}`)
    return { met: false, reason: err.message }
  }

  const prompt = buildPrompt(objective, completedTasks)

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
        agent_id: EVALUATOR_AGENT_ID,
        task: prompt,
        org_id: objective.org_id,
        user_id: objective.user_id,
        max_duration_ms: timeoutMs,
        no_tools: true,
        // REPLAY-ONLY .A0: org_id + objective_id are threaded (identity context).
        // workflow_id/execution_id are intentionally ABSENT here — goal
        // evaluation operates on the objective/task graph, not a quoxflow
        // workflow run. Do not fabricate one (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md
        // §5 .A0, §4 row 5).
        context: {
          source: 'task-service',
          purpose: 'goal_evaluation',
          objective_id: objective.id,
          team_id: objective.team_id || null,
          iteration: objective.iteration_count || 0,
        },
      }),
    })
  } catch (err) {
    recordResourceFailure('llm')
    return { met: false, reason: `Goal evaluator fetch failed: ${err && err.message ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    recordResourceFailure('llm')
    return { met: false, reason: `Goal evaluator HTTP ${res.status}` }
  }

  let body
  try {
    body = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text())
  } catch (err) {
    return { met: false, reason: `Goal evaluator response not JSON: ${err.message}` }
  }

  if (body && body.success === false) {
    recordResourceFailure('llm')
    const errMsg = body.error || body.result || 'collector invocation failed'
    return { met: false, reason: `Goal evaluator: ${errMsg}` }
  }

  // The collector/LLM call itself succeeded — a downstream parse failure
  // below (malformed "met" JSON) is a model-output quality issue, not a
  // resource failure, so it does not count against the breaker.
  recordResourceSuccess('llm')

  const responseText = (body && (body.result || body.response || body.text || body.content)) || ''
  const parsed = tryParse(responseText)
  if (!parsed || typeof parsed.met !== 'boolean') {
    return { met: false, reason: `Goal evaluator returned an invalid format (could not parse "met" field).` }
  }

  return normalise(parsed)
}
