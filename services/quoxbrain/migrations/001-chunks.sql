-- 001-chunks.sql — QUOXBRAIN P1a chunk-native schema (STREAM_QUOXBRAIN_P1_CONTRACT.md §1)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql touched.
-- note_chunks is the new addressable retrieval unit; notes remains the
-- portable atom (parent-document window for small-to-big retrieval, P1b).

CREATE TABLE IF NOT EXISTS note_chunks (
  id           TEXT PRIMARY KEY,          -- sha1(note_id \0 heading_path \0 ordinal): stable across re-index when content unchanged
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  vault_id     TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,          -- position within note
  heading_path TEXT,                      -- "H1 > H2 > H3" breadcrumb; prefixed into indexed text (cheap contextual-retrieval tier)
  text         TEXT NOT NULL,             -- the indexed chunk text (see lib/vaultStore.js replaceNoteChunks comment)
  char_start   INTEGER NOT NULL,          -- offset into notes.body (parent-document ?range= window)
  char_end     INTEGER NOT NULL,
  token_count  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,             -- skip re-embed when unchanged
  UNIQUE(note_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunks_org  ON note_chunks(org_id);
CREATE INDEX IF NOT EXISTS idx_chunks_note ON note_chunks(note_id);

-- FTS over chunks (BM25 leg operates at chunk granularity from day one).
-- Mirrors the notes_fts trigger pattern in 000-baseline.sql exactly.
CREATE VIRTUAL TABLE IF NOT EXISTS note_chunks_fts USING fts5(text, content='note_chunks', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS note_chunks_ai AFTER INSERT ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(rowid,text) VALUES (new.rowid,new.text); END;
CREATE TRIGGER IF NOT EXISTS note_chunks_ad AFTER DELETE ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(note_chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
CREATE TRIGGER IF NOT EXISTS note_chunks_au AFTER UPDATE ON note_chunks BEGIN
  INSERT INTO note_chunks_fts(note_chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text);
  INSERT INTO note_chunks_fts(rowid,text) VALUES (new.rowid,new.text); END;

-- Embeddings: schema lands in P1, populated in P3. Keyed by chunk, not note.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES note_chunks(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL,
  model      TEXT NOT NULL,               -- 'gemini-embedding-001' etc (dim-tagged)
  dim        INTEGER NOT NULL,            -- 768
  vector     BLOB,                        -- or Qdrant point id; brain.db holds the mapping, Qdrant holds the vector (P3)
  updated_at TEXT NOT NULL
);

-- Provenance for the dream engine (empty until P5.5; lands now so nothing re-integrates).
ALTER TABLE notes ADD COLUMN source_type TEXT NOT NULL DEFAULT 'vault';
ALTER TABLE notes ADD COLUMN kind        TEXT NOT NULL DEFAULT 'note';
ALTER TABLE notes ADD COLUMN occurred_at TEXT;
