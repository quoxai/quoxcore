-- Migration 001: Budget Store
-- STUDY-REV-2 P8.B — Cost / Budget Controls
--
-- Cost is stored as BIGINT micro-dollars (cost_usd_micro = round(cost_usd * 1e6))
-- to avoid floating-point drift across SUM aggregations.
-- All integer fields use BIGINT to match JS Number precision safely.

-- ─── budgets ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budgets (
  id            VARCHAR(26)   PRIMARY KEY,
  scope_kind    VARCHAR(20)   NOT NULL CHECK (scope_kind IN ('org', 'objective', 'execution', 'iteration')),
  scope_id      VARCHAR(255)  NOT NULL,
  org_id        VARCHAR(255)  NOT NULL,
  period_start  TIMESTAMPTZ   NOT NULL,
  period_end    TIMESTAMPTZ   NOT NULL,
  max_tokens         BIGINT,
  max_cost_usd_micro BIGINT,
  max_tool_calls     BIGINT,
  max_duration_ms    BIGINT,
  max_iterations     BIGINT,
  hard_stop     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budgets_org_id  ON budgets(org_id);
CREATE INDEX IF NOT EXISTS idx_budgets_scope   ON budgets(scope_kind, scope_id);
CREATE INDEX IF NOT EXISTS idx_budgets_period  ON budgets(period_start, period_end);

-- ─── budget_usage ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_usage (
  id             VARCHAR(26)   PRIMARY KEY,
  budget_id      VARCHAR(26)   NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ   NOT NULL,
  tokens_in      BIGINT        NOT NULL DEFAULT 0,
  tokens_out     BIGINT        NOT NULL DEFAULT 0,
  model          VARCHAR(255)  NOT NULL DEFAULT '',
  cost_usd_micro BIGINT        NOT NULL DEFAULT 0,
  tool_calls     BIGINT        NOT NULL DEFAULT 0,
  duration_ms    BIGINT        NOT NULL DEFAULT 0,
  iteration_count BIGINT       NOT NULL DEFAULT 0,
  source_kind    VARCHAR(50)   NOT NULL DEFAULT '',
  source_id      VARCHAR(255)  NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_budget_usage_budget_id ON budget_usage(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_usage_ts        ON budget_usage(ts);
