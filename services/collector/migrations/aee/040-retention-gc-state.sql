-- 040-retention-gc-state.sql: INCIDENT-700 (2026-10-06).
-- The retention GC was an unbounded synchronous scan+delete fired 5 min after
-- every boot, blocking the event loop for minutes on a 3.4M row table.
-- (1) (intent, ts) lets the per-batch expiry scan seek instead of walking every
--     row of an intent via idx_intent.
-- (2) aee_gc_state persists the last COMPLETED run so a restart never re-arms it.
CREATE INDEX IF NOT EXISTS idx_envelopes_intent_ts ON envelopes(intent, ts);
CREATE TABLE IF NOT EXISTS aee_gc_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
