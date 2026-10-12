-- Migration 017: Evidence hash-chain — prev_hash / chain_hash (AUDIT-REAL #5)
--
-- Problem: evidence rows are hashed independently (sha256 of content only).
-- There is no linkage between rows, so deleting or reordering evidence for a
-- given correlation_id is undetectable — an auditor querying the table has no
-- way to tell whether a row was silently removed.
--
-- Fix: add prev_hash (the chain_hash of the immediately preceding row in the
-- same correlation_id scope) and chain_hash (a digest binding this row to that
-- prior chain_hash). Walking the chain in insert order and recomputing each
-- chain_hash detects deletion, reordering, and tampering of the hash column.
--
-- Both columns are nullable. Rows that predate this migration are left NULL —
-- the chain starts fresh from deployment forward. Retroactively chaining
-- historical rows would fabricate a causal link that never existed at write
-- time, so it is intentionally not attempted. verifyEvidenceChain() treats
-- NULL chain_hash rows as "legacy" (skipped, counted, not a failure).
--
-- Scope: chained per correlation_id. correlation_id is NOT NULL on every row
-- (unlike workflow_id / execution_id, which are optional and absent for
-- non-workflow evidence such as skill_* telemetry), so it is the only column
-- guaranteed to identify a single logical "run" across all evidence types.
-- See src/evidence/evidence-store.ts for the insert-time chaining logic and
-- the exact preimage format used to compute chain_hash.
--
-- TRUST-GATE fresh-DB fix: `evidence` is historically created only by runtime
-- store code (CREATE TABLE IF NOT EXISTS in
-- src/evidence/evidence-store.ts PostgresEvidenceStore.init()), never by an
-- earlier migration. Same disease as migration 004/skill_library,
-- 002/approvals, 012/envelopes: on a genuinely fresh DB this migration's
-- ALTER TABLE evidence would fail with "relation evidence does not exist".
-- Prepending the canonical CREATE TABLE (copied verbatim from
-- evidence-store.ts) makes this migration self-sufficient. Safe to re-run:
-- all objects use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS evidence (
  id VARCHAR(26) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL DEFAULT 'default',
  correlation_id VARCHAR(255) NOT NULL,
  envelope_id VARCHAR(26) NOT NULL,
  workflow_id VARCHAR(100),
  execution_id VARCHAR(26),
  node_id VARCHAR(100),
  type VARCHAR(50) NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  hash VARCHAR(64) NOT NULL,
  storage_backend VARCHAR(20) NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_evidence_org_id ON evidence(org_id);
CREATE INDEX IF NOT EXISTS idx_evidence_correlation ON evidence(correlation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_envelope ON evidence(envelope_id);
CREATE INDEX IF NOT EXISTS idx_evidence_workflow ON evidence(workflow_id);
CREATE INDEX IF NOT EXISTS idx_evidence_expires ON evidence(expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS chain_hash VARCHAR(64);

-- Supports both "find latest row in scope" (insert path) and "walk the chain
-- in order" (verifyEvidenceChain) without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_evidence_correlation_chain_order
  ON evidence (correlation_id, created_at, id);
