-- HITL-VOLT-WITNESS (QuoxPlan #2202) — durable retry queue for approval
-- decision VOLT witness events that failed to reach the collector's
-- POST /api/internal/volt/emit on first attempt (VOLT outage, network
-- blip, collector restart mid-request). Auth does not own the VOLT DB —
-- collector does — so a failed emit cannot be retried in-process; it must
-- survive an auth-service restart too. Mirrors the shape and retry
-- semantics of pending_audit_events (see jobs/audit-event-reaper.js),
-- consumed instead by jobs/volt-witness-reaper.js.
CREATE TABLE IF NOT EXISTS pending_volt_events (
    id                  TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TEXT,
    next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    failure_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_volt_events_next
    ON pending_volt_events(next_attempt_at)
    WHERE attempts < 10;
