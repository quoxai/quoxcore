// calendarEvents.js — AQ-9B Calendar-Q Phase 1 (backend only)
//
// org+user scoped CRUD over calendar_events (migrations/030-calendar-events.sql).
// Recurring events delegate execution to the EXISTING tasks-service schedulers
// (team_schedules / agent_schedules — same poll loop + dispatchObjective path
// already used by teamScheduler.js / agentScheduler.js). One-off events with
// reminders are checked by checkDueCalendarEvents(), which creates an
// objective/task pair and dispatches it via the same dispatchObjective() used
// everywhere else in this service — no new execution engine, no browser
// timers (CLAUDE.md zero-tolerance rule).
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { isValidCron, getNextCronRun } from './cronParser.js'
import { naturalLanguageToCron } from './nlCron.js'
import { createAgentSchedule, toggleAgentSchedule } from './agentScheduler.js'
import { toggleSchedule as toggleTeamSchedule } from './teamScheduler.js'
import { dispatchObjective } from './objectiveDispatch.js'

const POLL_INTERVAL_MS = parseInt(process.env.CALENDAR_REMINDER_POLL_MS || '30000', 10)

let pollHandle = null

function parseReminders(reminders) {
  if (reminders === undefined || reminders === null) return []
  if (!Array.isArray(reminders)) throw new Error('reminders must be an array')
  return reminders.map(r => {
    const minutesBefore = Number(r?.minutesBefore)
    if (!Number.isFinite(minutesBefore) || minutesBefore < 0) {
      throw new Error('Each reminder requires a non-negative minutesBefore')
    }
    return { minutesBefore }
  })
}

function resolveRecurrenceCron(data) {
  if (data.recurrenceCron !== undefined && data.recurrenceCron !== null && data.recurrenceCron !== '') {
    if (!isValidCron(data.recurrenceCron)) throw new Error('Invalid recurrence cron expression')
    return data.recurrenceCron.trim()
  }
  if (data.recurrenceText) {
    const cron = naturalLanguageToCron(data.recurrenceText)
    if (!cron || !isValidCron(cron)) {
      throw new Error(`Could not parse recurrence text into a valid schedule: "${data.recurrenceText}"`)
    }
    return cron
  }
  return null
}

// Org-level (no team) recurring schedule — mirrors the inline INSERT used by
// the existing POST /api/schedules route in server.js (team_definition_id
// NULL). Duplicated locally (rather than imported) because teamScheduler.js's
// createSchedule() requires a team to already exist via getTeamDefinition();
// this is the same org-level shape server.js already writes for schedules
// with no team_id.
function createLinkedTeamSchedule(orgId, userId, { name, cronExpression, timezone, objectiveTemplate }) {
  const db = getDatabase()
  const id = ulid()
  const nextTrigger = getNextCronRun(cronExpression)

  db.prepare(`
    INSERT INTO team_schedules (id, team_definition_id, org_id, user_id, name, trigger_type, cron_expression, timezone, objective_template_json, enabled, next_trigger_at, max_consecutive_failures, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, 'schedule', ?, ?, ?, 1, ?, 3, datetime('now'), datetime('now'))
  `).run(
    id, orgId, userId,
    name.trim(),
    cronExpression,
    timezone || 'UTC',
    JSON.stringify(objectiveTemplate),
    nextTrigger ? nextTrigger.toISOString() : null,
  )

  return id
}

function createLinkedSchedule(orgId, userId, event, cronExpression) {
  if (event.agentId) {
    const schedule = createAgentSchedule(orgId, userId, event.agentId, {
      name: event.title,
      cronExpression,
      timezone: event.timezone,
      taskTemplate: { title: event.title, description: event.description, prompt: event.description || event.title },
    })
    return { linkedScheduleId: schedule.id, linkedScheduleKind: 'agent' }
  }

  const scheduleId = createLinkedTeamSchedule(orgId, userId, {
    name: event.title,
    cronExpression,
    timezone: event.timezone,
    objectiveTemplate: { title: event.title, description: event.description },
  })
  return { linkedScheduleId: scheduleId, linkedScheduleKind: 'team' }
}

function disableLinkedSchedule(orgId, linkedScheduleId, linkedScheduleKind) {
  if (!linkedScheduleId) return
  try {
    // Both agent_schedules and team_schedules expose a toggle(orgId, id, enabled)
    // helper with the identical (id, org_id) WHERE clause, so the team-schedule
    // toggle also works for org-level rows with team_definition_id = NULL.
    if (linkedScheduleKind === 'agent') {
      toggleAgentSchedule(orgId, linkedScheduleId, false)
    } else {
      toggleTeamSchedule(orgId, linkedScheduleId, false)
    }
  } catch (err) {
    console.warn(`[CalendarEvents] Failed to disable linked schedule ${linkedScheduleId} (non-fatal): ${err.message}`)
  }
}

// --- CRUD ---

export function createCalendarEvent(orgId, userId, data) {
  if (!data?.title?.trim()) throw new Error('title is required')
  if (!data?.startAt) throw new Error('startAt is required')
  const startDate = new Date(data.startAt)
  if (Number.isNaN(startDate.getTime())) throw new Error('startAt must be a valid date')

  let endDate = null
  if (data.endAt) {
    endDate = new Date(data.endAt)
    if (Number.isNaN(endDate.getTime())) throw new Error('endAt must be a valid date')
    if (endDate < startDate) throw new Error('endAt must not be before startAt')
  }

  const reminders = parseReminders(data.reminders)
  const timezone = data.timezone || 'UTC'
  const recurrenceCron = resolveRecurrenceCron(data)

  const db = getDatabase()
  const id = ulid()

  let linkedScheduleId = null
  let linkedScheduleKind = null
  if (recurrenceCron) {
    const linked = createLinkedSchedule(orgId, userId, {
      title: data.title.trim(),
      description: data.description || null,
      timezone,
      agentId: data.agentId || null,
    }, recurrenceCron)
    linkedScheduleId = linked.linkedScheduleId
    linkedScheduleKind = linked.linkedScheduleKind
  }

  db.prepare(`
    INSERT INTO calendar_events (
      id, org_id, user_id, title, description, start_at, end_at, all_day,
      recurrence_cron, timezone, linked_schedule_id, linked_schedule_kind,
      agent_id, reminders_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id, orgId, userId,
    data.title.trim(),
    data.description || null,
    startDate.toISOString(),
    endDate ? endDate.toISOString() : null,
    data.allDay ? 1 : 0,
    recurrenceCron,
    timezone,
    linkedScheduleId,
    linkedScheduleKind,
    data.agentId || null,
    JSON.stringify(reminders),
    userId,
  )

  return getCalendarEvent(orgId, id)
}

export function getCalendarEvent(orgId, eventId) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM calendar_events WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(eventId, orgId)
}

// Basic (non-recurrence-expanding) range filter on the event's own start_at.
// Occurrence expansion for recurring events (the "unified timeline" view) is
// Phase 2 UI scope per docs/STREAM_AQ_CLUSTER_PLAN.md §4.6 — recurring events
// always match here since their real trigger times live on the linked
// team_schedules/agent_schedules row, not on this table's start_at.
export function listCalendarEvents(orgId, userId, { from, to } = {}) {
  const db = getDatabase()
  const clauses = ['org_id = ?', 'deleted_at IS NULL']
  const params = [orgId]

  // userId is optional (org-wide list); when supplied, scope to that user too.
  if (userId) {
    clauses.push('user_id = ?')
    params.push(userId)
  }
  if (from) {
    clauses.push('(recurrence_cron IS NOT NULL OR start_at >= ?)')
    params.push(new Date(from).toISOString())
  }
  if (to) {
    clauses.push('(recurrence_cron IS NOT NULL OR start_at <= ?)')
    params.push(new Date(to).toISOString())
  }

  return db.prepare(`SELECT * FROM calendar_events WHERE ${clauses.join(' AND ')} ORDER BY start_at ASC`).all(...params)
}

export function updateCalendarEvent(orgId, eventId, updates) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(eventId, orgId)
  if (!existing) throw new Error('Calendar event not found')

  const fields = []
  const values = []

  if (updates.title !== undefined) {
    if (!updates.title.trim()) throw new Error('title is required')
    fields.push('title = ?')
    values.push(updates.title.trim())
  }
  if (updates.description !== undefined) {
    fields.push('description = ?')
    values.push(updates.description)
  }
  if (updates.startAt !== undefined) {
    const startDate = new Date(updates.startAt)
    if (Number.isNaN(startDate.getTime())) throw new Error('startAt must be a valid date')
    fields.push('start_at = ?')
    values.push(startDate.toISOString())
  }
  if (updates.endAt !== undefined) {
    if (updates.endAt === null) {
      fields.push('end_at = ?')
      values.push(null)
    } else {
      const endDate = new Date(updates.endAt)
      if (Number.isNaN(endDate.getTime())) throw new Error('endAt must be a valid date')
      fields.push('end_at = ?')
      values.push(endDate.toISOString())
    }
  }
  if (updates.allDay !== undefined) {
    fields.push('all_day = ?')
    values.push(updates.allDay ? 1 : 0)
  }
  if (updates.timezone !== undefined) {
    fields.push('timezone = ?')
    values.push(updates.timezone)
  }
  if (updates.reminders !== undefined) {
    const reminders = parseReminders(updates.reminders)
    fields.push('reminders_json = ?')
    values.push(JSON.stringify(reminders))
    // Allow re-firing if the reminder configuration changed.
    fields.push('reminders_fired_at = NULL')
  }

  // Recurrence changes: (re)create/disable the linked schedule as needed.
  if (updates.recurrenceCron !== undefined || updates.recurrenceText !== undefined) {
    const newCron = resolveRecurrenceCron({
      recurrenceCron: updates.recurrenceCron,
      recurrenceText: updates.recurrenceText,
    })

    if (newCron && !existing.linked_schedule_id) {
      const linked = createLinkedSchedule(orgId, existing.user_id, {
        title: updates.title !== undefined ? updates.title.trim() : existing.title,
        description: updates.description !== undefined ? updates.description : existing.description,
        timezone: updates.timezone !== undefined ? updates.timezone : existing.timezone,
        agentId: existing.agent_id,
      }, newCron)
      fields.push('linked_schedule_id = ?', 'linked_schedule_kind = ?')
      values.push(linked.linkedScheduleId, linked.linkedScheduleKind)
    } else if (!newCron && existing.linked_schedule_id) {
      disableLinkedSchedule(orgId, existing.linked_schedule_id, existing.linked_schedule_kind)
      fields.push('linked_schedule_id = NULL', 'linked_schedule_kind = NULL')
    }

    fields.push('recurrence_cron = ?')
    values.push(newCron)
  }

  if (fields.length === 0) throw new Error('No fields to update')

  fields.push("updated_at = datetime('now')")
  values.push(eventId, orgId)

  db.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`).run(...values)
  return getCalendarEvent(orgId, eventId)
}

export function deleteCalendarEvent(orgId, eventId) {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(eventId, orgId)
  if (!existing) return false

  if (existing.linked_schedule_id) {
    disableLinkedSchedule(orgId, existing.linked_schedule_id, existing.linked_schedule_kind)
  }

  db.prepare(`UPDATE calendar_events SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ?`).run(eventId, orgId)
  return true
}

// --- Server-side reminder firing (one-off events only; recurring events are
// handled entirely by the linked team_schedules/agent_schedules row via the
// EXISTING poller) ---

export function findDueCalendarEvents(now = new Date()) {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT * FROM calendar_events
    WHERE deleted_at IS NULL AND recurrence_cron IS NULL AND reminders_fired_at IS NULL
  `).all()

  return rows.filter(event => {
    const reminders = JSON.parse(event.reminders_json || '[]')
    if (!reminders.length) return false
    const minutesBefore = Math.max(...reminders.map(r => Number(r.minutesBefore) || 0))
    const fireAt = new Date(new Date(event.start_at).getTime() - minutesBefore * 60000)
    return fireAt <= now
  })
}

export async function fireCalendarEventReminder(event) {
  const db = getDatabase()
  const objectiveId = ulid()
  const corrId = `CAL_${objectiveId}`

  db.prepare(`
    INSERT INTO objectives (id, org_id, user_id, title, description, corr_id, orchestrator_agent_id, triggered_by, task_count, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'calendar_event', 1, 'running', datetime('now'), datetime('now'))
  `).run(
    objectiveId, event.org_id, event.user_id,
    `Reminder: ${event.title}`,
    event.description || null,
    corrId,
    event.agent_id || null,
  )

  const taskId = ulid()
  db.prepare(`
    INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', datetime('now'))
  `).run(
    taskId, objectiveId, event.org_id,
    `Reminder: ${event.title}`,
    event.agent_id || 'quox',
    `Calendar reminder due: "${event.title}"${event.description ? ` — ${event.description}` : ''} (scheduled ${event.start_at}).`,
  )

  try {
    const result = await dispatchObjective(objectiveId)
    if (!result.success) {
      console.error(`[CalendarEvents] Dispatch failed for reminder objective ${objectiveId}: ${result.error}`)
    }
  } catch (err) {
    console.error(`[CalendarEvents] Dispatch threw for reminder objective ${objectiveId}: ${err.message}`)
  }

  db.prepare(`
    UPDATE calendar_events SET reminders_fired_at = datetime('now'), linked_objective_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(objectiveId, event.id)

  return objectiveId
}

export async function checkDueCalendarEvents(now = new Date()) {
  let db
  try {
    db = getDatabase()
  } catch {
    return
  }
  void db

  const due = findDueCalendarEvents(now)
  for (const event of due) {
    try {
      await fireCalendarEventReminder(event)
    } catch (err) {
      console.error(`[CalendarEvents] Failed to fire reminder for event ${event.id}: ${err.message}`)
    }
  }
}

export function startCalendarReminderPoller() {
  if (pollHandle) return
  console.log(`[CalendarEvents] Starting reminder poller (every ${POLL_INTERVAL_MS}ms)`)
  pollHandle = setInterval(() => {
    checkDueCalendarEvents().catch(err => {
      console.error('[CalendarEvents] Poll error:', err.message)
    })
  }, POLL_INTERVAL_MS)
}

export function stopCalendarReminderPoller() {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
}
