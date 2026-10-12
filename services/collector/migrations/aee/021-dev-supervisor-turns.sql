-- 021-dev-supervisor-turns.sql — collector AEE database (aee.db)
--
-- QP-DASH P1 (DEVSUITE-DEVMODE phase 16): per-turn receipts for the headless
-- resident supervisor. Born from the 2026-08-23 backlog-churn incident: the
-- .131 supervisor re-answered ~5 stale messages (~$6) and NOTHING server-side
-- could show it happening; the owner found out from the resident's own
-- confession. A turn that spends money must leave a receipt the dashboard and
-- CLI can list, so churn is a visible spike with a number, not a surprise.
--
-- One row per attempted turn, whatever the outcome ('replied', 'timeout',
-- 'error', 'stale_skipped', 'rate_limited'). Rows are receipts, not truth
-- about the conversation: the slot message cache and the Matrix room stay
-- the record of what was said; this table records what it COST.
--
-- org_id first column, house rule. Additive, no ALTER of existing tables.

CREATE TABLE IF NOT EXISTS dev_supervisor_turns (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  host_id       TEXT NOT NULL,
  slot_name     TEXT,
  message_id    TEXT,
  message_from  TEXT,
  outcome       TEXT NOT NULL,
  reply_chars   INTEGER,
  cost_usd      REAL,
  duration_ms   INTEGER,
  error_note    TEXT,
  session_id    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_supervisor_turns_org_host_time
  ON dev_supervisor_turns (org_id, host_id, created_at);
