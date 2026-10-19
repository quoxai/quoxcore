// ACT / ESCALATE / DEFER decision framework for autonomous agent execution
// Phase 7.A: Agent Autonomy Framework
// QMH-4c: layered authority levels (L1..L4) gated by quoxmind license tier.
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { isPluginLicensed } from './licenseGate.js'
import { HIGH_RISK_TOOLS } from './riskTools.js'
import { getStanding, resolveTaskClass, STANDING_STATUS } from './agentStanding.js'

// Decision types
export const DECISIONS = { ACT: 'ACT', ESCALATE: 'ESCALATE', DEFER: 'DEFER' }

// QMH-4c — Authority levels. The decision (ACT/ESCALATE/DEFER) describes
// what to do; authority describes how far the system is allowed to go on
// its own. Free orgs may not exceed L2 (HITL). Pro adds L3 (task abort).
// Complete adds L4 (objective abort).
export const AUTHORITY_LEVELS = Object.freeze({
  L1_ALERT: 1,
  L2_PAUSE: 2,
  L3_TASK_ABORT: 3,
  L4_OBJECTIVE_ABORT: 4,
})

/**
 * Resolve the maximum authority level a given org may exercise.
 *
 * Mapping:
 *   quoxmind-complete licensed → L4
 *   quoxmind-pro licensed      → L3
 *   neither                    → L2
 *
 * Independent gates: a hypothetical complete-only license still resolves
 * to L4 even without pro. Tier ladders are an entitlement decision; the
 * gate function asks the auth service per-plugin.
 */
export async function resolveAuthorityCeiling(orgId) {
  if (await isPluginLicensed(orgId, 'quoxmind-complete')) return AUTHORITY_LEVELS.L4_OBJECTIVE_ABORT
  if (await isPluginLicensed(orgId, 'quoxmind-pro'))      return AUTHORITY_LEVELS.L3_TASK_ABORT
  return AUTHORITY_LEVELS.L2_PAUSE
}

/**
 * Clamp a requested authority level to the ceiling and downgrade the
 * decision if the request crossed an autonomous-abort threshold (L3+).
 *
 * Pure function. Inputs:
 *   { decision, requestedLevel, ceiling }
 * Output:
 *   { decision, authorityLevel, requestedLevel, ceiling, downgraded[, reason] }
 */
export function applyAuthorityCeiling({ decision, requestedLevel, ceiling }) {
  const effective = Math.min(requestedLevel, ceiling)
  const downgraded = effective < requestedLevel

  let resolvedDecision = decision
  if (downgraded
      && decision === DECISIONS.DEFER
      && requestedLevel >= AUTHORITY_LEVELS.L3_TASK_ABORT) {
    // Caller asked for an autonomous abort but we don't have authority.
    // Surface to a human instead of silently swallowing the action.
    resolvedDecision = DECISIONS.ESCALATE
  }

  const result = {
    decision: resolvedDecision,
    authorityLevel: effective,
    requestedLevel,
    ceiling,
    downgraded,
  }
  if (downgraded) {
    result.reason = `License ceiling: requested L${requestedLevel}, capped at L${effective}`
  }
  return result
}

/**
 * End-to-end autonomy decision with authority enforcement.
 *
 * Wraps the existing sync makeDecision() to (a) compute the base
 * ACT/ESCALATE/DEFER decision and (b) clamp it against the org's license
 * ceiling. Returns the same fields as makeDecision plus authorityLevel,
 * requestedLevel, ceiling, downgraded.
 *
 * Callers default to requestedLevel = L4. Specific subsystems can request
 * lower levels (e.g. an alert-only watchdog requests L1).
 */
export async function decideAutonomousAction({
  task, objective, schedule, agentDef, budgetStatus,
  requestedLevel = AUTHORITY_LEVELS.L4_OBJECTIVE_ABORT,
}) {
  const base = makeDecision({ task, objective, schedule, agentDef, budgetStatus })
  const ceiling = await resolveAuthorityCeiling(objective.org_id)
  const clamped = applyAuthorityCeiling({
    decision: base.decision,
    requestedLevel,
    ceiling,
  })
  return {
    ...base,
    decision: clamped.decision,
    authorityLevel: clamped.authorityLevel,
    requestedLevel: clamped.requestedLevel,
    ceiling: clamped.ceiling,
    downgraded: clamped.downgraded,
    reason: clamped.downgraded ? `${base.reason}; ${clamped.reason}` : base.reason,
  }
}

// Default escalation policy — used when agent manifest doesn't specify one
const DEFAULT_POLICY = {
  onHighRisk: 'ESCALATE',
  onBudgetWarning: 'ESCALATE',
  onFailure: 'DEFER',
  onUnknownTool: 'ESCALATE',
  confidenceThreshold: 0.7,
  maxRetries: 2,
  escalateTo: null // defaults to schedule owner
}

// High-risk tools that trigger escalation by default. Lives in its own
// module (riskTools.js, imported above) rather than being defined here so
// agentStanding.js can import the same set without a circular import back
// into this file (agentStanding.js is itself imported above for the
// standing gate). Re-exported here for any existing/external importers of
// this name.
// NOTE (2026-08-09 audit): this is a bypassable denylist for the tool-risk
// check below (a tool string outside the set sails through unescalated).
// That finding does not block Standing — Standing uses it as-is for
// risk-tiering, same as makeDecision() does for escalation.
export { HIGH_RISK_TOOLS }

/**
 * Resolve an objective's signed capability_scope into a deny-by-default
 * allowlist (DEVSUITE-DEVMODE loop-mode safety redesign). Returns:
 *   { present: false }                       — no scope declared (DAG/legacy)
 *   { present: true, malformed: true }        — declared but not an array
 *   { present: true, malformed: false, scope } — the allowlist of tool names
 *
 * Accepts the scope as a real array or a JSON-string (how it lands from a
 * TEXT column). A declared-but-unparseable scope is malformed and the caller
 * MUST fail closed — a broken scope can never become "allow everything".
 * @param {Object} objective
 */
export function resolveCapabilityScope(objective) {
  const raw = objective?.capability_scope
  if (raw === undefined || raw === null || raw === '') return { present: false }
  if (Array.isArray(raw)) return { present: true, malformed: false, scope: raw }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return { present: true, malformed: false, scope: parsed }
      return { present: true, malformed: true }
    } catch {
      return { present: true, malformed: true }
    }
  }
  return { present: true, malformed: true }
}

/**
 * Make an ACT/ESCALATE/DEFER decision for an autonomous task.
 *
 * @param {Object} params
 * @param {Object} params.task - The task to evaluate
 * @param {Object} params.objective - Parent objective
 * @param {Object} params.schedule - The agent schedule that triggered this
 * @param {Object} params.agentDef - Agent definition from registry (optional)
 * @param {Object} params.budgetStatus - Current budget check result
 * @param {string} [params.instanceDefcon] - quox#503: the org's instance-wide
 *   DEFCON level (services/collector/lib/killSwitchStore.js), independent of
 *   agentDef.defconLevel. Callers that already read the safety gate for
 *   their pre-dispatch check (agentScheduler.js) pass it through here so the
 *   same ORANGE/RED -> ESCALATE rule applies; callers that don't read it
 *   (older/other callers of this function) simply see no instance-level
 *   effect, same as before this param existed.
 * @returns {{ decision: string, reason: string, metadata: Object }}
 */
export function makeDecision({ task, objective, schedule, agentDef, budgetStatus, instanceDefcon }) {
  const policy = {
    ...DEFAULT_POLICY,
    ...(schedule?.escalation_policy || {}),
    ...(agentDef?.autonomy?.escalation || {})
  }

  const reasons = []
  const metadata = {
    agent_id: task.agent_id,
    schedule_id: schedule?.id,
    objective_id: objective.id,
    task_id: task.id,
    policy_applied: policy
  }

  // 1. Budget check — checkAgentBudget returns { allowed, reason, warnings? }
  if (budgetStatus && budgetStatus.allowed === false) {
    reasons.push(`Budget exhausted: ${budgetStatus.reason}`)
    return makeResult(DECISIONS.DEFER, reasons, metadata, objective, schedule)
  }
  if (budgetStatus?.warnings?.length > 0) {
    if (policy.onBudgetWarning === 'ESCALATE') {
      reasons.push(`Budget warning: ${budgetStatus.warnings.join(', ')}`)
      return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
    }
  }

  // 1.5. Agent Standing gate. Checked BEFORE the tool-risk check: an agent
  // whose (org, agent, task_class) standing has dropped to 'supervised'
  // (score < 40 from corrections/overrides/rollbacks, see agentStanding.js)
  // is forced to ESCALATE regardless of what the per-decision checks below
  // would otherwise allow, until redemption (3 consecutive clean
  // supervised runs at >= the risk tier that triggered the drop) restores
  // 'autonomous'. This is a read-only lookup (getStanding never writes),
  // so a never-seen agent+class costs one indexed SELECT and returns the
  // cold-start default (autonomous) — no different in shape from the
  // budget/tool-risk checks above/below it, both of which also hit this
  // same synchronous getDatabase() (better-sqlite3, not a network call).
  const taskClass = resolveTaskClass(getDatabase(), task.id)
  const standing = getStanding(objective.org_id, task.agent_id, taskClass)
  metadata.task_class = taskClass
  metadata.standing_score = standing.standing_score
  if (standing.status === STANDING_STATUS.SUPERVISED) {
    reasons.push(`Agent standing supervised for task_class "${taskClass}" (score ${standing.standing_score}): ${standing.last_change_reason || 'below supervised threshold'}`)
    metadata.standing_gated = true
    return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
  }

  // 2. Tool-risk / capability-scope check.
  let taskTools = []
  try { taskTools = task.tools_required ? JSON.parse(task.tools_required) : [] } catch { /* malformed */ }

  // 2a. Loop-mode safety redesign (DEVSUITE-DEVMODE Phase 5 prerequisite):
  // when an objective carries a signed capability_scope, it is a
  // DENY-BY-DEFAULT allowlist — any tool outside it forces ESCALATE,
  // fail-closed, regardless of the tool's name. This closes the
  // HIGH_RISK_TOOLS denylist bypass (a loop backend exposing a generic shell
  // tool runs `ssh ...` without ever matching the literal 'ssh_exec'). The
  // signed scope is authoritative: an in-scope tool a human approved into
  // the scope is allowed even if it would be high-risk under the denylist.
  const scope = resolveCapabilityScope(objective)
  if (scope.present) {
    if (scope.malformed) {
      // A declared-but-unparseable scope must fail closed, not fall through
      // to permissive behavior.
      reasons.push('Capability scope present but malformed — failing closed')
      metadata.capability_scope_malformed = true
      return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
    }
    const outOfScope = taskTools.filter(t => !scope.scope.includes(t))
    if (outOfScope.length > 0) {
      reasons.push(`Tools outside signed capability scope: ${outOfScope.join(', ')}`)
      metadata.out_of_scope_tools = outOfScope
      metadata.capability_scope_gated = true
      return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
    }
  } else {
    // 2b. No capability scope (DAG mode / legacy): existing HIGH_RISK_TOOLS
    // denylist behavior, unchanged.
    const highRiskTools = taskTools.filter(t => HIGH_RISK_TOOLS.has(t))
    if (highRiskTools.length > 0) {
      const action = policy.onHighRisk || 'ESCALATE'
      if (action !== 'ACT') {
        reasons.push(`High-risk tools: ${highRiskTools.join(', ')}`)
        return makeResult(action, reasons, metadata, objective, schedule)
      }
    }
  }

  // 2c. Loop mode's upfront cost is unbounded in a way DAG mode's fixed task
  // count isn't, so a SCHEDULED loop-mode objective never gets ACT-by-default
  // — it escalates for a human to start (DEVSUITE-DEVMODE plan). Interactive
  // (unscheduled) loop objectives are not force-escalated by this rule.
  if (objective?.execution_mode === 'loop' && schedule) {
    reasons.push('Scheduled loop-mode objective — escalating (loop cost is unbounded upfront)')
    metadata.loop_scheduled_gated = true
    return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
  }

  // 3. Failure history check
  const failureCount = objective.tasks_failed || 0
  if (failureCount > 0 && task.retry_count >= (policy.maxRetries || 2)) {
    const action = policy.onFailure || 'DEFER'
    reasons.push(`Task retry limit reached (${task.retry_count}/${policy.maxRetries})`)
    return makeResult(action, reasons, metadata, objective, schedule)
  }

  // 4. Consecutive schedule failures
  if (schedule && schedule.consecutive_failures >= Math.max(1, (schedule.max_consecutive_failures || 3) - 1)) {
    reasons.push(`Schedule nearing failure limit (${schedule.consecutive_failures}/${schedule.max_consecutive_failures})`)
    return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
  }

  // 5. DEFCON level check — agents with high DEFCON should escalate more.
  // Two independent DEFCON sources can trigger this: the agent's own static
  // defconLevel (agentDef, set at registry time) and quox#503's instance-
  // wide, server-side DEFCON control (instanceDefcon, org-scoped, settable
  // at runtime via POST /api/v1/safety/defcon). Either one at ORANGE/RED
  // forces ESCALATE — see killSwitchStore.js for the full instance-level
  // table (RED itself is normally refused before an objective even exists,
  // by agentScheduler's pre-dispatch safety gate; this check stays
  // defensive for any other caller of makeDecision that skips that gate).
  const agentDefconHigh = agentDef?.defconLevel && ['ORANGE', 'RED'].includes(agentDef.defconLevel)
  const instanceDefconHigh = instanceDefcon && ['ORANGE', 'RED'].includes(instanceDefcon)
  if (agentDefconHigh || instanceDefconHigh) {
    if (agentDefconHigh) reasons.push(`Agent DEFCON level is ${agentDef.defconLevel}`)
    if (instanceDefconHigh) reasons.push(`Instance DEFCON level is ${instanceDefcon}`)
    metadata.instance_defcon = instanceDefcon || null
    return makeResult(DECISIONS.ESCALATE, reasons, metadata, objective, schedule)
  }

  // All checks passed — ACT
  reasons.push('All autonomy checks passed')
  return makeResult(DECISIONS.ACT, reasons, metadata, objective, schedule)
}

/**
 * Build a decision result and persist it.
 */
function makeResult(decision, reasons, metadata, objective, schedule) {
  const result = {
    decision,
    reason: reasons.join('; '),
    metadata,
    timestamp: new Date().toISOString()
  }

  // Persist decision to DB
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO autonomy_decisions (id, agent_id, org_id, schedule_id, objective_id, task_id, decision, reason, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      ulid(),
      metadata.agent_id,
      objective.org_id,
      schedule?.id || null,
      objective.id,
      metadata.task_id,
      decision,
      result.reason,
      JSON.stringify(metadata)
    )
  } catch (err) {
    console.warn(`[Autonomy] Failed to persist decision (non-fatal): ${err.message}`)
  }

  // Create AEE envelope for the decision
  try {
    createTaskEnvelope({
      type: 'event',
      from: 'service.autonomy',
      to: `agent.${metadata.agent_id}`,
      intent: `quox.autonomy.decision.${decision.toLowerCase()}`,
      payload: { decision, reason: result.reason, schedule_id: schedule?.id },
      corrId: objective.corr_id,
      objectiveId: objective.id,
      taskId: metadata.task_id
    })
  } catch (envelopeErr) {
    console.warn(`[Autonomy] Failed to create AEE envelope (non-fatal): ${envelopeErr.message}`)
  }

  return result
}

/**
 * Create an HITL inbox item for an ESCALATE decision.
 */
export async function escalateToHuman(decision, objective, schedule) {
  const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101'
  const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

  try {
    const orgId = objective.org_id
    const resp = await fetch(`${AUTH_URL}/api/internal/orgs/${orgId}/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({
        kind: 'approval',
        title: `Autonomy: ${objective.title}`,
        body_md: `Autonomous task requires human review.\n\nReason: ${decision.reason}\nAgent: ${decision.metadata.agent_id}\nDecision: ${decision.decision}`,
        payload: {
          what: {
            action: 'let an autonomous task run',
            target: `objective ${objective.id}`,
            summary: `let agent ${decision.metadata.agent_id} carry on with "${String(objective.title || objective.id).slice(0, 100)}"${decision.reason ? ` (${String(decision.reason).slice(0, 100)})` : ''}`,
          },
          source: 'autonomy_escalation',
          objective_id: objective.id,
          schedule_id: schedule?.id,
          agent_id: decision.metadata.agent_id,
          // AGENT-STANDING: carried so the auth service's inbox respond
          // handler can record a correction/override standing event
          // against the right (agent, task_class) on request_changes/deny
          // without a round-trip lookup. task_class mirrors
          // decision.metadata.task_class set by makeDecision()'s standing
          // gate (or undefined if this escalation came from a different
          // check — the inbox handler falls back to resolving it itself).
          task_id: decision.metadata.task_id,
          task_class: decision.metadata.task_class,
          decision: decision.decision,
          reason: decision.reason,
          actions: ['approve', 'deny'],
        },
        assignee_user_id: schedule?.user_id || objective.user_id,
      })
    })

    if (!resp.ok) {
      console.warn(`[Autonomy] Inbox creation failed: HTTP ${resp.status}`)
    }
    return resp.ok
  } catch (err) {
    console.warn(`[Autonomy] Escalation failed (non-fatal): ${err.message}`)
    return false
  }
}

/**
 * Get recent autonomy decisions for an org.
 */
export function getDecisionHistory(orgId, { limit = 50, agentId, decision } = {}) {
  const db = getDatabase()
  let sql = 'SELECT * FROM autonomy_decisions WHERE org_id = ?'
  const params = [orgId]

  if (agentId) {
    sql += ' AND agent_id = ?'
    params.push(agentId)
  }
  if (decision) {
    sql += ' AND decision = ?'
    params.push(decision)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  return db.prepare(sql).all(...params)
}

/**
 * Get decision statistics for an org.
 */
export function getDecisionStats(orgId, { since } = {}) {
  const db = getDatabase()
  let sql = `
    SELECT
      decision,
      agent_id,
      COUNT(*) as count
    FROM autonomy_decisions
    WHERE org_id = ?
  `
  const params = [orgId]

  if (since) {
    sql += ' AND created_at >= ?'
    params.push(since)
  }

  sql += ' GROUP BY decision, agent_id ORDER BY count DESC'

  const rows = db.prepare(sql).all(...params)

  // Also get totals
  let totalSql = `
    SELECT
      decision,
      COUNT(*) as count
    FROM autonomy_decisions
    WHERE org_id = ?
  `
  const totalParams = [orgId]
  if (since) {
    totalSql += ' AND created_at >= ?'
    totalParams.push(since)
  }
  totalSql += ' GROUP BY decision'
  const totals = db.prepare(totalSql).all(...totalParams)

  return {
    byAgent: rows,
    totals: Object.fromEntries(totals.map(r => [r.decision, r.count]))
  }
}
