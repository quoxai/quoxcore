-- 022-citation-records.sql — BRAIN2-W13 A 118: durable per-turn citation records.
-- citation_events (008/018) keeps only per-answer COUNTS. The collector's
-- per-turn trace (handle, note, span, verdicts) lived in process memory and
-- expired, so "what did the agent cite, and was it supported?" could not be
-- answered later. One row per retrieved reference of a finalized turn.
-- note_hash is the note's content_hash at record time (the version cited).
-- supported/contradicted: 1/0, NULL = not measured. Additive.
CREATE TABLE IF NOT EXISTS citation_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  session TEXT,
  handle TEXT,
  note_id TEXT NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  note_hash TEXT,
  supported INTEGER,
  contradicted INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citation_records_org_user_created ON citation_records (org_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_citation_records_org_session ON citation_records (org_id, session);
