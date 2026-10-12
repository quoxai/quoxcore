-- 006-volt-runs-event-cap-column.sql — collector VOLT database (volt.db)
--
-- quox#510: server-side VOLT capture from the AEE stream needs a per-run
-- event cap (QUOX_VOLT_MAX_EVENTS_PER_RUN, default 2000 — see
-- lib/aeeVoltBridge.js) so a runaway workflow (loop node, retry storm)
-- cannot write an unbounded number of volt_events rows the way the
-- 2026-08-18 dev-host-01 incident showed an unbounded per-event size could
-- (see voltEmitter.js's MAX_STRING_BYTES/MAX_PAYLOAD_BYTES comment for that
-- incident). `event_cap_hit` surfaces on the run row itself so a reader of
-- volt_runs (compliance posture, bundle export) can tell "this trace is
-- truncated" without joining volt_events and scanning for the marker event.
--
-- Nullable-by-default (0), same idempotent-ALTER pattern as
-- 003-volt-runs-org-id-column.sql — runMigrations.js tolerates the
-- "duplicate column name" error on a re-applied migration.

ALTER TABLE volt_runs ADD COLUMN event_cap_hit INTEGER DEFAULT 0;
