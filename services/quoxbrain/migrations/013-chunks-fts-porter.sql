-- 013-chunks-fts-porter.sql — BRAIN2-AUDIT 2026-10-05
--
-- Rebuilds the chunk FTS index with the porter stemmer so "deploying"
-- matches "deploy" (the 001 default unicode61 tokenizer does no stemming).
-- note_chunks_fts is an EXTERNAL-CONTENT table (content='note_chunks'), so the
-- source text is never lost: drop the index + its triggers, recreate with
-- tokenize='porter unicode61', repopulate with the FTS5 'rebuild' command
-- (one sequential pass over note_chunks, no per-row trigger overhead), then
-- recreate the triggers exactly as 001 defined them.
--
-- Runs once at boot inside the migration runner's single transaction
-- (atomic: a failure leaves the old index intact). Idempotent by
-- construction: IF EXISTS / IF NOT EXISTS throughout, and a re-run just
-- rebuilds again; the runner also records the file in schema_migrations.

DROP TRIGGER IF EXISTS note_chunks_ai;
DROP TRIGGER IF EXISTS note_chunks_ad;
DROP TRIGGER IF EXISTS note_chunks_au;
DROP TABLE IF EXISTS note_chunks_fts;

CREATE VIRTUAL TABLE note_chunks_fts USING fts5(text, content='note_chunks', content_rowid='rowid', tokenize='porter unicode61');
INSERT INTO note_chunks_fts(note_chunks_fts) VALUES('rebuild');

CREATE TRIGGER IF NOT EXISTS note_chunks_ai AFTER INSERT ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(rowid,text) VALUES (new.rowid,new.text); END;
CREATE TRIGGER IF NOT EXISTS note_chunks_ad AFTER DELETE ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(note_chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
CREATE TRIGGER IF NOT EXISTS note_chunks_au AFTER UPDATE ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(note_chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text);
  INSERT INTO note_chunks_fts(rowid,text) VALUES (new.rowid,new.text); END;
