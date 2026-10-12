-- 030-calendar-events.sql — AQ-9B Calendar-Q Phase 1 (backend)
--
-- Trimmed slice of docs/CALENDAR_Q_PLAN.md's 6-table design (§4.6 of
-- docs/STREAM_AQ_CLUSTER_PLAN.md): a single calendar_events table, org+user
-- scoped. Recurring events delegate execution to the EXISTING tasks-service
-- schedulers (team_schedules / agent_schedules — same poll loop, same
-- dispatchObjective path) via linked_schedule_id; Calendar-Q never runs its
-- own recurrence engine. One-off events with reminders are checked by a
-- server-side poll (calendarEvents.js) that mirrors the same
-- objectives/tasks/dispatchObjective pattern already used by
-- agentScheduler.js / teamScheduler.js — no new execution engine, no
-- browser timers.
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  -- Recurrence: standard 5-field cron, validated server-side via
  -- lib/cronParser.js (same validator the other schedule tables use).
  recurrence_cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- When recurrence_cron is set, a row is created in team_schedules (or
  -- agent_schedules) and its id/kind is recorded here so the existing
  -- poller drives execution. NULL for one-off events.
  linked_schedule_id TEXT,
  linked_schedule_kind TEXT CHECK(linked_schedule_kind IS NULL OR linked_schedule_kind IN ('agent', 'team', 'workflow')),
  -- Set once a one-off event's reminder has fired (creates an objective)
  -- so checkDueCalendarEvents() never double-fires it.
  linked_objective_id TEXT,
  agent_id TEXT,
  reminders_json TEXT NOT NULL DEFAULT '[]',
  reminders_fired_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_user ON calendar_events(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(org_id, start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_schedule ON calendar_events(linked_schedule_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_due_reminders
  ON calendar_events(reminders_fired_at, recurrence_cron, deleted_at);
