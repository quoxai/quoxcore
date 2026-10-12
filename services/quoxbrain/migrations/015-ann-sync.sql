-- BRAIN2-V3 B1: qdrant ANN sync state. One cursor row over
-- chunk_embeddings.rowid (resumable backfill) and a durable list of rows the
-- ANN index permanently rejected (retired, never retried forever).
CREATE TABLE IF NOT EXISTS ann_sync_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid  INTEGER NOT NULL DEFAULT 0,
  synced      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);
INSERT OR IGNORE INTO ann_sync_state (id, last_rowid) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS ann_sync_retired (
  chunk_id   TEXT PRIMARY KEY,
  error      TEXT,
  retired_at TEXT
);
