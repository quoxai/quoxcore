-- 001-envelopes-priority-column.sql — collector AEE database (aee.db)
--
-- EVD-1c: Add priority column (AEE spec requirement). Was previously applied
-- via an inline try/catch ALTER TABLE in server.js on every boot; folded into
-- a numbered migration here. Existing rows default to 'normal'.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS" — on an already-migrated DB this
-- throws "duplicate column name", which runMigrations.js tolerates as a
-- no-op (see TOLERATED_ERROR in lib/runMigrations.js).

ALTER TABLE envelopes ADD COLUMN priority TEXT DEFAULT 'normal';
