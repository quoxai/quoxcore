-- QUOXTRUST WP4.2 — durable state for the bidirectional evidence reconciler.
-- Rows: 'completeness' (obligation-rowid watermark + counters), 'integrity'
-- (per-hook-chain seq watermark + counters + source cross-check count), and
-- 'tick' (failure accounting: consecutive_failures distinct from empty ticks,
-- last_error, last_tick_ts). The watermark IS the retirement (triad): verified
-- work is never re-walked forever; behind-watermark back-samples are the
-- deliberate bounded exception. Mirrored by the safety-net CREATE in
-- lib/evidenceReconciler.js initReconcilerState.
CREATE TABLE IF NOT EXISTS evidence_reconciliation_state (
  key                  TEXT PRIMARY KEY,
  watermark            INTEGER NOT NULL DEFAULT 0,
  checked_total        INTEGER NOT NULL DEFAULT 0,
  incident_total       INTEGER NOT NULL DEFAULT 0,
  source_checked_total INTEGER NOT NULL DEFAULT 0,
  last_tick_ts         TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_ts           TEXT
);
