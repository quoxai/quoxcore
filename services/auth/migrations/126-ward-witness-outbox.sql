-- #1078: durable outbox for auth audit witnesses that the collector (the one WARD writer) did not accept yet.
-- One row per audit_events.id (a retry never queues twice). state: pending | dead (retired after the max attempts,
-- kept so /health reports it). body_json holds only the content-free witness body (ids, action, status, hashes).
CREATE TABLE IF NOT EXISTS ward_witness_outbox (
    audit_id        TEXT PRIMARY KEY,
    body_json       TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'pending',
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ward_witness_outbox_due ON ward_witness_outbox (state, next_attempt_at);
