-- QUOXTRUST T3 (D3 durability) — durable execution ledger for external effects.
-- A consequential external effect (a connector send, an agent email) writes a
-- durable intent row here BEFORE it fires and settles it after. reconcileOnBoot
-- (lib/executionLedger.js) marks any crash-orphaned in-flight row so an effect
-- is never silently lost and an ambiguous dispatch is flagged outcome_unknown,
-- never auto-retried. State: claimed -> dispatched -> confirmed|failed|outcome_unknown.
CREATE TABLE IF NOT EXISTS execution_intents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  action_digest TEXT,
  corr          TEXT,
  state         TEXT NOT NULL,
  outcome       TEXT,
  error         TEXT,
  created_ts    TEXT NOT NULL,
  dispatched_ts TEXT,
  resolved_ts   TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_intents_state ON execution_intents(state);
CREATE INDEX IF NOT EXISTS idx_execution_intents_org_created ON execution_intents(org_id, created_ts);
