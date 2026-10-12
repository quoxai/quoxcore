-- QCX-ACTIONS P2 — durable per-(widget, visitor, month) action metering.
-- Backs the QuoxChat Pro per-visitor monthly action quota: tool executions
-- are counted here (side-effecting ones separately) so quota enforcement
-- survives collector restarts and multi-node deployments. The in-process
-- quoxchatDailyCapStore remains the per-day abuse bound; this table is the
-- monthly commercial meter.
CREATE TABLE IF NOT EXISTS widget_visitor_usage_monthly (
  widget_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  month TEXT NOT NULL, -- 'YYYY-MM' (UTC)
  tool_calls INTEGER NOT NULL DEFAULT 0,
  side_effect_calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (widget_id, visitor_id, month)
);

-- Per-visitor monthly cap override. Set ONLY via a verified identify call
-- (the host computes it, e.g. from the customer's paid services, and signs
-- the identity payload); an unverified visitor can never write it.
ALTER TABLE widget_visitors ADD COLUMN action_quota_override INTEGER;
