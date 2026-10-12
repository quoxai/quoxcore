-- 027-relevance-judgements.sql — ONE-BRAIN CX5: real usage becomes a growing,
-- labelled retrieval eval set. A human or agent says "for this query, this
-- note is relevant / irrelevant" or "this query should abstain"; `quox brain
-- eval` replays the queries against live search and scores them.
-- Idempotent re-judging: the UNIQUE index COALESCEs note_id because SQLite
-- treats NULLs as distinct (a should_abstain row has no note). Additive.
CREATE TABLE IF NOT EXISTS relevance_judgements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  query TEXT NOT NULL,
  note_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('relevant','irrelevant','should_abstain')),
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relevance_judgements_org_created ON relevance_judgements (org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_relevance_judgements ON relevance_judgements (org_id, query, COALESCE(note_id, ''), verdict);
