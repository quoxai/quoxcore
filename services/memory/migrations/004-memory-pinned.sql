-- 004-memory-pinned.sql (QUOXMIND #1111): the core set mechanism.
--
-- pinned: 1 = owner pinned into the org core set, -1 = excluded (never core,
-- even if auto-promotion would pick it), NULL/0 = auto (see getCoreSet in
-- lib/memoryStore.js). pinned_at/pinned_by record who pinned it and when.
-- SQLite has no ADD COLUMN IF NOT EXISTS; runMigrations.js tolerates the
-- "duplicate column name" error as a no-op on an already-migrated DB.
ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN pinned_at TEXT;
ALTER TABLE memories ADD COLUMN pinned_by TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_org_pinned ON memories(org_id, pinned);
