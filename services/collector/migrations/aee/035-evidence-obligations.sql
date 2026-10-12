-- QUOXTRUST WP4.1b — evidence outbox: a receipt owed is a durable debt.
-- One row per external-effect execution intent (1:1, intent_id PK). Recorded
-- at claim time ('owed'), settled when the mandatory execution receipt is
-- confirmed stored ('delivered'). Reconcile-on-boot re-emits owed receipts
-- from the CONTENT-FREE snapshot below (ctx identifiers + canonical-action
-- commitment; never plaintext tool input) without replaying the effect.
-- Mirrored by the safety-net CREATE in lib/executionLedger.js initExecutionLedger.
CREATE TABLE IF NOT EXISTS evidence_obligations (
  intent_id     TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  corr          TEXT,
  ctx_json      TEXT,
  action_commit TEXT,
  state         TEXT NOT NULL DEFAULT 'owed',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_ts    TEXT NOT NULL,
  delivered_ts  TEXT,
  delivered_envelope_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_obligations_state ON evidence_obligations(state);
