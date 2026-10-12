-- Migration 019: Org isolation data-model prep — QF-MT WP2
--
-- STREAM_QUOXFLOW_MULTITENANCY_PLAN.md S5. Prepares the schema for the
-- org-scoping enforcement landing in WP3-7 (this migration ships no
-- route/store behavior change by itself):
--
--   1. budget_usage gets an org_id column (billing data; join-based scoping
--      via budgets is fragile) — backfilled from the owning budgets row.
--   2. org_id indexes on executions/envelopes/evidence/approvals/policies
--      where absent (envelopes/1M rows: plain CREATE INDEX is acceptable at
--      current single-node scale per S5 — do NOT use CONCURRENTLY inside
--      this transactional migration runner).
--   3. DROP DEFAULT on org_id is deliberately NOT in this migration. Applying
--      it before ALL write paths (WP3-6) supply org_id explicitly breaks live
--      inserts (empirically: NOT NULL violation on executions.org_id from the
--      running server when this was applied to the dev DB ahead of WP3-7).
--      It ships as migration 020 in the WP9 rollout, same deploy as the last
--      write-path fix — precedent for the DROP itself: migration 015 /
--      quox_skill_patches.
--
-- TRUST-GATE fresh-DB fix: workflows, executions, and policies are
-- historically created only by runtime store code (CREATE TABLE IF NOT
-- EXISTS in workflow-store.ts / execution-store.ts / policy-store.ts),
-- never by an earlier migration — same disease as migration 004/skill_library,
-- 002/approvals, 012/envelopes, 017/evidence. Prepending the canonical CREATE
-- TABLE (copied verbatim from the store init() methods, including the
-- ALTER-column additions those stores also apply at boot) makes this
-- migration self-sufficient on a genuinely fresh DB. envelopes/evidence/
-- approvals were already made self-sufficient by 012/017/002 respectively,
-- so this file only ALTERs them. Safe to re-run: all objects use IF NOT
-- EXISTS / IF EXISTS.
--
-- The 'default' backfill decision (operator-driven reassignment, per-install
-- target org) is NOT part of this automatic migration — see
-- scripts/backfill-org.ts and S5 of the plan doc.

-- ─── workflows (mirrors src/api/stores/workflow-store.ts PostgresWorkflowStore.init()) ───

CREATE TABLE IF NOT EXISTS workflows (
  id VARCHAR(100) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL DEFAULT 'default',
  name VARCHAR(255) NOT NULL,
  description TEXT,
  notes TEXT,
  version VARCHAR(50) DEFAULT '1.0.0',
  definition JSONB NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(255),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows(active);
CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at);

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS notes TEXT;

-- ─── executions (mirrors src/api/stores/execution-store.ts PostgresExecutionStore.init()) ───

CREATE TABLE IF NOT EXISTS executions (
  id VARCHAR(26) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL DEFAULT 'default',
  workflow_id VARCHAR(100) NOT NULL,
  workflow_name VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL,
  trigger_data JSONB,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration INTEGER,
  node_count INTEGER,
  envelope_count INTEGER,
  triggered_by VARCHAR(255),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_executions_org_id ON executions(org_id);
CREATE INDEX IF NOT EXISTS idx_executions_workflow_id ON executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_executions_correlation_id ON executions(correlation_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at);

ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- ─── policies (mirrors src/store/policy-store.ts PostgresPolicyStore.init()) ───

CREATE TABLE IF NOT EXISTS policies (
  id VARCHAR(100) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL DEFAULT 'default',
  name VARCHAR(255) NOT NULL,
  version VARCHAR(50) DEFAULT '1.0',
  description TEXT,
  scope JSONB NOT NULL DEFAULT '{}',
  rules JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_policies_org_id ON policies(org_id);
CREATE INDEX IF NOT EXISTS idx_policies_enabled ON policies(enabled);
CREATE INDEX IF NOT EXISTS idx_policies_priority ON policies(priority DESC);

-- ─── budget_usage: add org_id, backfill from the owning budgets row ───

ALTER TABLE budget_usage ADD COLUMN IF NOT EXISTS org_id VARCHAR(255);

UPDATE budget_usage bu
SET org_id = b.org_id
FROM budgets b
WHERE bu.budget_id = b.id
  AND bu.org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_budget_usage_org_id ON budget_usage(org_id);

-- ─── org_id indexes where absent (envelopes/evidence/approvals already carry
--      these from migrations 012/017/002 respectively; restated here so this
--      migration is the single authoritative record per S5 item 2 — all
--      IF NOT EXISTS, no-ops where already present) ───

CREATE INDEX IF NOT EXISTS idx_executions_org_id ON executions(org_id);
CREATE INDEX IF NOT EXISTS idx_envelopes_org_id ON envelopes(org_id);
CREATE INDEX IF NOT EXISTS idx_evidence_org_id ON evidence(org_id);
CREATE INDEX IF NOT EXISTS idx_approvals_org_id ON approvals(org_id);
CREATE INDEX IF NOT EXISTS idx_policies_org_id ON policies(org_id);
