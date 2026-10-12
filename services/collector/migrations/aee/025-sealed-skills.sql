-- 025-sealed-skills.sql, collector AEE database (aee.db)
--
-- SKILLRIGHTS #478 Phase 14, the SEALED EXECUTION PILOT
-- (docs/SEALED_EXECUTION_PILOT_DESIGN.md). The sealed tier is the one where
-- the methodology text never enters the calling model's context at all: the
-- caller invokes a capability, the collector runs it on infrastructure the org
-- controls, and only inputs and outputs cross the boundary.
--
-- The binding sentence every surface prints, verbatim from the design doc:
--   "Sealed execution keeps the text of your methodology out of every model's
--    context and every provider's training pipeline; it does not prevent
--    someone who can call the capability from learning what it does."
-- Nothing built on these tables may claim to prevent distillation, cloning or
-- learning-from-behaviour.
--
-- sealed_skills holds the encrypted methodology. content_ciphertext is
-- AES-256-GCM (iv:authTag:ciphertext, base64-joined) under the deployment's
-- SEALED_CONTENT_KEY, which is its OWN registered key with its own purpose:
-- the design doc forbids reusing the org crystal signing key or any existing
-- secret for content encryption. content_sha256 is the sha256 of the
-- PLAINTEXT, and it is what the evidence envelopes carry, so a witnessed
-- invocation can be tied to an exact methodology version without the text.
-- UNIQUE(org_id, name) makes a sealed name a stable handle within the org;
-- sealed_id (ULID) is the caller-facing identifier.
--
-- sealed_invocations is the sealed-side log. It stores HASHES ONLY, never the
-- input, the output or the methodology: per the design doc's leakage table,
-- caching/logs on the sealed side are a channel, so this table is deliberately
-- incapable of leaking content. Every invocation lands a row, including
-- failures and refusals, because an evidence chain that only records successes
-- is not evidence. status:
--   'ok'              the run completed and the output passed the overlap check
--   'refused_overlap' the output quoted the methodology and was withheld
--   'error'           the executor failed (generic, no detail is retained)
--   'timeout'         the run was killed parent-side after the deadline

CREATE TABLE IF NOT EXISTS sealed_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  sealed_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  input_contract TEXT,
  content_ciphertext TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sealed_skills_org_created
  ON sealed_skills(org_id, created_at);

CREATE TABLE IF NOT EXISTS sealed_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  sealed_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  duration_ms INTEGER,
  envelope_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The rate limiter counts this org's recent invocations of one sealed skill,
-- so the index matches that query exactly.
CREATE INDEX IF NOT EXISTS idx_sealed_invocations_org_skill_created
  ON sealed_invocations(org_id, sealed_id, created_at);
