-- OPGOV quox#582 phase 2: compiled governance policies awaiting/holding arm.
-- policy_json is a validated quox-policy.v1 document; state moves
-- draft -> armed ONLY through a human-approved arm call (a policy nobody
-- read is not governance). Enforcement wiring is phase 3 (IMPACT #491).
CREATE TABLE IF NOT EXISTS governance_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'armed', 'retired')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  armed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_governance_policies_org_state
  ON governance_policies (org_id, state);
