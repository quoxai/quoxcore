-- 006-build-receipts-table.sql — collector AEE database (aee.db)
--
-- DEVSUITE-BUILD Phase 1 ("receipts wedge"): /opt/quoxcore/bin/quox-build-daemon
-- (Terminal 9's build queue daemon) currently records every build outcome via
-- its record_action() function to /tmp/quox-build-history ONLY — lost on
-- reboot, no durable history, no WARD witnessing. This table is the durable
-- home for those receipts, mirroring the dev_servers / gpu_nodes pattern
-- (005-dev-servers-table.sql): the daemon's local history file remains its
-- own fast local log, this table is the server-side source of truth that
-- survives a collector restart AND is queryable across terminals/streams.
--
-- Unlike dev_servers/gpu_nodes (UPSERT keyed by host_id), this table is
-- INSERT-only — every build action (queued/ok/FAIL/UNVERIFIED) is its own
-- row, same append-only discipline as the envelopes table. See
-- lib/buildReceiptsStore.js.
--
-- result vocabulary matches record_action()'s REAL call sites in
-- quox-build-daemon verbatim (grepped, not assumed): "ok" (lowercase),
-- "FAIL" (uppercase), "UNVERIFIED" (uppercase). "queued" is reserved in the
-- daemon's own docstring but not currently emitted by any call site. This
-- column intentionally stores whatever string the caller sends rather than
-- an ENUM/CHECK constraint, so a future daemon-side vocabulary addition
-- never needs a migration to be accepted.

CREATE TABLE IF NOT EXISTS build_receipts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  target            TEXT NOT NULL,
  result            TEXT NOT NULL,
  terminal          TEXT,
  stream            TEXT,
  phase             TEXT,
  message           TEXT,
  duration_seconds  INTEGER,
  host              TEXT NOT NULL DEFAULT 'unknown',
  org_id            TEXT NOT NULL DEFAULT 'default',
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_receipts_target ON build_receipts(target);
CREATE INDEX IF NOT EXISTS idx_build_receipts_created ON build_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_build_receipts_result ON build_receipts(result);
