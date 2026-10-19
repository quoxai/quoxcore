/**
 * DAG Utilities — extracted from executor.js (QE2 Phase 6)
 *
 * Pure functions for building DAG visualizations from task arrays.
 * These are used by the API layer for objective detail views.
 */

import { getDatabase } from '../db/index.js'
import { ulid } from 'ulid'
import { emitProgress } from './progress.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { updateTeamInstanceStatus, getTeamDefinition, appendTaskSummary } from './teamLoader.js'
import { notifyScheduledCompletion } from './teamScheduler.js'
import { recordOutcome as recordObjectiveOutcome } from './wisdomStore.js'
import { recordCleanCompletion, resolveTaskClass } from './agentStanding.js'
import { reflectOnOutcome } from './dreamCycle.js'
import { evaluateGoal } from './goalEvaluator.js'
import { getExitPredicate, evaluateExitPredicate } from './exitPredicate.js'
import { checkBudget } from './budget.js'
import { runCoordinatorStep } from './coordinatorStep.js'
import { observeCompletedRun } from './learningObserver.js'
import { buildLearningRun, emitLearningCandidate } from './learningSink.js'

// MACH-FOLLOWUP WI-C: sentinel value used to atomically claim the
// coordinator-step slot on an objective (see checkObjectiveCompletion).
// Never persisted long-term — overwritten with the real summary on
// success, or reset to NULL on failure/timeout.
const COORDINATOR_PENDING_MARKER = '__coordinator_pending__'

/**
 * Build a DAG visualization from task records.
 *
 * @param {Array} tasks - Array of task rows from DB
 * @returns {{ nodes: Array<{id, title, status, agent_id, priority}>, edges: Array<{from, to}> }}
 */
export function computeDAG(tasks) {
  const nodes = tasks.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    agent_id: t.agent_id,
    priority: t.priority || 0,
  }))

  const edges = []
  for (const task of tasks) {
    const deps = JSON.parse(task.depends_on || '[]')
    for (const depId of deps) {
      edges.push({ from: depId, to: task.id })
    }
  }

  return { nodes, edges }
}

/**
 * MACHINERY-4b — structured dependency hand-off.
 *
 * Replaces the old prose convention ("assume it will receive results")
 * with an actual structured block of upstream task results, built from
 * the dependency tasks' stored DB rows at dispatch time. Only completed
 * dependencies with a non-empty result contribute a section — pending/
 * failed/skipped dependencies are silently omitted (their absence is
 * informative on its own; there is nothing meaningful to hand off yet).
 *
 * Pure function — no DB access — so the caller (objectiveDispatch) is
 * responsible for fetching the dependency task rows first.
 *
 * @param {Array<{id, title, agent_id, status, result}>} depTasks - the
 *   task rows this task depends on (already resolved from depends_on ids)
 * @param {Object} [opts]
 * @param {number} [opts.maxResultLength=1500] - per-result truncation cap
 * @returns {string} block to append to the dependent task's prompt, or ''
 *   when there are no completed dependency results to hand off
 */
export function buildDependencyResultsBlock(depTasks, opts = {}) {
  const maxResultLength = opts.maxResultLength ?? 1500
  if (!Array.isArray(depTasks) || depTasks.length === 0) return ''

  const sections = depTasks
    .filter(t => t && t.status === 'completed' && t.result)
    .map(t => {
      const result = String(t.result)
      const truncated = result.length > maxResultLength
        ? `${result.slice(0, maxResultLength)}... [truncated]`
        : result
      return `### ${t.title} (${t.agent_id})\n${truncated}`
    })

  if (sections.length === 0) return ''
  return `\n\n## Results from prerequisite tasks\n\n${sections.join('\n\n')}`
}

/**
 * STUDY-REV R3.3 — pure decision helper for the re-observe loop.
 *
 * Given the candidate "this round is done" snapshot, decide whether to
 * finalise the objective or re-decompose for another iteration. Pure
 * function — no DB, no network — so the decision logic is unit-testable
 * in isolation. Called by checkObjectiveCompletion which then performs
 * the side effects.
 *
 * Returns one of:
 *   { decision: 'finalise', reason }
 *   { decision: 'evaluate' }    // caller should call evaluateGoal then re-decide
 *
 * (After 'evaluate', the caller calls this again with eval={met,reason}
 *  filled in, and gets either 'finalise' or 'reObserve'.)
 */
export function shouldReObserve(objective, candidateStatus, eval_, opts = {}) {
  // Only consider re-observation when the round looks successful. A
  // partially-failed objective should not loop — the user needs to see it.
  if (candidateStatus !== 'completed') {
    return { decision: 'finalise', reason: `candidate status ${candidateStatus}, not eligible` }
  }
  // No goal_condition means caller never opted into the loop.
  const goal = (objective.goal_condition || '').toString().trim()
  if (goal.length === 0) {
    return { decision: 'finalise', reason: 'no goal_condition set' }
  }
  // Iteration cap.
  const used = Number(objective.iteration_count) || 0
  const max = Number(objective.max_iterations) || 5
  if (used >= max) {
    return { decision: 'finalise', reason: `max_iterations reached (${used}/${max})` }
  }
  // Budget check — re-using existing checker so token/call/duration limits
  // stop the loop the same way they stop a runaway decomposition.
  const budgetOk = opts.skipBudget ? { ok: true } : checkBudget(objective)
  if (!budgetOk.ok) {
    return { decision: 'finalise', reason: `budget exhausted: ${budgetOk.reason || 'see budget.js'}` }
  }
  // No eval yet — caller must run evaluateGoal and re-call us.
  if (!eval_ || typeof eval_.met !== 'boolean') {
    return { decision: 'evaluate' }
  }
  // Eval result decides.
  if (eval_.met) {
    return { decision: 'finalise', reason: `goal met: ${eval_.reason}` }
  }
  return {
    decision: 'reObserve',
    reason: `goal not met after iteration ${used + 1}: ${eval_.reason}`,
    suggestedNextTasks: eval_.suggestedNextTasks,
  }
}

/**
 * Check if all tasks for an objective are done and finalize the objective.
 * Called when QuoxFlow reports execution completion (or from legacy paths).
 *
 * Handles: status update, VOLT bundle, QuoxMind recording, team instance
 * finalization, schedule tracking, AEE envelope emission.
 *
 * STUDY-REV R3.3: when the objective has goal_condition set and the
 * candidate status would be 'completed', the goal evaluator runs first.
 * If it returns met=false and budget+iteration cap allow another round,
 * the objective is re-decomposed and stays in 'decomposed' status — the
 * normal approve/start UX picks up from there. The function is now async
 * because of the LLM call to the evaluator; the only call site
 * (quoxflowBridge.pollExecutionStatus) was already fire-and-forget.
 */
export async function checkObjectiveCompletion(objectiveId, opts = {}) {
  const db = getDatabase()

  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (!objective || objective.status !== 'running') return false

  const tasks = db.prepare('SELECT * FROM tasks WHERE objective_id = ?').all(objectiveId)

  // Skip pending tasks whose dependencies can never be fully met
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    const deps = JSON.parse(task.depends_on || '[]')
    if (deps.length === 0) continue
    const hasBlockedDep = deps.some(depId => {
      const dep = tasks.find(t => t.id === depId)
      return dep && (dep.status === 'failed' || dep.status === 'skipped')
    })
    if (hasBlockedDep) {
      db.prepare(`
        UPDATE tasks SET status = 'skipped', result = 'Dependencies failed', completed_at = datetime('now')
        WHERE id = ?
      `).run(task.id)
      task.status = 'skipped'
      emitProgress(objectiveId, { type: 'task_skipped', task_id: task.id, title: task.title, reason: 'Dependencies failed' })
    }
  }

  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped')
  if (!allDone) {
    const pending = tasks.filter(t => !['completed', 'failed', 'skipped'].includes(t.status))
    console.debug(`[Tasks] Objective ${objectiveId}: ${pending.length} task(s) still pending: ${pending.map(t => `${t.id}:${t.status}`).join(', ')}`)
    return false
  }

  const anyFailed = tasks.some(t => t.status === 'failed')
  const anyCompleted = tasks.some(t => t.status === 'completed')
  const allSkipped = tasks.every(t => t.status === 'skipped')
  const newStatus = allSkipped ? 'failed'
    : anyFailed ? 'completed_with_errors'
    : 'completed'

  // STUDY-REV R3.3: re-observe loop. If goal_condition is set and we
  // would otherwise be marking this 'completed', consult the goal
  // evaluator. If the goal is not yet met (and iteration/budget allow),
  // append more tasks via decomposeObjective and bounce status back to
  // 'decomposed'. The user's existing approve/start UX picks up from
  // there. If the goal IS met, we just record the eval log and finalise
  // normally.
  const preEval = shouldReObserve(objective, newStatus, undefined)
  if (preEval.decision === 'evaluate') {
    const completedTasks = tasks.filter(t => t.status === 'completed')
    let evalResult
    try {
      // QLOOP-ENGINE P1: a configured exit predicate (external observable)
      // decides; the LLM evaluator is its kind=llm fallback and the default
      // when no predicate is configured.
      evalResult = getExitPredicate(objective)
        ? await evaluateExitPredicate(objective, completedTasks, opts.exitPredicateDeps || {})
        : await evaluateGoal(objective, completedTasks)
    } catch (err) {
      console.warn('[Tasks][R3] Goal evaluator threw:', err.message)
      evalResult = { met: false, reason: `evaluator threw: ${err.message}` }
    }

    // Persist the evaluation event regardless of outcome — this is the
    // audit trail the UI shows the user.
    const logEntry = {
      iteration: (objective.iteration_count || 0) + 1,
      met: evalResult.met,
      reason: evalResult.reason,
      ts: new Date().toISOString(),
    }
    let log
    try { log = JSON.parse(objective.goal_evaluation_log || '[]') } catch { log = [] }
    if (!Array.isArray(log)) log = []
    log.push(logEntry)
    db.prepare('UPDATE objectives SET goal_evaluation_log = ? WHERE id = ?')
      .run(JSON.stringify(log), objectiveId)

    const decision = shouldReObserve(objective, newStatus, evalResult)
    if (decision.decision === 'reObserve') {
      // Increment iteration counter and bounce status to 'decomposed' so
      // the normal flow re-engages. Pass eval reason + suggested tasks
      // through plan_feedback so the decomposer LLM has actionable
      // context for the next round.
      const nextIter = (objective.iteration_count || 0) + 1
      const feedback = [
        `Iteration ${nextIter} — previous round did not satisfy the goal.`,
        `Goal: ${objective.goal_condition}`,
        `Evaluator reason: ${evalResult.reason}`,
        decision.suggestedNextTasks ? `Suggested next tasks: ${decision.suggestedNextTasks}` : null,
      ].filter(Boolean).join('\n')

      db.prepare(`
        UPDATE objectives
        SET iteration_count = ?, status = 'decomposed', plan_feedback = ?
        WHERE id = ?
      `).run(nextIter, feedback, objectiveId)

      emitProgress(objectiveId, {
        type: 'objective_re_observed',
        iteration: nextIter,
        max_iterations: objective.max_iterations,
        reason: evalResult.reason,
      })

      // Fire-and-forget re-decomposition — the decomposer reads
      // plan_feedback and adds new tasks to the same objective. We
      // don't await: another caller will pick the objective up via the
      // existing approve/start UX.
      void (async () => {
        try {
          const { decomposeObjective } = await import('./decomposer.js')
          const refreshed = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
          if (refreshed) await decomposeObjective(refreshed)
        } catch (err) {
          console.warn('[Tasks][R3] Re-decomposition failed:', err.message)
        }
      })()

      return false  // Not finalised — loop continues.
    }
    // decision.decision === 'finalise' — fall through and finalise normally.
  }

  // QM-1 + QM-2 + QMH-4d: Record outcome and run reflection. Reflection on
  // success is gated to quoxmind-complete; post-mortem reflection on
  // failure runs for all tiers. The async call is intentionally not
  // awaited — reflection is best-effort and must not block the rest of
  // the completion path (VOLT bundle, team finalisation, AEE emit).
  try {
    const outcome = recordObjectiveOutcome({ ...objective, status: newStatus }, tasks)
    if (outcome) {
      const outcomeRecord = db.prepare('SELECT * FROM objective_outcomes WHERE objective_id = ?').get(objectiveId)
      if (outcomeRecord) {
        void reflectOnOutcome(objective.org_id, objectiveId, outcomeRecord)
      }
    }
  } catch (err) {
    console.warn('[QuoxMind] Outcome/analysis failed (non-fatal):', err.message)
  }

  // Agent Standing — clean_completion event source. One event per task
  // that finished 'completed' (not 'failed'/'skipped') within this
  // objective, regardless of the objective's overall newStatus (a
  // completed_with_errors objective can still contain individually clean
  // task completions from agents that did their job correctly). Non-fatal
  // and best-effort, same posture as the outcome/analysis block above —
  // Standing bookkeeping must never block objective finalisation.
  try {
    for (const t of tasks) {
      if (t.status !== 'completed') continue
      const taskClass = resolveTaskClass(db, t.id)
      recordCleanCompletion(objective.org_id, t.agent_id, taskClass, {
        taskId: t.id,
        objectiveId,
        actor: 'system:objective_outcome',
        reason: `objective ${objectiveId} finalised ${newStatus}`,
      })
    }
  } catch (err) {
    console.warn('[AgentStanding] Clean-completion recording failed (non-fatal):', err.message)
  }

  // MACH-FOLLOWUP WI-C: teams coordinator synthesis step (MACHINERY item
  // 4(c)). Runs once per team-objective finalisation, before the VOLT
  // bundle write, so the OBJECTIVE_COMPLETED envelope/SSE below can carry
  // the synthesis. Gate: team objective (team_instance_id set), >=2
  // terminal tasks (guaranteed true here — allDone already required every
  // task to be completed/failed/skipped), and the team manifest's
  // policies.coordinatorStep !== false (default ON). Non-fatal on any
  // failure/timeout — finalisation is never blocked by the coordinator call.
  //
  // Double-entry guard: the poller can call checkObjectiveCompletion
  // repeatedly/concurrently while the objective is still 'running' (the
  // status flip happens further below). A single atomic
  // `UPDATE ... WHERE coordinator_summary IS NULL` claims the coordinator
  // slot BEFORE the slow, awaited LLM call — only the caller whose UPDATE
  // affects a row proceeds; a losing concurrent call sees changes === 0
  // and skips, guaranteeing at most one coordinator invocation per
  // objective.
  let coordinatorSummary = null
  if (objective.team_instance_id && tasks.length >= 2) {
    let teamManifest = null
    try {
      if (objective.team_id && objective.org_id) {
        const teamDef = getTeamDefinition(objective.org_id, objective.team_id)
        if (teamDef) teamManifest = teamDef.manifest
      }
    } catch (err) {
      console.warn('[Tasks][WI-C] Failed to load team manifest for coordinator gate:', err.message)
    }
    const coordinatorEnabled = teamManifest?.policies?.coordinatorStep !== false

    if (coordinatorEnabled) {
      const claim = db.prepare(`
        UPDATE objectives SET coordinator_summary = ?
        WHERE id = ? AND coordinator_summary IS NULL
      `).run(COORDINATOR_PENDING_MARKER, objectiveId)

      if (claim.changes === 1) {
        const orchestratorId = objective.orchestrator_agent_id || teamManifest?.orchestrator?.agentId || 'quox'
        const result = await runCoordinatorStep(objective, tasks, {})

        if (result.success) {
          coordinatorSummary = result.summary
          db.prepare('UPDATE objectives SET coordinator_summary = ? WHERE id = ?')
            .run(coordinatorSummary, objectiveId)
          appendTaskSummary(objective.team_instance_id, {
            task_id: 'coordinator',
            role: orchestratorId,
            status: 'completed',
            result_summary: coordinatorSummary.slice(0, 500),
            completed_at: new Date().toISOString(),
          })
          db.prepare(`
            INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
            VALUES (?, ?, 'info', 'coordinator_step', ?, datetime('now'))
          `).run(ulid(), objectiveId, `Coordinator synthesis complete (${coordinatorSummary.length} chars)`)
        } else {
          // Reset the pending marker so the column honestly reflects
          // "never measured" rather than a stuck sentinel; finalisation
          // proceeds unchanged.
          db.prepare(`
            UPDATE objectives SET coordinator_summary = NULL
            WHERE id = ? AND coordinator_summary = ?
          `).run(objectiveId, COORDINATOR_PENDING_MARKER)
          db.prepare(`
            INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
            VALUES (?, ?, 'warn', 'coordinator_step', ?, datetime('now'))
          `).run(ulid(), objectiveId, `Coordinator synthesis failed (non-fatal): ${result.reason || 'unknown reason'}`)
        }
      }
    }
  }

  // VOLT bundle
  const bundleId = `VOLT_${ulid()}`
  db.prepare(`
    UPDATE objectives SET status = ?, completed_at = datetime('now'), volt_bundle_id = ?
    WHERE id = ?
  `).run(newStatus, bundleId, objectiveId)

  emitProgress(objectiveId, { type: 'volt_bundle_created', bundle_id: bundleId })

  // Team instance finalization
  if (objective.team_instance_id) {
    const teamStatus = anyFailed ? 'error' : 'completed'
    updateTeamInstanceStatus(objective.team_instance_id, teamStatus)
  }

  db.prepare(`
    INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
    VALUES (?, ?, 'info', 'objective_completed', ?, datetime('now'))
  `).run(ulid(), objectiveId, `Objective ${newStatus}`)

  // AEE envelope
  const taskSummary = tasks.map(t => ({
    id: t.id, title: t.title, agent_id: t.agent_id, status: t.status,
    duration_ms: t.duration_ms || undefined,
    tokens_used: t.tokens_used || undefined,
  }))
  const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens_used || 0), 0)
  const totalDuration = tasks.reduce((sum, t) => sum + (t.duration_ms || 0), 0)
  const tasksCompleted = tasks.filter(t => t.status === 'completed').length
  const tasksFailed = tasks.filter(t => t.status === 'failed').length
  const tasksSkipped = tasks.filter(t => t.status === 'skipped').length

  // Update objective counters with real values
  db.prepare('UPDATE objectives SET tasks_completed = ?, tasks_failed = ? WHERE id = ?')
    .run(tasksCompleted, tasksFailed, objectiveId)

  createTaskEnvelope({
    type: 'event', from: 'service.tasks', to: 'system',
    intent: anyFailed ? TASK_INTENTS.OBJECTIVE_FAILED : TASK_INTENTS.OBJECTIVE_COMPLETED,
    payload: {
      objective_id: objectiveId,
      objective_title: objective.title,
      status: newStatus,
      tasks_completed: tasksCompleted,
      tasks_failed: tasksFailed,
      tasks_skipped: tasksSkipped,
      task_count: tasks.length,
      total_tokens: totalTokens,
      total_duration_ms: totalDuration,
      tasks: taskSummary,
      volt_bundle_id: bundleId,
      team_id: objective.team_id || undefined,
      coordinator_summary: coordinatorSummary ? coordinatorSummary.slice(0, 2000) : undefined,
    },
    corrId: objective.corr_id, objectiveId,
  })

  emitProgress(objectiveId, {
    type: 'objective_completed',
    status: newStatus,
    tasks_completed: tasksCompleted,
    tasks_failed: tasksFailed,
    team_instance_id: objective.team_instance_id || null,
    coordinator_summary: coordinatorSummary ? coordinatorSummary.slice(0, 2000) : undefined,
  })

  // Schedule completion tracking
  if (objective.triggered_by === 'schedule' && objective.schedule_id) {
    try {
      if (anyFailed) {
        db.prepare(`
          UPDATE team_schedules SET consecutive_failures = consecutive_failures + 1, last_status = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(newStatus, objective.schedule_id)

        const sched = db.prepare('SELECT consecutive_failures, max_consecutive_failures FROM team_schedules WHERE id = ?').get(objective.schedule_id)
        if (sched && sched.consecutive_failures >= sched.max_consecutive_failures) {
          db.prepare("UPDATE team_schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(objective.schedule_id)
          console.warn(`[Tasks] Auto-disabled schedule ${objective.schedule_id} after ${sched.consecutive_failures} consecutive failures`)
        }
      } else {
        db.prepare(`
          UPDATE team_schedules SET consecutive_failures = 0, last_status = 'completed', updated_at = datetime('now')
          WHERE id = ?
        `).run(objective.schedule_id)
      }

      notifyScheduledCompletion(objective, newStatus).catch(() => {})
    } catch (schedErr) {
      console.error(`[Tasks] Schedule tracking error: ${schedErr.message}`)
    }
  }

  // QLOOP-ENGINE P3 (step a): read-only learning observer. Flag-gated OFF by
  // default (observeCompletedRun no-ops unless LEARNING_OBSERVER=1) and fires
  // only on a clean 'completed' that is witnessed (bundleId). Best-effort:
  // the learning layer must never affect objective finalisation.
  try {
    observeCompletedRun(
      buildLearningRun({ kind: 'objective', objective, tasks, status: newStatus, witnessedRef: bundleId, tokensUsed: totalTokens }),
      { emit: emitLearningCandidate },
    )
  } catch (err) {
    console.warn('[LearningObserver] objective observe failed (non-fatal):', err.message)
  }

  return true
}
