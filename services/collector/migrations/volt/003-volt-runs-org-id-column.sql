-- 003-volt-runs-org-id-column.sql — collector VOLT database (volt.db)
--
-- Adds org_id to volt_runs so VOLT hash-chain integrity can be computed
-- per-org instead of globally (previously monComputeVoltIntegrity() read
-- volt_runs across all tenants, so it was forced to null in the compliance
-- posture endpoint to avoid leaking one org's VOLT evidence into another's).
-- Nullable — background/system runs (no caller org context, e.g. service-key
-- callers with no tenant) legitimately have no org and must NOT have one
-- fabricated. Precedent: 002-envelopes-org-id-column.sql (aee.db).
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS" — on an already-migrated DB this
-- throws "duplicate column name", which runMigrations.js tolerates as a
-- no-op (see TOLERATED_ERROR in lib/runMigrations.js).

ALTER TABLE volt_runs ADD COLUMN org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_volt_runs_org ON volt_runs(org_id);
