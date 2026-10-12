-- Migration 012: FTS search column + GIN partial index over envelopes — QSKL-13.
--
-- Payload key selection rationale (verified via live DB query 2026-05-14):
-- Distinct keys seen in type IN ('task','result','error') envelopes:
--   objective, message, reasoning, output, observation, action, config,
--   paused, pauseReason, url, code, success, agent_id, agentId, nodeId,
--   nodeName, nodeType, iteration, iterations, objective_met, confidence,
--   tools_used, actions_taken, tokens_used, duration_ms, durationMs,
--   prompt_length, has_output_schema, maxIterations, headers, method,
--   status, statusText, bodySize, details, result, final_reasoning
--
-- Searchable payload keys chosen:
--   objective   — agent goal text (appears on every task envelope)
--   message     — human-readable status messages
--   reasoning   — agent think-step reasoning text
--   output      — task result / command output text
--   observation — step observation text
--   error       — error context (present on type='error' envelopes)
--
-- Keys intentionally excluded from FTS: numeric/boolean/structured fields
-- (code, success, agent_id, nodeId, iteration, tokens_used, etc.) — they
-- contain no natural-language content worth searching.
--
-- TRUST-GATE fresh-DB fix (2026-07-02): `envelopes` was historically created
-- only by runtime store code (CREATE TABLE IF NOT EXISTS in
-- src/store/envelope-store.ts), never by an earlier migration. Same disease
-- as migration 004/skill_library and 002/approvals: on a genuinely fresh DB
-- this migration's ALTER TABLE envelopes would fail with "relation envelopes
-- does not exist". Prepending the canonical CREATE TABLE (copied verbatim
-- from envelope-store.ts) makes this migration self-sufficient. Safe to
-- re-run: all objects use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS envelopes (
  id VARCHAR(26) PRIMARY KEY,
  v VARCHAR(10) DEFAULT '1',
  org_id VARCHAR(255) NOT NULL DEFAULT 'default',
  from_addr VARCHAR(255) NOT NULL,
  to_addr VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL,
  intent VARCHAR(255) NOT NULL,
  corr VARCHAR(255) NOT NULL,
  reply_to VARCHAR(26),
  ts TIMESTAMPTZ NOT NULL,
  priority VARCHAR(20),
  requires JSONB,
  payload JSONB NOT NULL,
  evidence_refs JSONB,
  trace JSONB,
  sig TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_envelopes_org_id ON envelopes(org_id);
CREATE INDEX IF NOT EXISTS idx_envelopes_corr ON envelopes(corr);
CREATE INDEX IF NOT EXISTS idx_envelopes_reply_to ON envelopes(reply_to);
CREATE INDEX IF NOT EXISTS idx_envelopes_intent ON envelopes(intent);
CREATE INDEX IF NOT EXISTS idx_envelopes_ts ON envelopes(ts);
CREATE INDEX IF NOT EXISTS idx_envelopes_type ON envelopes(type);

ALTER TABLE envelopes
  ADD COLUMN IF NOT EXISTS fts_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(payload->>'objective', '') || ' ' ||
      coalesce(payload->>'message', '') || ' ' ||
      coalesce(payload->>'reasoning', '') || ' ' ||
      coalesce(payload->>'output', '') || ' ' ||
      coalesce(payload->>'observation', '') || ' ' ||
      coalesce(payload->>'error', '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_envelopes_fts_search
  ON envelopes USING GIN (fts_search)
  WHERE type IN ('task', 'result', 'error');
