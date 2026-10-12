-- 031-team-schedules-nullable-team-definition-id.sql
--
-- Pre-existing latent bug found while wiring AQ-9B Calendar-Q (Phase 1):
-- the org-level (no-team) schedule path — WC-2's `POST /api/schedules`
-- with no team_id, server.js:~1840 `INSERT INTO team_schedules (...,
-- team_definition_id, ...) VALUES (?, NULL, ...)` — inserts NULL into
-- team_definition_id, but 000-baseline.sql declared that column
-- `NOT NULL`. That code path had no test coverage and would fail on any
-- genuinely fresh database. Calendar-Q's recurring-event -> linked-schedule
-- wiring (lib/calendarEvents.js createLinkedTeamSchedule) uses the exact
-- same org-level shape, which surfaced the bug immediately.
--
-- SQLite has no ALTER COLUMN DROP NOT NULL, so this rebuilds the table
-- (same technique as the legacy team_definitions PK fix in db/index.js).
-- No FOREIGN KEY anywhere in this codebase references team_schedules, so
-- the rebuild is safe without an FK-disable/re-enable dance beyond the
-- standard PRAGMA toggle for consistency.
PRAGMA foreign_keys = OFF;

CREATE TABLE team_schedules_new (
  id TEXT PRIMARY KEY,
  team_definition_id TEXT,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'schedule',
  cron_expression TEXT,
  timezone TEXT DEFAULT 'UTC',
  objective_template_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  next_trigger_at TEXT,
  last_objective_id TEXT,
  last_status TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  max_consecutive_failures INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO team_schedules_new SELECT * FROM team_schedules;
DROP TABLE team_schedules;
ALTER TABLE team_schedules_new RENAME TO team_schedules;

CREATE INDEX IF NOT EXISTS idx_team_sched_team ON team_schedules(team_definition_id);
CREATE INDEX IF NOT EXISTS idx_team_sched_org ON team_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_team_sched_next ON team_schedules(enabled, next_trigger_at);

PRAGMA foreign_keys = ON;
