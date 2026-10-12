-- 001-memory-role-column.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the ad-hoc block previously in lib/db.js (QSKL-1):
-- idempotent column add for pre-QSKL-1 databases. SQLite has no
-- ADD COLUMN IF NOT EXISTS, so on a fresh DB (000-baseline.sql already
-- defines memory_role directly on the `memories` table) this ALTER
-- duplicates the column and errors with "duplicate column name" —
-- runMigrations.js tolerates that specific error as a no-op, exactly
-- matching the try/catch this block replaced.
ALTER TABLE memories ADD COLUMN memory_role TEXT DEFAULT 'fact' CHECK (memory_role IN ('fact', 'procedure', 'session_history'));
CREATE INDEX IF NOT EXISTS idx_memories_role ON memories(memory_role);
