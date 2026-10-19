/**
 * Exit predicate - QLOOP-ENGINE P1.
 *
 * A server-evaluated "is this objective done" check bound to an EXTERNAL
 * observable, never to the model transcript. Stored at
 * objective.metadata.exit_predicate and evaluated by:
 *   - loopDispatch.consumeLoopEvents (loop mode): per turn for the cheap
 *     kinds, and at the result event for every kind;
 *   - dagUtils.checkObjectiveCompletion (dag mode): in the re-observe path.
 *
 * Kinds:
 *   http    { url, expect_status?=200, body_contains? }  poll a URL (egress-guarded)
 *   tool    { tool, input?, expect:{path, equals|contains|exists} }  governed tool call, test its result
 *   assert  { tool, input? }  governed tool call that passes on success && exit_code 0 (e.g. ssh_exec)
 *   llm     {}  fuzzy goal: delegate to goalEvaluator.evaluateGoal
 *
 * Tools run through the collector's governed /api/internal/tools/execute
 * path (RBAC, hat gate, WARD evidence), so this adds no ungoverned exec.
 * Fail-soft: any error is met=false with a reason (never throws).
 */

import { evaluateGoal } from './goalEvaluator.js'
import { assertSafeEgressUrl } from './egressGuard.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const KINDS = ['http', 'tool', 'assert', 'llm']
const TIMEOUT_MS = 15_000

export function validateExitPredicate(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'exit_predicate must be an object' }
  if (!KINDS.includes(p.kind)) return { ok: false, error: `exit_predicate.kind must be one of ${KINDS.join(', ')}` }
  if (p.kind === 'http' && (typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url))) {
    return { ok: false, error: 'exit_predicate.url must be an http(s) URL' }
  }
  if ((p.kind === 'tool' || p.kind === 'assert') && (typeof p.tool !== 'string' || p.tool.length === 0)) {
    return { ok: false, error: `exit_predicate.tool is required for kind ${p.kind}` }
  }
  return { ok: true }
}

/** The valid predicate on an objective row (metadata JSON string or object), else null. */
export function getExitPredicate(objective) {
  let meta = objective && objective.metadata
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { return null }
  }
  const p = meta && meta.exit_predicate
  return validateExitPredicate(p).ok ? p : null
}

/** llm is expensive and unbounded in cost per call: only checked at result/round end. */
export function isCheapPredicate(p) {
  return !!p && p.kind !== 'llm'
}

/**
 * QLOOP-ENGINE: the default-path guard flag. When on, a loop created with only
 * a plain `goal_condition` (and no structured metadata.exit_predicate) is given
 * an IMPLICIT llm exit predicate, so the model saying "done" is still checked by
 * the server-side goal judge instead of being trusted outright. Default OFF: a
 * behaviour change to existing loops ships dark until it is proven on a real
 * task and the owner flips it. Instance flag, registered in envRegistry.cjs.
 */
export function implicitGoalExitEnabled(env = process.env) {
  return (env && env.QLOOP_GOAL_CONDITION_EXIT) === '1'
}

/**
 * The predicate a loop should actually evaluate against: the explicit
 * metadata.exit_predicate if present (always wins); otherwise, only when
 * `implicitGoalExit` is on and the objective carries a non-empty goal_condition,
 * a synthetic `{ kind: 'llm' }` so the default goal_condition path is
 * server-checked too. Returns null when neither applies (behaviour unchanged).
 * The implicit predicate is llm-kind, so isCheapPredicate() is false and it is
 * only evaluated at the result event, never per turn.
 */
export function getEffectiveExitPredicate(objective, { implicitGoalExit = false } = {}) {
  const explicit = getExitPredicate(objective)
  if (explicit) return explicit
  if (implicitGoalExit && objective && typeof objective.goal_condition === 'string' && objective.goal_condition.trim()) {
    return { kind: 'llm', implicit: true }
  }
  return null
}

function getPath(obj, path) {
  if (!path) return obj
  return String(path).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj)
}

async function defaultToolFn(objective, tool, input) {
  const res = await fetch(`${COLLECTOR_URL}/api/internal/tools/execute`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-Quox-Source': 'task-service',
      ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
    },
    body: JSON.stringify({
      tool,
      input: { ...(input || {}), org_id: objective.org_id },
      agent_id: objective.orchestrator_agent_id || 'quox',
    }),
  })
  if (!res.ok) throw new Error(`tool ${tool} HTTP ${res.status}`)
  return res.json()
}

function testExpect(result, expect_) {
  if (!expect_ || typeof expect_ !== 'object') return { met: result && result.success !== false, reason: 'tool succeeded' }
  const v = getPath(result, expect_.path)
  if ('equals' in expect_) {
    const met = v === expect_.equals
    return { met, reason: `${expect_.path || 'result'} ${met ? '==' : '!='} ${JSON.stringify(expect_.equals)} (got ${JSON.stringify(v)})` }
  }
  if ('contains' in expect_) {
    const met = v != null && String(typeof v === 'object' ? JSON.stringify(v) : v).includes(String(expect_.contains))
    return { met, reason: `${expect_.path || 'result'} ${met ? 'contains' : 'does not contain'} ${JSON.stringify(expect_.contains)}` }
  }
  const met = v !== undefined && v !== null && v !== false
  return { met, reason: `${expect_.path || 'result'} ${met ? 'is present' : 'is absent'}` }
}

/**
 * @returns {Promise<{met:boolean, reason:string, kind:string|null}>}
 * deps (test seams): fetchFn, egressGuardFn, toolFn(objective, tool, input), evaluateGoalFn
 */
export async function evaluateExitPredicate(objective, completedTasks = [], deps = {}) {
  // deps.predicate lets the caller supply the effective predicate (e.g. the
  // loop's implicit goal-condition llm predicate); default to the explicit one.
  const p = deps.predicate || getExitPredicate(objective)
  if (!p) return { met: false, reason: 'no valid exit_predicate', kind: null }
  const kind = p.kind
  try {
    if (kind === 'llm') {
      const r = await (deps.evaluateGoalFn || evaluateGoal)(objective, completedTasks)
      return { met: !!r.met, reason: r.reason, kind, ...(r.suggestedNextTasks ? { suggestedNextTasks: r.suggestedNextTasks } : {}) }
    }
    if (kind === 'http') {
      await (deps.egressGuardFn || assertSafeEgressUrl)(p.url)
      const res = await (deps.fetchFn || fetch)(p.url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' })
      const want = Number(p.expect_status) || 200
      if (res.status !== want) return { met: false, reason: `http ${res.status}, wanted ${want}`, kind }
      if (p.body_contains) {
        const text = await res.text()
        if (!text.includes(String(p.body_contains))) return { met: false, reason: `http ${res.status} but body lacks ${JSON.stringify(p.body_contains)}`, kind }
      }
      return { met: true, reason: `http ${res.status} as expected`, kind }
    }
    const result = await (deps.toolFn || ((tool, input) => defaultToolFn(objective, tool, input)))(p.tool, p.input || {}, objective)
    if (!result || result.success === false) return { met: false, reason: `tool ${p.tool} failed${result && result.error ? `: ${result.error}` : ''}`, kind }
    if (kind === 'assert') {
      const code = result.exit_code ?? result.exitCode ?? result.code
      const met = code === undefined ? true : Number(code) === 0
      return { met, reason: `assert ${p.tool} exit_code ${code === undefined ? '(none, success)' : code}`, kind }
    }
    const t = testExpect(result, p.expect)
    return { met: !!t.met, reason: t.reason, kind }
  } catch (err) {
    return { met: false, reason: `${kind} predicate error: ${err && err.message ? err.message : String(err)}`, kind }
  }
}
