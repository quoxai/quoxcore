-- 002-entity-relation-weight.sql — D4 co-occurrence entity linker
--
-- Adds a weight (evidence-count heuristic, not a witnessed count) and
-- last_seen column to entity_relations so the co-occurrence linker
-- (lib/entityLinker.js) can increment a single row on repeat co-occurrence
-- instead of ever inserting a duplicate. The existing
-- UNIQUE(source_entity_id, relation_type, target_entity_id) constraint
-- (000-baseline.sql) is what makes that increment-in-place safe.
--
-- NOTE: `last_seen TEXT` is added WITHOUT a DEFAULT clause. Adding a new
-- column with a non-constant default (e.g. `DEFAULT (datetime('now'))`) is
-- rejected by SQLite once the target table already has rows — verified
-- against this repo's live entity_relations table (2 rows) — so the column
-- is added nullable and then backfilled from created_at in a separate
-- UPDATE for any pre-existing rows.
--
-- Runs through lib/runMigrations.js (BEGIN/COMMIT per file, tolerant of
-- "duplicate column name" on replay against an already-migrated DB).

ALTER TABLE entity_relations ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entity_relations ADD COLUMN last_seen TEXT;

UPDATE entity_relations SET last_seen = created_at WHERE last_seen IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_relations_org_type ON entity_relations(org_id, relation_type);
