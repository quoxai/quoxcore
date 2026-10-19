-- quox#1015: NotesQ import / batch job summaries. The live job runs in collector memory with a 1h TTL;
-- this row is what `quox notes import-status <id>` reads after that TTL or a collector restart.
-- Counts plus the capped error list (failed note title + reason, max 20), never note content.
CREATE TABLE IF NOT EXISTS notesq_import_jobs (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  user_id          TEXT,
  status           TEXT NOT NULL,
  format           TEXT,
  scope            TEXT,
  total            INTEGER NOT NULL DEFAULT 0,
  created          INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  errors_json      TEXT NOT NULL DEFAULT '[]',
  collections_json TEXT NOT NULL DEFAULT '{}',
  fatal            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notesq_import_jobs_org_user ON notesq_import_jobs (org_id, user_id);
