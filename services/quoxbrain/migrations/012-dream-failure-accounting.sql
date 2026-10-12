-- BRAIN2-AUDIT (2026-10-05): QuoxDream failure accounting.
-- A note whose belief extraction fails (HTTP error, timeout, unparseable
-- completion) is no longer silently skipped past the cursor. Failures are
-- counted per note; after N failures the note is retired (retired_at set) so
-- it is never retried forever. Run records gain distinct failure counters.
CREATE TABLE IF NOT EXISTS dream_note_failures (
  org_id        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  note_id       TEXT NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_failed_at TEXT,
  retired_at    TEXT,
  PRIMARY KEY (org_id, scope, owner_user_id, note_id)
);

ALTER TABLE dream_runs ADD COLUMN notes_failed INTEGER DEFAULT 0;
ALTER TABLE dream_runs ADD COLUMN notes_retired INTEGER DEFAULT 0;
ALTER TABLE dream_runs ADD COLUMN infra_failed INTEGER DEFAULT 0;
