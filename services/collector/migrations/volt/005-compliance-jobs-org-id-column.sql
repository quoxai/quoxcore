-- 005-compliance-jobs-org-id-column.sql — collector VOLT database (volt.db)
--
-- Adds org_id to compliance_jobs so scheduled compliance report jobs can be
-- tagged with the creating caller's org — previously this table had no
-- org_id at all, so every scheduled job (and every report the server-side
-- job runner generated from it) was forced to org_id=null even when a
-- specific org's user created the job via POST /compliance/jobs.
--
-- Nullable — jobs created before this migration, or by callers with no
-- resolvable org, legitimately have no org and must NOT have one fabricated.
-- Precedent: 003-volt-runs-org-id-column.sql, 004-compliance-reports-org-id-column.sql.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS" — on an already-migrated DB this
-- throws "duplicate column name", which runMigrations.js tolerates as a
-- no-op (see TOLERATED_ERROR in lib/runMigrations.js).

ALTER TABLE compliance_jobs ADD COLUMN org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_compliance_jobs_org ON compliance_jobs(org_id);
