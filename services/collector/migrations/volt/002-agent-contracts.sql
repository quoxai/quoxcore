-- RSP-CONTRACT Phase 1a: Responsibility Contract foundation.
--
-- agent_contracts stores versioned, org-scoped responsibility manifests.
-- Two row shapes share the table:
--   - org-default row:  agent_id IS NULL   — applies to every agent in the org
--   - per-agent row:    agent_id = '<id>'  — overrides the org-default for
--                        that one agent (core OR custom/POWERS — both are
--                        DB rows here, so a file-based contract format can't
--                        cover custom agents; this table is agent-path-agnostic)
--
-- Versioning: editing a contract inserts a NEW row (next version number);
-- previous versions are never mutated (immutable history for LIN-REPLAY's
-- future counterfactual replay). `active` marks the current version per
-- (org_id, agent_id) — exactly one active row per org+agent scope at a time,
-- enforced at the application layer in agentContractStore.js.
--
-- contract_json v1 clause shape (see agentContractStore.js CLAUSE_TYPES):
--   {
--     "responsibilities":   [ { "id": "...", "description": "..." }, ... ],
--     "allowed_actions":    [ { "id": "...", "description": "..." }, ... ],
--     "forbidden_actions":  [ { "id": "...", "description": "..." }, ... ],
--     "obligations":        [ { "id": "...", "description": "..." }, ... ]
--   }
--
-- provenance: free-text/JSON note on where this version came from —
-- 'seed' (boot-time core-agent seed), 'admin:<user_id>' (manual edit via
-- API), 'import' (marketplace/POWERS install). Mirrors the audit-trail
-- style of governance_webhook_config without inventing a new provenance
-- taxonomy at this stage.

CREATE TABLE IF NOT EXISTS agent_contracts (
  id TEXT PRIMARY KEY,                 -- CTR_<ts>_<rand>
  org_id TEXT NOT NULL,
  agent_id TEXT,                       -- NULL = org-default row
  version INTEGER NOT NULL DEFAULT 1,
  contract_json TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Partial unique indexes: SQLite treats NULL != NULL in a normal UNIQUE
-- index, so a plain (org_id, agent_id, version) constraint would silently
-- allow duplicate org-default versions. Split into two partial indexes
-- so both row shapes get real uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_org_default_version
  ON agent_contracts(org_id, version) WHERE agent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_agent_version
  ON agent_contracts(org_id, agent_id, version) WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_org ON agent_contracts(org_id);
CREATE INDEX IF NOT EXISTS idx_contracts_org_agent_active
  ON agent_contracts(org_id, agent_id, active);
