-- AQ-9D P4: durable NotesQ schedules (e.g. a daily note at 07:30 Europe/London).
-- Server-side so schedules survive browser clears and run without a tab open.
CREATE TABLE IF NOT EXISTS notesq_schedules (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  template        TEXT NOT NULL,
  title_pattern   TEXT,
  cadence         TEXT NOT NULL CHECK(cadence IN ('daily','weekly')),
  weekday         INTEGER,
  hour            INTEGER NOT NULL,
  minute          INTEGER NOT NULL,
  tz              TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK(scope IN ('user','org')),
  collection      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_period     TEXT,
  next_run_at     TEXT NOT NULL,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  disabled_reason TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notesq_schedules_due ON notesq_schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_notesq_schedules_owner ON notesq_schedules(org_id, user_id);
