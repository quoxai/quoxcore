-- ApprovalsQ (QVOICE-OUTBOUND #521): escalation ledger. One row per HITL
-- approval that the watcher has decided to phone a human about. The ledger is
-- the RETIREMENT half of the watcher's triad: resolved / exhausted / cancelled
-- rows are never re-attempted. The watcher never decides an approval; it only
-- records that a call was placed and what the call reported back.
CREATE TABLE IF NOT EXISTS approvalsq_escalations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  item_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','calling','resolved','exhausted','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_outcome TEXT,
  last_call_sid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(org_id, approval_id)
);
CREATE INDEX IF NOT EXISTS idx_approvalsq_escalations_org_state ON approvalsq_escalations(org_id, state);
CREATE INDEX IF NOT EXISTS idx_approvalsq_escalations_next ON approvalsq_escalations(next_attempt_at);
