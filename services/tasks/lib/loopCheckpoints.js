/**
 * loopCheckpoints.js: DEVSUITE-DEVMODE / QLoop feature 4.
 * LIVE human-in-the-loop checkpoints raised while a loop is still running.
 *
 * The pre-existing checkpoint surface is a BEFORE gate: 'before_start' is
 * created before dispatch and the objective waits on it. A loop objective has
 * no such moment after it starts. It is one long-lived session whose turns
 * arrive as a stream, and the interesting things to review (budget burning
 * down, a destructive command, "it has been ten turns, is this still sane?")
 * all happen mid-flight.
 *
 * v1 SEMANTICS (deliberate, and the reason this is small)
 * -------------------------------------------------------
 *   - A gate NEVER pauses the stream. The session belongs to a CLI on another
 *     host; there is no back-pressure channel that can hold a turn open, and
 *     inventing one would mean either killing the session or lying about it.
 *     So a gate is an OBSERVATION with a decision attached: the loop keeps
 *     running while the checkpoint is pending.
 *   - Approve therefore has no dispatch side effect: it is the human saying
 *     "carry on", and the loop already did.
 *   - Deny is the lever with teeth: it interrupts the live session (the same
 *     structured-kill path the Observer/Knot uses, with its own reason) and
 *     fails the objective with a human-deny message.
 *   - At most ONE pending loop_* checkpoint per objective, and each gate type
 *     fires at most once per session (risk may fire again for a DIFFERENT
 *     canonical tool). A stream can emit hundreds of turns; a gate that fires
 *     per turn is an inbox flood, which trains people to ignore the inbox.
 *
 * The schema carries no metadata column on checkpoints, so the gate's context
 * (the numbers, the tool, the command) lives in `description`, written for a
 * human reading it in the approvals inbox.
 */

import { ulid } from 'ulid'
import { emitProgress } from './progress.js'
import { HIGH_RISK_TOOLS } from './riskTools.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'

/** Same convention as budget.js (checkBudget warns at 0.8 of every ceiling). */
export const BUDGET_THRESHOLD = 0.8

/** Turns between interval gates, when the objective opts in. */
export const INTERVAL_TURNS = 10

export const LOOP_CHECKPOINT_TYPES = {
  BUDGET: 'loop_budget_threshold',
  RISK: 'loop_risk_action',
  INTERVAL: 'loop_interval',
}

const ALL_LOOP_TYPES = Object.values(LOOP_CHECKPOINT_TYPES)

const TITLES = {
  [LOOP_CHECKPOINT_TYPES.BUDGET]: 'Loop budget threshold',
  [LOOP_CHECKPOINT_TYPES.RISK]: 'Loop risk action',
  [LOOP_CHECKPOINT_TYPES.INTERVAL]: 'Loop interval review',
}

/** The reason carried to the collector when a human denies a live gate. */
export const DENY_REASON = 'checkpoint_denied'

/**
 * The reason carried when a human halts a running loop ON DEMAND, without a
 * pending gate to deny. The deny lever only exists while a gate happens to be
 * pending (interval at 10 turns, budget at 80%, risk on a risky call); a fast
 * loop self-completes before any gate fires, leaving a human no way to stop an
 * in-flight loop. This is the unconditional "stop now" lever. The kill machinery
 * is identical to deny's (proven live 2026-08-14, session dls_729528); only the
 * trigger and the audit reason differ.
 */
export const HUMAN_HALT_REASON = 'human_halt'

/**
 * P0b (QUOXPERTICUS DEC-9): the reason carried when a sandbox-leased loop is
 * halted because the test-approver lease lapsed while it was in flight. Same
 * kill machinery as human_halt; only the trigger and the audit reason differ.
 */
export const SANDBOX_LEASE_EXPIRED_REASON = 'sandbox_lease_expired'

/**
 * Destructive shell shapes worth a human's eye. This is a denylist, with the
 * same honest caveat riskTools.js already carries: anything not named here
 * sails through. It is a prompt for review, never an enforcement boundary:
 * enforcement is capability_scope, checked pre-flight by the CLI and post-hoc
 * by the loop's out-of-scope backstop.
 */
export const RISKY_COMMAND_PATTERN = /rm\s+-rf|sudo\s|dd\s+if=|mkfs|git\s+push\s+--force|curl[^|]*\|\s*(ba)?sh/i

/** The shell tool in canonical (claude) vocabulary; codex 'command' maps here. */
const SHELL_TOOL = 'Bash'

/**
 * HIGH_RISK_TOOLS are governed Quox tools, named plainly in the autonomy gate
 * but prefixed in a loop's tool stream, so match them in the loop's spelling.
 */
export const HIGH_RISK_LOOP_TOOLS = new Set(
  [...HIGH_RISK_TOOLS].map(name => `mcp__quox__${name}`)
)

export function isLoopCheckpointType(type) {
  return ALL_LOOP_TYPES.includes(type)
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'aborted'])

function pct(used, ceiling) {
  return Math.round((used / ceiling) * 100)
}

// ─── Gate evaluators (pure) ───────────────────────────────────────────────────

/**
 * Has this loop burned 80 percent of any ceiling it was given? Returns a
 * human-readable reason, or null.
 *
 * The three ceilings are objectives.max_tokens / max_tool_calls /
 * max_duration_ms, the same ones checkBudget() enforces on the DAG path (which
 * the loop path never calls, having no per-task boundary to call it at).
 * A codex loop reports no per-turn tokens, so on that backend the tool-call and
 * duration limbs are the ones that speak.
 */
export function budgetGateReason(objective, { tokensUsed = 0, toolCallsUsed = 0, elapsedMs = 0 } = {}) {
  if (objective.max_tokens > 0 && tokensUsed / objective.max_tokens >= BUDGET_THRESHOLD) {
    return `Token usage at ${pct(tokensUsed, objective.max_tokens)}% of budget (${tokensUsed}/${objective.max_tokens}) while the loop is still running`
  }
  if (objective.max_tool_calls > 0 && toolCallsUsed / objective.max_tool_calls >= BUDGET_THRESHOLD) {
    return `Tool calls at ${pct(toolCallsUsed, objective.max_tool_calls)}% of budget (${toolCallsUsed}/${objective.max_tool_calls}) while the loop is still running`
  }
  if (objective.max_duration_ms > 0 && elapsedMs / objective.max_duration_ms >= BUDGET_THRESHOLD) {
    return `Elapsed time at ${pct(elapsedMs, objective.max_duration_ms)}% of budget (${Math.round(elapsedMs / 1000)}s of ${Math.round(objective.max_duration_ms / 1000)}s) while the loop is still running`
  }
  return null
}

/**
 * Is this turn's tool call worth a human's eye? `canonicalTool` is already
 * translated into the capability_scope vocabulary by backendVocabulary, so one
 * rule covers both backends; `argsKey` is the detector's args signature (the
 * JSON args for claude, the literal command string for codex).
 * @returns {{ tool: string, description: string }|null}
 */
export function riskGateFinding(canonicalTool, argsKey) {
  if (typeof canonicalTool !== 'string' || !canonicalTool) return null
  if (HIGH_RISK_LOOP_TOOLS.has(canonicalTool)) {
    return {
      tool: canonicalTool,
      description: `Loop called high-risk tool ${canonicalTool}. Approve to let the loop continue, deny to stop the session.`,
    }
  }
  if (canonicalTool === SHELL_TOOL && RISKY_COMMAND_PATTERN.test(String(argsKey || ''))) {
    return {
      tool: canonicalTool,
      description: `Loop ran a destructive ${SHELL_TOOL} command: ${String(argsKey).slice(0, 300)}. Approve to let the loop continue, deny to stop the session.`,
    }
  }
  return null
}

/**
 * Per-session gate latch. Budget and interval fire once each; risk fires once
 * per DISTINCT canonical tool, so a loop that reaches for two different
 * dangerous things is reviewed twice, and one that hammers the same one is not.
 *
 * A claim is spent on ATTEMPT, not on successful creation: if the dedup guard
 * turns the attempt away because another loop_* checkpoint is already pending,
 * the gate does not queue itself up to retry on every subsequent turn.
 */
export function createGateLatch() {
  const claimed = new Set()
  return {
    claim(type, key = '') {
      const k = type === LOOP_CHECKPOINT_TYPES.RISK ? `${type}:${key}` : type
      if (claimed.has(k)) return false
      claimed.add(k)
      return true
    },
  }
}

// ─── Checkpoint creation ──────────────────────────────────────────────────────

function logLoopCheckpointEvent(db, objectiveId, level, event, message) {
  try {
    db.prepare(`
      INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(ulid(), objectiveId, level, event, message.slice(0, 2000))
  } catch (err) {
    console.error(`[LoopCheckpoints] Log write failed for ${objectiveId}:`, err.message)
  }
}

/**
 * Raise one live loop checkpoint, unless another loop_* one is already pending
 * on this objective. task_id is null by construction: a loop gate is about the
 * SESSION, not about any single synthetic turn row.
 *
 * Never throws: a checkpoint that cannot be written must not kill a running
 * loop's event consumer (same rule as usage accounting).
 * @returns {string|null} the checkpoint id, or null when skipped/failed
 */
export function createLoopCheckpoint(db, objective, type, description) {
  try {
    const pending = db.prepare(`
      SELECT id FROM checkpoints
      WHERE objective_id = ? AND status = 'pending' AND checkpoint_type IN (${ALL_LOOP_TYPES.map(() => '?').join(',')})
      LIMIT 1
    `).get(objective.id, ...ALL_LOOP_TYPES)

    if (pending) {
      // No stacking. Surfaced on the existing warning channel rather than a new
      // event type, because the frontend allowlists event types explicitly.
      emitProgress(objective.id, {
        type: 'budget_warning',
        message: `Loop gate ${type} skipped: checkpoint ${pending.id} is still awaiting review`,
      })
      return null
    }

    const id = ulid()
    db.prepare(`
      INSERT INTO checkpoints (id, objective_id, task_id, checkpoint_type, status, title, description, created_at)
      VALUES (?, ?, NULL, ?, 'pending', ?, ?, datetime('now'))
    `).run(id, objective.id, type, TITLES[type] || 'Loop checkpoint', description)

    emitProgress(objective.id, { type: 'checkpoint_created', checkpoint_id: id, checkpoint_type: type })
    // AEE-CHECKPOINT-EVIDENCE (quox#480): CHECKPOINT_CREATED has never been
    // emitted from any live pathway. A human gate is exactly the kind of act
    // the evidence trail exists for, so it is written here at creation.
    createTaskEnvelope({
      type: 'event', from: 'service.tasks', to: 'human.user',
      intent: TASK_INTENTS.CHECKPOINT_CREATED,
      payload: {
        checkpoint_id: id,
        checkpoint_type: type,
        task_id: null,
        objective_title: objective.title,
        message: description,
        engine: 'loop',
        loop_session_id: objective.loop_session_id || undefined,
      },
      corrId: objective.corr_id, objectiveId: objective.id,
    })
    logLoopCheckpointEvent(db, objective.id, 'warn', 'loop_checkpoint_created', `${type}: ${description}`)
    return id
  } catch (err) {
    console.error(`[LoopCheckpoints] Checkpoint creation failed for ${objective.id}:`, err.message)
    return null
  }
}

/**
 * Evaluate every gate for one consumed turn, in order: budget, risk, interval.
 * At most one checkpoint per turn (the dedup guard would refuse a second
 * anyway); the order says which concern wins when two land together.
 *
 * @param {object} ctx
 * @param {object} ctx.latch        per-session latch from createGateLatch()
 * @param {number} ctx.tokensUsed   running token total for this session
 * @param {number} ctx.toolCallsUsed running tool-call total for this session
 * @param {number} ctx.elapsedMs    wall time since the stream started
 * @param {number} ctx.sequenceNum  turns recorded so far
 * @param {{tool: string, description: string}|null} [ctx.risk] this turn's risk finding
 * @returns {string|null} the checkpoint id created, if any
 */
export function evaluateLoopGates(db, objective, ctx = {}) {
  const latch = ctx.latch
  if (!latch) return null

  const budget = budgetGateReason(objective, ctx)
  if (budget && latch.claim(LOOP_CHECKPOINT_TYPES.BUDGET)) {
    return createLoopCheckpoint(db, objective, LOOP_CHECKPOINT_TYPES.BUDGET, budget)
  }

  if (ctx.risk && latch.claim(LOOP_CHECKPOINT_TYPES.RISK, ctx.risk.tool)) {
    return createLoopCheckpoint(db, objective, LOOP_CHECKPOINT_TYPES.RISK, ctx.risk.description)
  }

  // The interval gate is what finally makes objectives.checkpoint_after_each_task
  // mean something: the column has been stored and never read since the baseline
  // schema. On a loop there are no discrete tasks to check after, so the opt-in
  // buys a periodic review instead.
  if (
    objective.checkpoint_after_each_task
    && ctx.sequenceNum > 0
    && ctx.sequenceNum % INTERVAL_TURNS === 0
    && latch.claim(LOOP_CHECKPOINT_TYPES.INTERVAL)
  ) {
    return createLoopCheckpoint(
      db, objective, LOOP_CHECKPOINT_TYPES.INTERVAL,
      `Loop reached ${ctx.sequenceNum} turns with no human review. Approve to let it continue, deny to stop the session.`
    )
  }

  return null
}

// ─── Approve / deny ───────────────────────────────────────────────────────────

/**
 * Approving a live loop gate is deliberately side-effect free: the loop never
 * stopped, so there is nothing to resume. Record it so the audit trail shows a
 * human saw the gate and let it run.
 */
export function recordLoopCheckpointApproval(db, objective, { checkpointId, checkpointType, reviewerId, notes } = {}) {
  const detail = notes ? `, notes: ${notes}` : ''
  logLoopCheckpointEvent(
    db, objective.id, 'info', 'loop_checkpoint_approved',
    `${checkpointType} checkpoint ${checkpointId} approved by ${reviewerId || 'unknown'}; loop continues${detail}`
  )
}

/**
 * Default interrupt for a denied gate: the collector's structured-kill path,
 * the same one the Observer/Knot uses, carrying this path's own reason.
 *
 * Imported lazily to keep loopDispatch -> loopCheckpoints a one-way edge at
 * module-eval time.
 */
async function defaultDenyInterrupt(objective, reason) {
  const { interruptLoopSession } = await import('./loopDispatch.js')
  return interruptLoopSession(objective, reason)
}

/**
 * A human denied a live gate: stop the session and fail the objective.
 *
 * The interrupt reaches the session through the collector rather than through
 * the consumer's injected interruptFn, because the route has no handle on that
 * closure (the consumer is fire-and-forget, and after a restart it is not even
 * in this process) while the collector is the authority on the live session and
 * already accepts a reason. `interruptFn` stays injectable for tests.
 *
 * Guarded independently of the consumer's one-shot observer latch: this path
 * refuses only on an already-terminal objective, so an observer interrupt
 * earlier in the run cannot swallow a human deny, and vice versa.
 *
 * @returns {Promise<{interrupted: boolean, failed: boolean, message?: string}>}
 */
export async function denyLoopCheckpoint(db, objective, opts = {}) {
  const { checkpointId, checkpointType, reviewerId, notes } = opts
  const interruptFn = opts.interruptFn !== undefined ? opts.interruptFn : defaultDenyInterrupt

  const current = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objective.id)
  const status = current?.status || objective.status
  if (!current || TERMINAL_STATUSES.has(status)) {
    return { interrupted: false, failed: false }
  }

  let interrupted = false
  if (typeof interruptFn === 'function') {
    try {
      await interruptFn(objective, DENY_REASON)
      interrupted = true
    } catch (err) {
      // A failed interrupt must not block the deny: the objective is still
      // failed, and the session keeps its max_duration/max_turns backstops.
      console.error(`[LoopCheckpoints] Deny interrupt failed for ${objective.id}:`, err.message)
    }
  }

  const detail = notes ? `: ${notes}` : ''
  const message = `Loop stopped by human review: ${checkpointType || 'loop checkpoint'} checkpoint ${checkpointId || ''} denied by ${reviewerId || 'a reviewer'}${detail}`.replace(/\s+/g, ' ').trim()

  db.prepare(`
    UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE id = ?
  `).run(message.slice(0, 2000), objective.id)

  logLoopCheckpointEvent(db, objective.id, 'warn', 'loop_checkpoint_denied', message)
  emitProgress(objective.id, { type: 'objective_failed', message })

  return { interrupted, failed: true, message }
}

/**
 * A human halts a running loop ON DEMAND (no pending gate required). Same teeth
 * as denyLoopCheckpoint (signed structured-kill via the collector, then fail the
 * objective), but reachable at any moment a loop is in-flight rather than only
 * when a gate is pending. This closes the governance gap surfaced by the
 * 2026-08-14 deny-teeth proof: the kill works, but a human had no unconditional
 * way to fire it. Only a loop objective that is not already terminal can be
 * halted; halting anything else is a no-op the caller reports as such.
 *
 * @returns {Promise<{halted: boolean, interrupted: boolean, message?: string}>}
 */
export async function haltLoopObjective(db, objective, opts = {}) {
  const { reviewerId, notes } = opts
  const interruptFn = opts.interruptFn !== undefined ? opts.interruptFn : defaultDenyInterrupt

  if (objective.execution_mode !== 'loop') {
    return { halted: false, interrupted: false, message: 'not a loop objective' }
  }
  const current = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objective.id)
  const status = current?.status || objective.status
  if (!current || TERMINAL_STATUSES.has(status)) {
    return { halted: false, interrupted: false, message: `objective already ${status || 'unknown'}` }
  }

  let interrupted = false
  if (typeof interruptFn === 'function') {
    try {
      await interruptFn(objective, HUMAN_HALT_REASON)
      interrupted = true
    } catch (err) {
      // A failed interrupt must not block the halt: the objective is still
      // failed, and the session keeps its max_duration/max_turns backstops.
      console.error(`[LoopCheckpoints] Halt interrupt failed for ${objective.id}:`, err.message)
    }
  }

  const detail = notes ? `: ${notes}` : ''
  const message = `Loop halted on demand by ${reviewerId || 'a human'}${detail}`.replace(/\s+/g, ' ').trim()

  db.prepare(`
    UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE id = ?
  `).run(message.slice(0, 2000), objective.id)

  logLoopCheckpointEvent(db, objective.id, 'warn', 'loop_human_halt', message)
  emitProgress(objective.id, { type: 'objective_failed', message })

  return { halted: true, interrupted, message }
}

/**
 * P0b (QUOXPERTICUS DEC-9): a sandbox-leased loop's test-approver lease
 * lapsed while the loop was in flight. Same teeth as haltLoopObjective
 * (structured-kill via the collector, then fail the objective), triggered by
 * the loop consumer's per-turn grant re-check rather than a human. Without
 * this, an exercise dispatched under a lease simply outlives it, which makes
 * the lease decorative (leased, not latched is a property only if expiry has
 * teeth mid-flight).
 *
 * @returns {Promise<{halted: boolean, interrupted: boolean, message?: string}>}
 */
export async function haltLoopForExpiredLease(db, objective, opts = {}) {
  const interruptFn = opts.interruptFn !== undefined ? opts.interruptFn : defaultDenyInterrupt

  const current = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objective.id)
  const status = current?.status || objective.status
  if (!current || TERMINAL_STATUSES.has(status)) {
    return { halted: false, interrupted: false, message: `objective already ${status || 'unknown'}` }
  }

  let interrupted = false
  if (typeof interruptFn === 'function') {
    try {
      await interruptFn(objective, SANDBOX_LEASE_EXPIRED_REASON)
      interrupted = true
    } catch (err) {
      // A failed interrupt must not block the halt: the objective is still
      // failed, and the session keeps its max_duration/max_turns backstops.
      console.error(`[LoopCheckpoints] Lease-expiry interrupt failed for ${objective.id}:`, err.message)
    }
  }

  const message = 'Loop halted: the sandbox test-approver lease expired or was revoked while the loop was in flight (leased, not latched)'

  db.prepare(`
    UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE id = ?
  `).run(message, objective.id)

  logLoopCheckpointEvent(db, objective.id, 'warn', 'loop_sandbox_lease_halt', message)
  emitProgress(objective.id, { type: 'objective_failed', message })

  return { halted: true, interrupted, message }
}

/**
 * quox#503: the reason carried when a live loop is killed because the
 * server-side kill switch / DEFCON gate (services/tasks/lib/safetyGate.js)
 * reported `blocked` at a turn boundary — a per-agent E-STOP activated
 * mid-flight, an instance DEFCON RED, or the gate itself being unreadable
 * (fails closed, same posture as the sandbox lease check). Same kill
 * machinery as human_halt/sandbox_lease_expired; only the trigger and the
 * audit reason differ.
 */
export const SAFETY_GATE_HALT_REASON = 'safety_gate_halted'

/**
 * quox#503: a live loop session is killed because the safety gate reported
 * `blocked` on this turn's re-check. Same teeth as haltLoopForExpiredLease
 * (structured-kill via the collector, then fail the objective) — this is
 * the loopDispatch.js turn-boundary enforcement point, checkpoint (b) of
 * the kill-switch wiring (see loopDispatch.js's consumeLoopEvents for the
 * per-turn call site).
 *
 * @param {string} reason - the safety gate's own `reason` string, carried
 *   into the objective's error_message so the evidence trail says WHY.
 * @returns {Promise<{halted: boolean, interrupted: boolean, message?: string}>}
 */
export async function haltLoopForSafetyGate(db, objective, reason, opts = {}) {
  const interruptFn = opts.interruptFn !== undefined ? opts.interruptFn : defaultDenyInterrupt

  const current = db.prepare('SELECT status FROM objectives WHERE id = ?').get(objective.id)
  const status = current?.status || objective.status
  if (!current || TERMINAL_STATUSES.has(status)) {
    return { halted: false, interrupted: false, message: `objective already ${status || 'unknown'}` }
  }

  let interrupted = false
  if (typeof interruptFn === 'function') {
    try {
      await interruptFn(objective, SAFETY_GATE_HALT_REASON)
      interrupted = true
    } catch (err) {
      // A failed interrupt must not block the halt: the objective is still
      // failed, and the session keeps its max_duration/max_turns backstops.
      console.error(`[LoopCheckpoints] Safety-gate interrupt failed for ${objective.id}:`, err.message)
    }
  }

  const message = `Loop halted: kill switch / DEFCON gate blocked this agent (${reason || 'safety gate active'})`

  db.prepare(`
    UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE id = ?
  `).run(message.slice(0, 2000), objective.id)

  logLoopCheckpointEvent(db, objective.id, 'warn', 'loop_safety_gate_halt', message)
  emitProgress(objective.id, { type: 'objective_failed', message })

  return { halted: true, interrupted, message }
}
