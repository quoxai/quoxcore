// Team Schedule Scheduler — CRUD + trigger loop + budget enforcement
// Stream E4: Autonomous Workflows
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { getNextCronRun, isValidCron } from './cronParser.js'
import { decomposeObjective } from './decomposer.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { getTeamDefinition, cleanupOldInstances } from './teamLoader.js'
import { dispatchObjective } from './objectiveDispatch.js'
import { startAdaptiveInterval } from './configResolver.js'

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_MS || '5000', 10)
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

let pollHandle = null
let cleanupHandle = null

/**
 * OE-5: Check if a schedule has an active (non-terminal) objective.
 * Used for overlap prevention — don't trigger if previous run is still going.
 * @param {string} scheduleId
 * @returns {boolean}
 */
export function hasActiveObjectiveForSchedule(scheduleId) {
  const db = getDatabase()
  const active = db.prepare(`
    SELECT id FROM objectives
    WHERE schedule_id = ? AND status IN ('pending', 'decomposed', 'running', 'paused')
    LIMIT 1
  `).get(scheduleId)
  return !!active
}
const CLEANUP_INTERVAL_MS = 3600000 // 1 hour

// --- CRUD ---

export function createSchedule(orgId, userId, teamId, data) {
  const db = getDatabase()

  if (!data.name || !data.name.trim()) {
    throw new Error('Schedule name is required')
  }
  if (!data.cronExpression || !isValidCron(data.cronExpression)) {
    throw new Error('Invalid cron expression')
  }

  const template = data.objectiveTemplate || {}
  if (!template.title || !template.title.trim()) {
    throw new Error('Objective template title is required')
  }

  // Verify team exists
  const teamDef = getTeamDefinition(orgId, teamId)
  if (!teamDef) throw new Error(`Team '${teamId}' not found`)

  const id = ulid()
  const nextTrigger = getNextCronRun(data.cronExpression)

  db.prepare(`
    INSERT INTO team_schedules (id, team_definition_id, org_id, user_id, name, trigger_type, cron_expression, timezone, objective_template_json, enabled, next_trigger_at, max_consecutive_failures, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'schedule', ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id, teamId, orgId, userId,
    data.name.trim(),
    data.cronExpression.trim(),
    data.timezone || 'UTC',
    JSON.stringify(template),
    nextTrigger ? nextTrigger.toISOString() : null,
    data.maxConsecutiveFailures || 3
  )

  return db.prepare('SELECT * FROM team_schedules WHERE id = ?').get(id)
}

export function updateSchedule(orgId, scheduleId, updates) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM team_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
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

  if (updates.objectiveTemplate !== undefined) {
    if (!updates.objectiveTemplate.title || !updates.objectiveTemplate.title.trim()) {
      throw new Error('Objective template title is required')
    }
    fields.push('objective_template_json = ?')
    values.push(JSON.stringify(updates.objectiveTemplate))
  }

  if (updates.maxConsecutiveFailures !== undefined) {
    fields.push('max_consecutive_failures = ?')
    values.push(Number(updates.maxConsecutiveFailures))
  }

  if (fields.length === 0) throw new Error('No fields to update')

  // Recalculate next_trigger_at if cron changed
  const cronExpr = updates.cronExpression || existing.cron_expression
  const nextTrigger = getNextCronRun(cronExpr)
  fields.push('next_trigger_at = ?')
  values.push(nextTrigger ? nextTrigger.toISOString() : null)

  fields.push("updated_at = datetime('now')")
  values.push(scheduleId, orgId)

  db.prepare(`UPDATE team_schedules SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`).run(...values)
  return db.prepare('SELECT * FROM team_schedules WHERE id = ?').get(scheduleId)
}

export function deleteSchedule(orgId, scheduleId) {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM team_schedules WHERE id = ? AND org_id = ?').run(scheduleId, orgId)
  return result.changes > 0
}

export function getSchedule(orgId, scheduleId) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM team_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
}

export function listSchedules(orgId, teamId) {
  const db = getDatabase()
  if (teamId) {
    return db.prepare('SELECT * FROM team_schedules WHERE org_id = ? AND team_definition_id = ? ORDER BY created_at DESC').all(orgId, teamId)
  }
  return db.prepare('SELECT * FROM team_schedules WHERE org_id = ? ORDER BY created_at DESC').all(orgId)
}

export function toggleSchedule(orgId, scheduleId, enabled) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM team_schedules WHERE id = ? AND org_id = ?').get(scheduleId, orgId)
  if (!existing) throw new Error('Schedule not found')

  const enabledInt = enabled ? 1 : 0
  let nextTrigger = null
  if (enabled && existing.cron_expression) {
    nextTrigger = getNextCronRun(existing.cron_expression)
  }

  db.prepare(`
    UPDATE team_schedules SET enabled = ?, next_trigger_at = ?, consecutive_failures = 0, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `).run(enabledInt, nextTrigger ? nextTrigger.toISOString() : null, scheduleId, orgId)

  return db.prepare('SELECT * FROM team_schedules WHERE id = ?').get(scheduleId)
}

// --- Budget enforcement ---

export function getDailyUsage(orgId, teamId) {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(tokens_used), 0) as total_tokens,
      COALESCE(SUM(tool_calls_used), 0) as total_tool_calls,
      COUNT(*) as objective_count
    FROM objectives
    WHERE org_id = ? AND team_id = ? AND triggered_by = 'schedule'
    AND created_at >= ? AND created_at < date(?, '+1 day')
  `).get(orgId, teamId, today, today)

  return {
    tokens: row?.total_tokens || 0,
    toolCalls: row?.total_tool_calls || 0,
    objectiveCount: row?.objective_count || 0,
  }
}

export function checkAutonomyBudget(orgId, teamId, policies) {
  if (!policies) return { allowed: true, reason: null }

  const usage = getDailyUsage(orgId, teamId)

  if (policies.maxDailyTokens && usage.tokens >= policies.maxDailyTokens) {
    return { allowed: false, reason: `Daily token budget exceeded (${usage.tokens}/${policies.maxDailyTokens})` }
  }

  if (policies.maxDailyToolCalls && usage.toolCalls >= policies.maxDailyToolCalls) {
    return { allowed: false, reason: `Daily tool call budget exceeded (${usage.toolCalls}/${policies.maxDailyToolCalls})` }
  }

  if (policies.maxUnattendedObjectives && usage.objectiveCount >= policies.maxUnattendedObjectives) {
    return { allowed: false, reason: `Max unattended objectives reached (${usage.objectiveCount}/${policies.maxUnattendedObjectives})` }
  }

  return { allowed: true, reason: null }
}

// --- Trigger loop ---

export async function checkDueSchedules() {
  let db
  try {
    db = getDatabase()
  } catch {
    return // DB not initialized yet
  }

  const now = new Date().toISOString()
  const dueSchedules = db.prepare(`
    SELECT * FROM team_schedules
    WHERE enabled = 1 AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
  `).all(now)

  for (const schedule of dueSchedules) {
    try {
      await triggerSchedule(schedule)
    } catch (err) {
      console.error(`[TeamScheduler] Failed to trigger schedule ${schedule.id}: ${err.message}`)
      // S2: Atomic failure increment + auto-disable check in a transaction
      const handleFailure = db.transaction((scheduleId) => {
        db.prepare(`
          UPDATE team_schedules SET consecutive_failures = consecutive_failures + 1, last_status = 'error', updated_at = datetime('now')
          WHERE id = ?
        `).run(scheduleId)
        const updated = db.prepare('SELECT consecutive_failures, max_consecutive_failures FROM team_schedules WHERE id = ?').get(scheduleId)
        if (updated && updated.consecutive_failures >= updated.max_consecutive_failures) {
          db.prepare("UPDATE team_schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(scheduleId)
          console.warn(`[TeamScheduler] Auto-disabled schedule ${scheduleId} after ${updated.consecutive_failures} consecutive failures`)
        }
      })
      handleFailure(schedule.id)
    }
  }
}

export async function triggerSchedule(schedule) {
  const db = getDatabase()

  // Look up team definition to get autonomy policies
  const teamDef = getTeamDefinition(schedule.org_id, schedule.team_definition_id)
  if (!teamDef) {
    throw new Error(`Team '${schedule.team_definition_id}' not found`)
  }

  const autonomyPolicies = teamDef.manifest?.autonomyPolicies || {}

  // OE-5: Overlap prevention — skip if previous run still active
  if (!teamDef.manifest?.policies?.allowOverlap && hasActiveObjectiveForSchedule(schedule.id)) {
    console.log(`[TeamScheduler] Skipping schedule ${schedule.id} — previous run still active`)
    const nextTrigger = getNextCronRun(schedule.cron_expression)
    db.prepare("UPDATE team_schedules SET next_trigger_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(nextTrigger ? nextTrigger.toISOString() : null, schedule.id)
    return
  }

  // Check autonomy budget
  const budgetCheck = checkAutonomyBudget(schedule.org_id, schedule.team_definition_id, autonomyPolicies)
  if (!budgetCheck.allowed) {
    console.log(`[TeamScheduler] Budget blocked for schedule ${schedule.id}: ${budgetCheck.reason}`)
    // Advance next_trigger_at even when blocked (don't re-trigger same slot)
    const nextTrigger = getNextCronRun(schedule.cron_expression)
    db.prepare("UPDATE team_schedules SET next_trigger_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(nextTrigger ? nextTrigger.toISOString() : null, schedule.id)
    return
  }

  // Parse objective template
  const template = JSON.parse(schedule.objective_template_json || '{}')

  // Browser automation templates go to the screencap service, not the tasks decomposer
  if (template.type === 'browser_automation') {
    await triggerBrowserAutomation(schedule, template, db)
    return
  }

  const objectiveId = ulid()
  const corrId = `OBJ_${objectiveId}`
  const orchestratorAgentId = teamDef.manifest?.orchestrator?.agentId || 'quox'
  const policies = teamDef.manifest?.policies || {}

  // Create objective from template
  db.prepare(`
    INSERT INTO objectives (id, org_id, user_id, title, description, max_tokens, max_tool_calls, max_duration_ms,
      require_approval_before_start, checkpoint_after_each_task, corr_id, team_id, orchestrator_agent_id,
      triggered_by, schedule_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'schedule', ?, datetime('now'))
  `).run(
    objectiveId, schedule.org_id, schedule.user_id,
    template.title || 'Scheduled objective',
    template.description || null,
    policies.maxBudgetTokens || 200000,
    policies.maxBudgetToolCalls || 100,
    policies.maxDurationMs || 600000,
    autonomyPolicies.canStartWithoutApproval ? 0 : (policies.requireApprovalBeforeStart ? 1 : 0),
    policies.checkpointAfterEachTask ? 1 : 0,
    corrId,
    schedule.team_definition_id,
    orchestratorAgentId,
    schedule.id
  )

  // Create AEE envelope
  createTaskEnvelope({
    type: 'event', from: 'service.scheduler', to: 'service.tasks',
    intent: TASK_INTENTS.TEAM_SCHEDULE_TRIGGERED,
    payload: { schedule_id: schedule.id, objective_id: objectiveId, team_id: schedule.team_definition_id },
    corrId, objectiveId,
  })

  console.log(`[TeamScheduler] Triggered schedule ${schedule.id} -> objective ${objectiveId}`)

  // Auto-decompose
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
  if (objective) {
    try {
      await decomposeObjective(objective)

      // Auto-approve if canStartWithoutApproval — dispatch via the shared
      // QuoxFlow dispatch path (same helper used by the human approve-plan
      // HTTP endpoint and agentScheduler ACT decisions). Previously this
      // only flipped the objective's status to 'running' with no
      // quoxflow_execution_id and no status poller attached, so nothing
      // ever executed it — the reaper would orphan it as 'failed' ~2
      // minutes later.
      if (autonomyPolicies.canStartWithoutApproval) {
        const decomposed = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
        if (decomposed && decomposed.status === 'decomposed') {
          console.log(`[TeamScheduler] Auto-approving objective ${objectiveId}`)
          const dispatchResult = await dispatchObjective(objectiveId)
          if (dispatchResult.success) {
            console.log(`[TeamScheduler] Auto-approved objective ${objectiveId}`)
          } else {
            console.error(`[TeamScheduler] Auto-approve dispatch failed for objective ${objectiveId}: ${dispatchResult.error}`)
          }
        }
      }
    } catch (err) {
      console.error(`[TeamScheduler] Decomposition failed for objective ${objectiveId}: ${err.message}`)
      db.prepare("UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?")
        .run(`Team-scheduled decomposition failed: ${err.message}`, objectiveId)
    }
  }

  // Update schedule tracking
  const nextTrigger = getNextCronRun(schedule.cron_expression)
  db.prepare(`
    UPDATE team_schedules SET
      last_triggered_at = datetime('now'),
      next_trigger_at = ?,
      last_objective_id = ?,
      last_status = 'triggered',
      updated_at = datetime('now')
    WHERE id = ?
  `).run(nextTrigger ? nextTrigger.toISOString() : null, objectiveId, schedule.id)
}

// --- Browser automation trigger ---

async function triggerBrowserAutomation(schedule, template, db) {
  const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300'
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''

  const headers = {
    'Content-Type': 'application/json',
    'x-service-key': serviceKey,
    'x-org-id': schedule.org_id,
  }

  try {
    // Step 1: Create the browser objective
    const createRes = await fetch(`${screencapUrl}/api/browser-objectives?org_id=${schedule.org_id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: template.url,
        intent: template.intent || template.title || template.description,
        credential_id: template.credential_id || null,
        needs_login: template.needs_login || false,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!createRes.ok) {
      throw new Error(`Create failed: ${createRes.status}`)
    }
    const { objective } = await createRes.json()
    const objectiveId = objective.id

    // Step 2: Plan (uses saved steps if available, otherwise auto-generates)
    const planBody = template.steps?.length > 0
      ? { steps: template.steps }
      : {}

    const planRes = await fetch(`${screencapUrl}/api/browser-objectives/${objectiveId}/plan?org_id=${schedule.org_id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(planBody),
      signal: AbortSignal.timeout(30000),
    })
    if (!planRes.ok) {
      throw new Error(`Plan failed: ${planRes.status}`)
    }

    // Step 3: Execute
    const execRes = await fetch(`${screencapUrl}/api/browser-objectives/${objectiveId}/execute?org_id=${schedule.org_id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session_id: `sched_${schedule.id}_${Date.now()}` }),
      signal: AbortSignal.timeout(15000),
    })
    if (!execRes.ok) {
      throw new Error(`Execute failed: ${execRes.status}`)
    }

    console.log(`[TeamScheduler] Browser automation triggered: objective ${objectiveId} for schedule ${schedule.id}`)

    // Update schedule status
    const nextTrigger = getNextCronRun(schedule.cron_expression)
    db.prepare(`
      UPDATE team_schedules
      SET last_triggered_at = datetime('now'), next_trigger_at = ?, last_status = 'triggered',
          consecutive_failures = 0, last_objective_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextTrigger ? nextTrigger.toISOString() : null, objectiveId, schedule.id)
  } catch (err) {
    console.error(`[TeamScheduler] Browser automation trigger failed for schedule ${schedule.id}:`, err.message)
    throw err
  }
}

// --- Completion notification ---

export async function notifyScheduledCompletion(objective, status) {
  // Send notification via auth service internal inbox API
  try {
    const message = status === 'completed'
      ? `Scheduled objective "${objective.title}" completed successfully.`
      : `Scheduled objective "${objective.title}" finished with status: ${status}.`

    const orgId = objective.org_id
    await fetch(`${AUTH_URL}/api/internal/orgs/${orgId}/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({
        kind: 'info',
        title: `Schedule: ${objective.title}`,
        body_md: message,
        payload: {
          source: 'schedule_completion',
          objective_id: objective.id,
          schedule_id: objective.schedule_id,
          status,
          team_id: objective.team_id,
        },
        assignee_user_id: objective.user_id,
      }),
    })
  } catch (err) {
    console.warn(`[TeamScheduler] Notification failed (non-fatal): ${err.message}`)
  }
}

// --- Start / Stop ---

export function startTeamScheduler() {
  if (pollHandle) return
  console.log(`[TeamScheduler] Starting (poll every ${POLL_INTERVAL_MS}ms)`)
  // SETEC S3: SCHEDULER_POLL_MS stored setting re-read each tick (live, no restart)
  pollHandle = startAdaptiveInterval('SCHEDULER_POLL_MS', POLL_INTERVAL_MS, () => {
    checkDueSchedules().catch(err => {
      console.error('[TeamScheduler] Poll error:', err.message)
    })
  })

  // Periodic cleanup of old team instances (keep last 5 per team)
  cleanupHandle = setInterval(() => {
    try {
      const cleaned = cleanupOldInstances(5)
      if (cleaned > 0) console.log(`[TeamScheduler] Cleaned up ${cleaned} old team instance(s)`)
    } catch (err) {
      console.error('[TeamScheduler] Instance cleanup error:', err.message)
    }
  }, CLEANUP_INTERVAL_MS)
}

export function stopTeamScheduler() {
  if (pollHandle) {
    pollHandle.stop()
    pollHandle = null
  }
  if (cleanupHandle) {
    clearInterval(cleanupHandle)
    cleanupHandle = null
  }
  console.log('[TeamScheduler] Stopped')
}
