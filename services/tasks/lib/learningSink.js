/**
 * Learning sink (QLOOP-ENGINE P3 step a, the wiring seam).
 *
 * The observer (learningObserver.js) is read-only and hands each candidate to
 * an injected `emit`. This module is that sink for the two live hook sites
 * (objective finalisation in dagUtils.checkObjectiveCompletion, loop
 * finalisation in loopDispatch.recordLoopOutcome).
 *
 * Step (a) is OBSERVE ONLY: a candidate is produced and logged at debug level,
 * nothing is persisted or authored. The detector + approval-gated draft
 * proposer (step b) will consume candidates HERE, unchanged upstream. Keeping
 * the seam in one place means wiring it into a third site later is one import.
 *
 * Everything is gated OFF by default upstream: observeCompletedRun returns null
 * unless LEARNING_OBSERVER=1, so with the flag off this sink is never called.
 */

/**
 * Map an objective/loop row (+ its tasks) to the shape observeCompletedRun
 * reads. Pure. The observer itself decides eligibility (success + witnessed);
 * this only names fields.
 *
 * @param {object} p
 * @param {'objective'|'loop'} p.kind
 * @param {object} p.objective  the objective row (id, org_id, goal_condition, title, ...)
 * @param {Array}  [p.tasks]    the objective's task rows (for the tool/shape signal)
 * @param {string} p.status     the terminal status being recorded
 * @param {string|null} p.witnessedRef  the VOLT bundle id (or null)
 * @param {number|null} [p.tokensUsed]  computed total tokens, when the caller has it
 */
export function buildLearningRun({ kind, objective, tasks = [], status, witnessedRef, tokensUsed } = {}) {
  const o = objective || {}
  const toolSeq = (Array.isArray(tasks) ? tasks : [])
    .map((t) => t && (t.agent_id || t.title))
    .filter(Boolean)
  return {
    id: o.id ?? null,
    org_id: o.org_id ?? null,
    kind: kind === 'loop' ? 'loop' : 'objective',
    status,
    goal: o.goal_condition || o.title || null,
    tool_sequence: toolSeq,
    tokens_used: tokensUsed != null ? tokensUsed : (o.tokens_used ?? null),
    tool_calls_used: o.tool_calls_used ?? (toolSeq.length || null),
    witnessed_ref: witnessedRef ?? o.volt_bundle_id ?? null,
  }
}

/**
 * The emit sink. Step (a): observe only. Best-effort, never throws, persists
 * nothing. Step (b) replaces the body with the detector hand-off.
 */
export function emitLearningCandidate(candidate) {
  try {
    if (candidate) console.debug(`[LearningObserver] candidate ${candidate.kind} ${candidate.run_id} shape=${candidate.shape}`)
  } catch { /* a log must never break finalisation */ }
  return candidate
}
