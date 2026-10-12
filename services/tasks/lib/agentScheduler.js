// Agent Scheduler — per-agent autonomous schedule management
// Phase 7.A: Agent Autonomy Framework
// Extends the teamScheduler pattern for individual agent autonomy
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { getNextCronRun, isValidCron } from './cronParser.js'
import { decomposeObjective } from './decomposer.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { makeDecision, escalateToHuman, DECISIONS } from './autonomyDecision.js'
import { dispatchObjective } from './objectiveDispatch.js'
import { checkSafetyGate } from './safetyGate.js'
import { startAdaptiveInterval } from './configResolver.js'

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_MS || '5000', 10)
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

let pollHandle = null

// --- CRUD ---

export function createAgentSchedule(orgId, userId, agentId, data) {
  const db = getDatabase()

  if (!data.name?.trim()) throw new Error('Schedule name is required')
  if (!data.cronExpression || !isValidCron(data.cronExpression)) throw new Error('Invalid cron expression')
  if (!data.taskTemplate?.prompt?.trim()) throw new Error('Task template prompt is required')

  const id = ulid()
  const nextTrigger = getNextCronRun(data.cronExpression)

  const escalationPolicy = data.escalationPolicy || {}
  const budget = data.budget || {}

  db.prepare(`
    INSERT INTO agent_schedules (id, agent_id, org_id, user_id, name, trigger_type, cron_expression, timezone,
      task_template_json, escalation_policy_json, budget_json, enabled, next_trigger_at,
      max_consecutive_failures, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id, agentId, orgId, userId,
    data.name.trim(),
    data.triggerType || 'cron',
    data.cronExpression.trim(),
    data.timezone || 'UTC',
    JSON.stringify(data.taskTemplate),
    JSON.stringify(escalationPolicy),
    JSON.stringify(budget),
    nextTrigger ? nextTrigger.toISOString() : null,
    data.maxConsecutiveFailures || 3
  )

  return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(id)
}

export function updateAgentSchedule(orgId, scheduleId, updates) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
  if (!existing) throw new Error('Schedule not found')

  const fields = []
  const values = []

  if (updates.name !== undefined) {
    if (!updates.name.trim()) throw new Error('Schedule name is required')
    fields.push('name = ?')
    values.push(updates.name.trim())
  }
  if (updates.cronExpression !== undefined) {
    if (!isValidCron(updates.cronExpression)) throw new Error('Invalid cron expression')
    fields.push('cron_expression = ?')
    values.push(updates.cronExpression.trim())
  }
  if (updates.timezone !== undefined) {
    fields.push('timezone = ?')
    values.push(updates.timezone)
  }
  if (updates.taskTemplate !== undefined) {
    if (!updates.taskTemplate.prompt?.trim()) throw new Error('Task template prompt is required')
    fields.push('task_template_json = ?')
    values.push(JSON.stringify(updates.taskTemplate))
  }
  if (updates.escalationPolicy !== undefined) {
    fields.push('escalation_policy_json = ?')
    values.push(JSON.stringify(updates.escalationPolicy))
  }
  if (updates.budget !== undefined) {
    fields.push('budget_json = ?')
    values.push(JSON.stringify(updates.budget))
  }
  if (updates.maxConsecutiveFailures !== undefined) {
    fields.push('max_consecutive_failures = ?')
    values.push(Number(updates.maxConsecutiveFailures))
  }

  if (fields.length === 0) throw new Error('No fields to update')

  const cronExpr = updates.cronExpression || existing.cron_expression
  const nextTrigger = getNextCronRun(cronExpr)
  fields.push('next_trigger_at = ?')
  values.push(nextTrigger ? nextTrigger.toISOString() : null)
  fields.push("updated_at = datetime('now')")

  values.push(scheduleId, orgId)
  db.prepare(`UPDATE agent_schedules SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`).run(...values)
  return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(scheduleId)
}

export function deleteAgentSchedule(orgId, scheduleId) {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM agent_schedules WHERE id = ? AND org_id = ?').run(scheduleId, orgId)
  return result.changes > 0
}

export function getAgentSchedule(orgId, scheduleId) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
}

export function listAgentSchedules(orgId, agentId) {
  const db = getDatabase()
  if (agentId) {
    return db.prepare('SELECT * FROM agent_schedules WHERE org_id = ? AND agent_id = ? ORDER BY created_at DESC').all(orgId, agentId)
  }
  return db.prepare('SELECT * FROM agent_schedules WHERE org_id = ? ORDER BY created_at DESC').all(orgId)
}

export function toggleAgentSchedule(orgId, scheduleId, enabled) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
  if (!existing) throw new Error('Schedule not found')

  let nextTrigger = null
  if (enabled && existing.cron_expression) {
    nextTrigger = getNextCronRun(existing.cron_expression)
  }

  db.prepare(`
    UPDATE agent_schedules SET enabled = ?, next_trigger_at = ?, consecutive_failures = 0, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `).run(enabled ? 1 : 0, nextTrigger ? nextTrigger.toISOString() : null, scheduleId, orgId)

  return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(scheduleId)
}

// --- Budget enforcement ---

export function getAgentDailyUsage(orgId, agentId) {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10)
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(tokens_used), 0) as total_tokens,
      COALESCE(SUM(tool_calls_used), 0) as total_tool_calls,
      COUNT(*) as objective_count
    FROM objectives
    WHERE org_id = ? AND orchestrator_agent_id = ? AND triggered_by = 'agent_schedule'
    AND created_at >= ? AND created_at < date(?, '+1 day')
  `).get(orgId, agentId, today, today)

  return {
    tokens: row?.total_tokens || 0,
    toolCalls: row?.total_tool_calls || 0,
    objectiveCount: row?.objective_count || 0,
  }
}

export function checkAgentBudget(orgId, agentId, budgetConfig) {
  if (!budgetConfig || Object.keys(budgetConfig).length === 0) {
    return { allowed: true, reason: null }
  }

  const usage = getAgentDailyUsage(orgId, agentId)

  if (budgetConfig.maxDailyTokens && usage.tokens >= budgetConfig.maxDailyTokens) {
    return { allowed: false, reason: `Daily token budget exceeded (${usage.tokens}/${budgetConfig.maxDailyTokens})` }
  }
  if (budgetConfig.maxDailyToolCalls && usage.toolCalls >= budgetConfig.maxDailyToolCalls) {
    return { allowed: false, reason: `Daily tool call budget exceeded` }
  }
  if (budgetConfig.maxDailyRuns && usage.objectiveCount >= budgetConfig.maxDailyRuns) {
    return { allowed: false, reason: `Daily run limit reached (${usage.objectiveCount}/${budgetConfig.maxDailyRuns})` }
  }

  // Generate warnings when approaching limits (80%+)
  const warnings = []
  if (budgetConfig.maxDailyTokens && usage.tokens >= budgetConfig.maxDailyTokens * 0.8) {
    warnings.push(`${Math.round(usage.tokens / budgetConfig.maxDailyTokens * 100)}% daily tokens used`)
  }
  if (budgetConfig.maxDailyRuns && usage.objectiveCount >= budgetConfig.maxDailyRuns * 0.8) {
    warnings.push(`${Math.round(usage.objectiveCount / budgetConfig.maxDailyRuns * 100)}% daily runs used`)
  }

  return { allowed: true, reason: null, warnings }
}

// --- Trigger loop ---

export async function checkDueAgentSchedules() {
  let db
  try {
    db = getDatabase()
  } catch {
    return
  }

  const now = new Date().toISOString()
  const dueSchedules = db.prepare(`
    SELECT * FROM agent_schedules
    WHERE enabled = 1 AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
  `).all(now)

  for (const schedule of dueSchedules) {
    try {
      await triggerAgentSchedule(schedule)
    } catch (err) {
      console.error(`[AgentScheduler] Failed to trigger schedule ${schedule.id}: ${err.message}`)

      const handleFailure = db.transaction((scheduleId) => {
        db.prepare(`
          UPDATE agent_schedules SET consecutive_failures = consecutive_failures + 1, last_status = 'error', updated_at = datetime('now')
          WHERE id = ?
        `).run(scheduleId)
        const updated = db.prepare('SELECT consecutive_failures, max_consecutive_failures FROM agent_schedules WHERE id = ?').get(scheduleId)
        if (updated && updated.consecutive_failures >= updated.max_consecutive_failures) {
          db.prepare("UPDATE agent_schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(scheduleId)
          console.warn(`[AgentScheduler] Auto-disabled schedule ${scheduleId} after ${updated.consecutive_failures} consecutive failures`)
        }
      })
      handleFailure(schedule.id)
    }
  }
}

export async function triggerAgentSchedule(schedule) {
  const db = getDatabase()

  // Parse configs
  const budgetConfig = JSON.parse(schedule.budget_json || '{}')
  const escalationPolicy = JSON.parse(schedule.escalation_policy_json || '{}')
  const taskTemplate = JSON.parse(schedule.task_template_json || '{}')

  // Budget check
  const budgetCheck = checkAgentBudget(schedule.org_id, schedule.agent_id, budgetConfig)
  if (!budgetCheck.allowed) {
    console.log(`[AgentScheduler] Budget blocked for schedule ${schedule.id}: ${budgetCheck.reason}`)
    advanceNextTrigger(schedule)
    return
  }

  // quox#503: kill switch / DEFCON pre-dispatch gate. A per-agent E-STOP or
  // instance DEFCON RED means "do not dispatch" — same skip-entirely
  // handling as a budget block (no objective row, schedule just advances).
  // DEFCON ORANGE is NOT blocked here: it forces ESCALATE further down
  // (instanceDefcon is threaded into makeDecision below), because
  // escalation needs an objective + a human inbox item to attach to, which
  // don't exist until after this point. checkSafetyGate fails CLOSED on any
  // collector-unreachable condition (see safetyGate.js) — an unreadable
  // halt state is treated as blocked, same posture as this file's own
  // budget check failing safe.
  const safetyGate = await checkSafetyGate(schedule.org_id, schedule.agent_id)
  if (safetyGate.blocked) {
    console.log(`[AgentScheduler] Safety gate blocked for schedule ${schedule.id}: ${safetyGate.reason}`)
    advanceNextTrigger(schedule)
    return
  }

  // Create objective
  const objectiveId = ulid()
  const corrId = `AGT_${objectiveId}`

  db.prepare(`
    INSERT INTO objectives (id, org_id, user_id, title, description, max_tokens, max_tool_calls, max_duration_ms,
      corr_id, orchestrator_agent_id, triggered_by, schedule_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent_schedule', ?, datetime('now'))
  `).run(
    objectiveId, schedule.org_id, schedule.user_id,
    taskTemplate.title || `${schedule.name} (${schedule.agent_id})`,
    taskTemplate.description || null,
    budgetConfig.maxTokensPerRun || 100000,
    budgetConfig.maxToolCallsPerRun || 50,
    budgetConfig.maxDurationMs || 300000,
    corrId,
    schedule.agent_id,
    schedule.id
  )

  // Create single task from template
  const taskId = ulid()
  db.prepare(`
    INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', datetime('now'))
  `).run(
    taskId, objectiveId, schedule.org_id,
    taskTemplate.title || schedule.name,
    schedule.agent_id,
    taskTemplate.prompt
  )

  db.prepare("UPDATE objectives SET task_count = 1, status = 'running', started_at = datetime('now') WHERE id = ?")
    .run(objectiveId)

  // AEE envelope
  createTaskEnvelope({
    type: 'event', from: 'service.agent-scheduler', to: `agent.${schedule.agent_id}`,
    intent: 'quox.autonomy.schedule.triggered',
    payload: { schedule_id: schedule.id, objective_id: objectiveId, agent_id: schedule.agent_id },
    corrId, objectiveId,
  })

  // Make ACT/ESCALATE/DEFER decision
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)

  const autonomyDecision = makeDecision({
    task,
    objective,
    schedule: { ...schedule, escalation_policy: escalationPolicy },
    agentDef: null, // caller can inject from agentRegistry
    budgetStatus: budgetCheck,
    // quox#503: instance-wide DEFCON read moments ago by the pre-dispatch
    // gate above. ORANGE forces ESCALATE inside makeDecision, mirroring how
    // it already treats a per-agent agentDef.defconLevel of ORANGE/RED.
    instanceDefcon: safetyGate.defcon,
  })

  if (autonomyDecision.decision === DECISIONS.DEFER) {
    // Skip this run
    db.prepare("UPDATE objectives SET status = 'deferred', completed_at = datetime('now') WHERE id = ?").run(objectiveId)
    db.prepare("UPDATE tasks SET status = 'skipped', result = ?, completed_at = datetime('now') WHERE id = ?")
      .run(`Deferred: ${autonomyDecision.reason}`, taskId)
    console.log(`[AgentScheduler] DEFER schedule ${schedule.id}: ${autonomyDecision.reason}`)
  } else if (autonomyDecision.decision === DECISIONS.ESCALATE) {
    // Pause and create inbox item
    db.prepare("UPDATE objectives SET status = 'pending_approval' WHERE id = ?").run(objectiveId)
    await escalateToHuman(autonomyDecision, objective, schedule)
    console.log(`[AgentScheduler] ESCALATE schedule ${schedule.id}: ${autonomyDecision.reason}`)
  } else {
    // ACT — dispatch immediately via the shared QuoxFlow dispatch path
    // (same helper used by the human approve-plan HTTP endpoint and
    // teamScheduler auto-approve). Previously this branch only left the
    // objective's status at 'running' with no quoxflow_execution_id and
    // no status poller attached, so nothing ever executed it — the
    // reaper would orphan it as 'failed' ~2 minutes later.
    console.log(`[AgentScheduler] ACT schedule ${schedule.id} -> objective ${objectiveId}`)
    try {
      const dispatchResult = await dispatchObjective(objectiveId)
      if (!dispatchResult.success) {
        console.error(`[AgentScheduler] Dispatch failed for objective ${objectiveId}: ${dispatchResult.error}`)
      }
    } catch (err) {
      console.error(`[AgentScheduler] Dispatch threw for objective ${objectiveId}: ${err.message}`)
    }
  }

  // Update schedule tracking
  advanceNextTrigger(schedule, objectiveId, autonomyDecision.decision === DECISIONS.DEFER ? 'deferred' : undefined)
}

function advanceNextTrigger(schedule, objectiveId, statusOverride) {
  try {
    const db = getDatabase()
    const nextTrigger = getNextCronRun(schedule.cron_expression)
    const status = statusOverride || (objectiveId ? 'triggered' : 'skipped')
    db.prepare(`
      UPDATE agent_schedules SET
        last_triggered_at = datetime('now'),
        next_trigger_at = ?,
        last_objective_id = ?,
        last_status = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextTrigger ? nextTrigger.toISOString() : null,
      objectiveId || null,
      status,
      schedule.id
    )
  } catch (err) {
    console.warn(`[AgentScheduler] advanceNextTrigger failed (non-fatal): ${err.message}`)
  }
}

// --- Summary ---

export function getAutonomySummary(orgId) {
  const db = getDatabase()

  const schedules = db.prepare(`
    SELECT agent_id, enabled, last_status, next_trigger_at, consecutive_failures
    FROM agent_schedules WHERE org_id = ?
  `).all(orgId)

  const today = new Date().toISOString().slice(0, 10)
  const todayRuns = db.prepare(`
    SELECT orchestrator_agent_id as agent_id, status, COUNT(*) as count
    FROM objectives
    WHERE org_id = ? AND triggered_by = 'agent_schedule' AND created_at >= ?
    GROUP BY orchestrator_agent_id, status
  `).all(orgId, today)

  const recentDecisions = db.prepare(`
    SELECT decision, COUNT(*) as count
    FROM autonomy_decisions
    WHERE org_id = ? AND created_at >= ?
    GROUP BY decision
  `).all(orgId, today)

  return {
    activeSchedules: schedules.filter(s => s.enabled).length,
    totalSchedules: schedules.length,
    schedules,
    todayRuns,
    todayDecisions: Object.fromEntries(recentDecisions.map(r => [r.decision, r.count]))
  }
}

// --- Start / Stop ---

export function startAgentScheduler() {
  if (pollHandle) return
  console.log(`[AgentScheduler] Starting (poll every ${POLL_INTERVAL_MS}ms)`)
  // SETEC S3: SCHEDULER_POLL_MS stored setting re-read each tick (live, no restart)
  pollHandle = startAdaptiveInterval('SCHEDULER_POLL_MS', POLL_INTERVAL_MS, () => {
    checkDueAgentSchedules().catch(err => {
      console.error('[AgentScheduler] Poll error:', err.message)
    })
  })
}

export function stopAgentScheduler() {
  if (pollHandle) {
    pollHandle.stop()
    pollHandle = null
  }
  console.log('[AgentScheduler] Stopped')
}
