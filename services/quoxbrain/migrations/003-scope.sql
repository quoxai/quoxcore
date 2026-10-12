-- 003-scope.sql — QUOXBRAIN P2.5a SCOPE TIERS (roadmap QUOXBRAIN #163)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql touched.
--
-- Prior to P2.5a the brain was flatly org-scoped: every read filtered
-- `org_id = req.org_id`, so knowledge registered in one org could never be
-- seen from another. This migration adds a `scope` tier on top of the
-- existing org_id column:
--
--   'org'    — client-isolated, current behaviour (default; existing rows
--              need no backfill, their org_id is already correct and 'org'
--              is exactly what they already do).
--   'user'   — a personal brain that follows req.user_id into EVERY org
--              they act in (owner_user_id, not org_id, is what visibility
--              keys off for these rows).
--   'shared' — instance-wide reference (e.g. Quox platform docs), visible
--              to any (user, org).
--
-- scope + owner_user_id are DENORMALIZED onto notes and note_chunks (not
-- just vaults) so the retrieval hot path (vaultStore.searchChunks and the
-- other reads in lib/vaultStore.js) can filter with vaultStore.scopeClause()
-- directly against note_chunks/notes — no join back to vaults needed.
--
-- org_id itself is UNCHANGED in meaning everywhere: it always records the
-- org a row was CREATED under. Scope is what layers extra visibility on
-- top of that for 'user'/'shared' rows; org isolation for scope='org' rows
-- is exactly today's `org_id = ?` filter (see the (scope='org' AND org_id=?)
-- leg of scopeClause()).

ALTER TABLE vaults ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE vaults ADD COLUMN owner_user_id TEXT;

ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE notes ADD COLUMN owner_user_id TEXT;

ALTER TABLE note_chunks ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE note_chunks ADD COLUMN owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_scope ON vaults(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON note_chunks(scope, owner_user_id);
