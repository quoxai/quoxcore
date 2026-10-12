-- 030-reach-digest-runs.sql — collector AEE database (aee.db)
--
-- BLAST-RADIUS-P4: durable dedup for lib/reach/digestScheduler.js's weekly
-- reach least-privilege digest. One row per (org_id, week_key) — the ISO
-- week the digest fired for, e.g. '2026-W38' — is the whole dedup contract:
-- a row already present for this org+week means "already handled this
-- week" (fired or gave up), so a restart cannot re-mint the same digest,
-- same durable-retirement spirit as x_scheduled_publishes (see
-- lib/xPublishScheduler.js's module doc, THE LOOP TRIAD).
--
-- status is 'ok' (inbox item minted) or 'error' (attempted, failed — the
-- `error` column carries why). There is no 'pending'/in-flight status: a
-- tick either finishes an org's digest attempt or it doesn't get a row at
-- all yet, so a crash mid-attempt just means the org is retried on the
-- next hourly tick within the same ISO week, which is safe (no partial
-- state to reconcile) since minting the inbox item is the only side effect
-- and this table is written only AFTER that mint attempt resolves.

CREATE TABLE IF NOT EXISTS reach_digest_runs (
  org_id    TEXT NOT NULL,
  week_key  TEXT NOT NULL,
  fired_at  TEXT NOT NULL,
  status    TEXT NOT NULL, -- 'ok' | 'error'
  error     TEXT,
  PRIMARY KEY (org_id, week_key)
);

CREATE INDEX IF NOT EXISTS idx_reach_digest_runs_week ON reach_digest_runs(week_key);
