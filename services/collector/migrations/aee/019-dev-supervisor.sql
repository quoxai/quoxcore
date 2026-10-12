-- 019-dev-supervisor.sql — collector AEE database (aee.db)
--
-- DEVSUITE-DEVMODE, quox#453 phase 15 follow-on: the resident identity a host
-- gets at `quox dev enable` time (018-dev-server-resident.sql) can now answer
-- its slot channel headlessly, driven by a `quox dev supervisor` runner loop
-- on the host. That loop polls GET /api/v1/dev-servers/:hostId/supervisor on
-- every cycle and stops itself the moment supervisor_enabled reads false —
-- these columns ARE the kill switch, not a record of one that lives
-- elsewhere.
--
-- supervisor_enabled is deliberately never flippable by the resident itself:
-- the write route (PUT, server.js) is gated with requireHumanAdmin(), which
-- rejects service-key callers and any JWT carrying agent_id — a resident's
-- own token always carries agent_id. Turning autonomy on is a human decision;
-- this schema exists to make that decision durable and dashboard-visible
-- (house rule: no env-only config), same additive-ALTER pattern as 013/017/018.
--
-- supervisor_slot names which slot channel the loop answers in — independent
-- of dev_slots.assigned_to, which is advisory checkout bookkeeping, not an
-- autonomy switch. supervisor_config is a JSON blob holding poll_seconds/
-- turn_timeout_seconds/max_turns_per_hour (validated ranges live in
-- devServersStore.js, not the schema). supervisor_updated_at/_by are the
-- audit pair for the last PUT, independent of last_seen_at (a heartbeat does
-- not touch these columns, matching resident_updated_at's discipline).

ALTER TABLE dev_servers ADD COLUMN supervisor_enabled INTEGER DEFAULT 0;
ALTER TABLE dev_servers ADD COLUMN supervisor_slot TEXT;
ALTER TABLE dev_servers ADD COLUMN supervisor_config TEXT;
ALTER TABLE dev_servers ADD COLUMN supervisor_updated_at TEXT;
ALTER TABLE dev_servers ADD COLUMN supervisor_updated_by TEXT;
