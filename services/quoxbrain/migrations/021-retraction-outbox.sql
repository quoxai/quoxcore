-- BRAIN2-W10 C: forgetting is transactional across stores. A note delete or
-- tombstone enqueues a belief retraction in the SAME transaction; a scheduled
-- tick drains it against the memory service. Rows are removed on success,
-- backed off on failure, and marked retired (kept, loud) after N attempts.
CREATE TABLE IF NOT EXISTS belief_retraction_outbox (
  note_id         TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  owner_user_id   TEXT,
  queued_at       TEXT NOT NULL,
  deleted_at      TEXT NOT NULL,  -- cutoff: only beliefs created at or before this are retracted
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  retired_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_retraction_outbox_due ON belief_retraction_outbox(retired_at, next_attempt_at);
