-- 004-engagement-schedules.sql -- QUOX-SECURITY-SCHED Phase 1: recurring
-- scan schedule model. A schedule is a standing instruction to re-run a
-- given tool against a given target on a fixed cadence, owned by an
-- engagement. This migration is purely additive: the model + store here,
-- no scheduler loop yet (a later phase reads listDueSchedules and actually
-- fires jobs). See lib/securityEngagementSchedules.js.
--
-- enabled / next_run_at / last_* are app-validated the same way the other
-- security tables are (SQLite has no native enum/cron type).
--
-- interval_seconds has an app-enforced floor (MIN_INTERVAL_SECONDS, see
-- the store) to prevent a misconfigured schedule from hammering a target.

CREATE TABLE IF NOT EXISTS security_engagement_schedules (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES security_engagements(id),
  org_id TEXT NOT NULL,
  target_value TEXT NOT NULL,
  tool TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_job_id TEXT,
  last_status TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_engagement_schedules_engagement ON security_engagement_schedules(engagement_id);
CREATE INDEX IF NOT EXISTS idx_security_engagement_schedules_org ON security_engagement_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_security_engagement_schedules_due ON security_engagement_schedules(enabled, next_run_at);

-- Nullable link, set only for scan jobs that a schedule fired (not manual
-- ones). Lets a later phase trace "which job did this schedule's last run
-- produce" without a join table.
ALTER TABLE security_scan_jobs ADD COLUMN schedule_id TEXT;
