-- BRAIN2-W5 batch 3 (astra2 090/091, 087, 082).
--
-- 090/091: QuoxDream's cursor was the notes ROWID, which (a) never moves when a
-- note is edited in place and (b) is reused after the highest row is deleted
-- (plain INTEGER-less rowid tables hand out max(rowid)+1). ingest_seq is a
-- monotonic counter that upsertNote bumps on insert AND on a content change,
-- and that is never reused. Backfilled from rowid so every legacy
-- dream_cursor.last_ingest_seq keeps meaning the same thing; the counter
-- starts above both the largest rowid and the largest stored cursor.
--
-- notes_au is narrowed to the columns the FTS index actually mirrors, so
-- bookkeeping updates (this backfill, ingest_seq bumps, provenance writes) do
-- not rewrite the FTS index row-by-row.
DROP TRIGGER IF EXISTS notes_au;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
  INSERT INTO notes_fts(rowid,title,body) VALUES (new.rowid,new.title,new.body); END;

ALTER TABLE notes ADD COLUMN ingest_seq INTEGER;
UPDATE notes SET ingest_seq = rowid WHERE ingest_seq IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_ingest_seq ON notes(ingest_seq);

CREATE TABLE IF NOT EXISTS ingest_seq_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT OR REPLACE INTO ingest_seq_counter (id, value)
  VALUES (1, MAX(COALESCE((SELECT MAX(ingest_seq) FROM notes), 0), COALESCE((SELECT MAX(last_ingest_seq) FROM dream_cursor), 0)));

-- Safety net for any writer that bypasses upsertNote: never leave a NULL seq.
CREATE TRIGGER IF NOT EXISTS notes_ingest_seq_ai AFTER INSERT ON notes WHEN NEW.ingest_seq IS NULL BEGIN
  UPDATE ingest_seq_counter SET value = value + 1 WHERE id = 1;
  UPDATE notes SET ingest_seq = (SELECT value FROM ingest_seq_counter WHERE id = 1) WHERE rowid = NEW.rowid;
END;

-- 087: durable ANN delete outbox. A chunk id is queued BEFORE the qdrant delete
-- is attempted and removed only on success, so an outage cannot leave a deleted
-- note's vector stored forever. Drained by the ANN backfill tick.
CREATE TABLE IF NOT EXISTS ann_delete_outbox (
  chunk_id   TEXT PRIMARY KEY,
  queued_at  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- 082: last time the embedding scheduler visited an org, so discovery rotates
-- fairly instead of re-selecting the same alphabetically-early pending orgs.
CREATE TABLE IF NOT EXISTS embed_org_attempts (
  org_id          TEXT PRIMARY KEY,
  last_attempt_at TEXT NOT NULL
);
