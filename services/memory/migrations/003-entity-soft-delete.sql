-- 003-entity-soft-delete.sql — fleet #383 delete-end-to-end for entities/relations
--
-- entities and entity_relations were create-only (no way to remove a bad
-- extraction or a stale relation short of a manual SQL DELETE). Adds a
-- nullable deleted_at TEXT column to BOTH tables, mirroring the soft-delete
-- shape memories already has (memories.valid, an INTEGER flag) but as a
-- timestamp instead of a flag, matching entity_relations' existing
-- last_seen TEXT convention (002-entity-relation-weight.sql) rather than
-- introducing a second soft-delete idiom into this schema.
--
-- `deleted_at TEXT` is added WITHOUT a DEFAULT clause (nullable, defaults to
-- NULL). Unlike 002's `weight`/`last_seen` columns, NULL is a constant
-- default, so SQLite's "cannot add a column with non-constant default"
-- restriction does not apply here — no backfill UPDATE is needed.
--
-- Runs through lib/runMigrations.js (BEGIN/COMMIT per file, tolerant of
-- "duplicate column name" on replay against an already-migrated DB).

ALTER TABLE entities ADD COLUMN deleted_at TEXT;
ALTER TABLE entity_relations ADD COLUMN deleted_at TEXT;
