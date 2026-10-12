/**
 * Objective Dispatch — shared execution-kickoff path
 *
 * BUG FIX: agentScheduler (autonomous ACT decisions) and teamScheduler
 * (team auto-approve) both used to set an objective's status to
 * 'running' directly and stop there — no QuoxFlow workflow was ever
 * created, no execution id was ever recorded, and no status poller was
 * ever attached. The only code path that actually dispatched execution
 * was the HTTP POST /api/objectives/:id/approve-plan handler in
 * server.js. That meant autonomous (ACT) and team auto-approved
 * objectives never actually ran — they just sat as 'running' rows with
 * no quoxflow_execution_id until the boot reconciler / reaper (TRUST-GATE
 * 1.2) swept them up ~2 minutes later and marked them 'failed' as
 * orphans (see objectiveReconciler.js: "no QuoxFlow execution id
 * recorded").
 *
 * This module extracts the exact sequence the approve-plan handler used
 * to perform inline — fetch tasks, convert to a QuoxFlow workflow, kick
 * off execution, persist the execution id, and attach a tracked status
 * poller — into a single reusable function. approve-plan, agentScheduler
 * (ACT), and teamScheduler (auto-approve) all now call this one function,
 * so there is exactly one dispatch path instead of several divergent
 * ones.
 */

import { executeViaQuoxFlow, pollExecutionStatus } from './quoxflowBridge.js'
import { trackPoll } from './objectiveReconciler.js'
import { emitProgress } from './progress.js'
import { getTeamContext, buildTeamContextBlock } from './teamLoader.js'
import { buildDependencyResultsBlock } from './dagUtils.js'
import { dispatchLoopObjective } from './loopDispatch.js'
import { checkSafetyGate } from './safetyGate.js'

/**
 * Dispatch an objective's tasks for execution via QuoxFlow.
 *
 * Expects the objective's tasks to already exist in the `tasks` table
 * (created either by decomposeObjective() or directly by a scheduler).
 * Does NOT check/require any particular objective.status — callers are
 * responsible for whatever pre-dispatch state validation makes sense for
 * their flow (e.g. the HTTP endpoint requires 'decomposed').
 *
 * On success: updates the objective row (status='running',
 * quoxflow_workflow_id, quoxflow_execution_id, started_at), emits an
 * `objective_started` progress event, and attaches a tracked
 * fire-and-forget status poller (so the reaper/reconciler sees this
 * objective as attended and won't orphan it).
 *
 * On failure: updates the objective row (status='failed', error_message)
 * and emits an `objective_failed` progress event.
 *
 * @param {string} objectiveId
 * @param {object} [options]
 * @param {object} [options.db] - injected db handle (defaults to getDatabase())
 * @returns {Promise<{success: boolean, workflowId?: string, executionId?: string, error?: string}>}
 */
export async function dispatchObjective(objectiveId, options = {}) {
  const { getDatabase } = await import('../db/index.js')
  const db = options.db || getDatabase()

  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (!objective) {
    return { success: false, error: `Objective ${objectiveId} not found` }
  }

  // quox#506: kill-switch / DEFCON gate at THE shared dispatch chokepoint.
  // PR #505 gated agentScheduler and loopDispatch individually, but
  // teamScheduler auto-approve, the approve-plan HTTP endpoint and
  // calendarEvents all reach this helper ungated — a team schedule, a
  // human-approved plan or a calendar reminder could still dispatch work
  // for a halted agent. Gating HERE covers every present and future caller
  // (fix the scaffold, not the instances). Fails CLOSED via safetyGate.js.
  // Sits BEFORE the loop branch so loop mode is covered too (loopDispatch's
  // own pre-spawn + per-turn gates remain as defense in depth).
  //
  // A refusal deliberately does NOT fail the objective: an E-STOP holds
  // work, it does not destroy it. The plan keeps its status so a human can
  // re-approve after the halt is released. ORANGE (escalate) is not blocked
  // here — escalation semantics belong to the callers that can act on them
  // (agentScheduler threads it into makeDecision; approve-plan IS the
  // human approval ORANGE asks for).
  const dispatchGate = await (options.safetyGateFn || checkSafetyGate)(
    objective.org_id, objective.orchestrator_agent_id || 'quox'
  )
  if (dispatchGate.blocked) {
    const error = `Dispatch refused: ${dispatchGate.reason || 'agent halted'}`
    emitProgress(objective.id, { type: 'objective_dispatch_refused', message: error })
    return {
      success: false,
      error,
      code: 'AGENT_HALTED',
      safetyGate: { blocked: true, defcon: dispatchGate.defcon, agentHalted: dispatchGate.agentHalted },
    }
  }

  const tasks = db.prepare('SELECT * FROM tasks WHERE objective_id = ? ORDER BY sequence_num ASC').all(objective.id)

  // DEVSUITE-DEVMODE Phase 5b-1: a loop-mode objective runs the model's
  // own turn-by-turn agentic loop instead of a pre-planned QuoxFlow DAG.
  // It legitimately has NO upfront tasks — branch out before the
  // zero-tasks guard below so a fresh loop objective never gets treated
  // as "cannot dispatch objective with no tasks".
  if (objective.execution_mode === 'loop') {
    return await dispatchLoopObjective(objective, tasks, { db, ...options })
  }

  if (tasks.length === 0) {
    const error = 'Cannot dispatch objective with no tasks'
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(error, objective.id)
    emitProgress(objective.id, { type: 'objective_failed', message: error })
    return { success: false, error }
  }

  // MACHINERY-4a: read-side of the shared-context write wiring (see
  // quoxflowBridge.js pollExecutionStatus). Fetched once per dispatch so
  // every member task prompt in a team objective can see prior teammates'
  // task-completion summaries (populated across rounds, e.g. the R3.3
  // re-observe loop).
  let teamContextBlock = ''
  if (objective.team_instance_id) {
    const ctx = getTeamContext(objective.team_instance_id)
    teamContextBlock = buildTeamContextBlock(ctx?.task_history)
  }

  // Convert task ID-based depends_on back to index-based for the converter
  const taskIdToIndex = new Map(tasks.map((t, i) => [t.id, i]))
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const tasksForConverter = tasks.map(t => {
    const depIds = JSON.parse(t.depends_on || '[]')
    const depIndices = depIds.map(id => taskIdToIndex.get(id)).filter(i => i !== undefined)

    // MACHINERY-4b: structured dependency hand-off — replaces the prose
    // convention ("assume it will receive results") with the dependency
    // tasks' actual stored results, injected directly into the prompt.
    // Applies to all objective tasks with dependencies, not just teams.
    const depTasks = depIds.map(id => taskById.get(id)).filter(Boolean)
    const depsBlock = buildDependencyResultsBlock(depTasks)

    const prompt = `${t.prompt || ''}${teamContextBlock}${depsBlock}`
    // MACH-FOLLOWUP WI-D: carry the owner-authored system_prompt through to
    // workflowConverter (plan §4.4 step 4).
    // HV2-6: carry kind + assignee_id through so a human step converts to a
    // human:task node (previously dropped here — the converter branch would
    // never fire).
    return { title: t.title, agent_id: t.agent_id, prompt, depends_on: depIndices, system_prompt: t.system_prompt, kind: t.kind, assignee_id: t.assignee_id }
  })

  const result = await executeViaQuoxFlow(tasksForConverter, {
    objectiveId: objective.id,
    objectiveTitle: objective.title,
    orgId: objective.org_id,
    userId: objective.user_id,
    teamId: objective.team_id,
    maxTokens: objective.max_tokens,
    maxToolCalls: objective.max_tool_calls,
    maxDurationMs: objective.max_duration_ms,
    quoxflowUrl: options.quoxflowUrl,
  })

  if (!result.success) {
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(String(result.error || 'QuoxFlow execution failed').slice(0, 2000), objective.id)

    emitProgress(objective.id, { type: 'objective_failed', message: result.error })
    return { success: false, error: result.error }
  }

  db.prepare(`
    UPDATE objectives SET status = 'running', started_at = COALESCE(started_at, datetime('now')),
    quoxflow_workflow_id = ?, quoxflow_execution_id = ?
    WHERE id = ?
  `).run(result.workflowId, result.executionId, objective.id)

  emitProgress(objective.id, {
    type: 'objective_started',
    message: 'Executing via QuoxFlow',
    workflowId: result.workflowId,
    executionId: result.executionId,
  })

  // Fire-and-forget: poll QuoxFlow and sync task statuses back.
  // TRUST-GATE 1.2: tracked so the reaper knows this objective already
  // has an in-process poller attached and won't try to reconcile it.
  const taskIds = tasks.map(t => t.id)
  trackPoll(objective.id, pollExecutionStatus(result.executionId, objective.id, taskIds, {
    maxPollMs: options.pollOptions?.maxPollMs ?? (objective.max_duration_ms || 900000),
    pollInterval: options.pollOptions?.pollInterval,
    orgId: objective.org_id,
    quoxflowUrl: options.quoxflowUrl,
  }).catch(err => {
    console.error(`[ObjectiveDispatch] Execution poll error for ${objective.id}:`, err.message)
  }))

  return { success: true, workflowId: result.workflowId, executionId: result.executionId }
}
