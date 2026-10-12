-- 004-envelopes-from-ts-index.sql — collector AEE database (aee.db)
--
-- PERF (2026-07-19): the governanceAnomalyRunner setInterval fires EVERY 60s and
-- calls detectAgentAnomalies() -> currentHourValue() once per (agent, metric),
-- each running a synchronous better-sqlite3 `.get()`:
--     SELECT COUNT(*) FROM envelopes WHERE "from" = ? AND ts >= ? AND ts < ?
--     SELECT COUNT(*) FROM envelopes WHERE "from" = ? AND type = 'error' AND ts >= ? AND ts < ?
-- Only the single-column idx_from("from") existed, so for high-volume agents (e.g.
-- the orchestrator, whose from-partition is a large fraction of the ~1.2M-row table)
-- each COUNT walked the entire partition and filtered ts in memory. Summed across
-- ~37 agents x 2 metrics, one anomaly pass blocked the event loop for many seconds
-- EVERY MINUTE — near-continuous wedging of the shared collector (root-caused via
-- CPU profile: 95% self-time in native better-sqlite3 get(), callers listBaselines /
-- currentHourValue in agentBehaviorService.js). Same failure class as 003.
--
-- These composite indexes turn each COUNT into an index range scan:
--   ("from", ts)          -> activity_rate COUNT is a covered range scan
--   ("from", type, ts)    -> error_rate COUNT (adds type='error') is a covered range scan
-- NOTE: building these on the already-large table is a one-time few-second cost at
-- the boot that first applies them.

CREATE INDEX IF NOT EXISTS idx_envelopes_from_ts ON envelopes("from", ts);
CREATE INDEX IF NOT EXISTS idx_envelopes_from_type_ts ON envelopes("from", type, ts);
