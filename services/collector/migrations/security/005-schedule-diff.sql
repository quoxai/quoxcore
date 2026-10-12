-- 005-schedule-diff.sql -- QUOX-SECURITY-SCHED Phase 3: scan-result diffing.
-- Each schedule keeps a COMPACT snapshot of its most recent diff against the
-- prior successful run (counts + the new high/critical findings, never the
-- full unchanged set — see lib/securityScanDiff.js / recordDiff in
-- lib/securityEngagementSchedules.js). Both columns are nullable: a
-- schedule with no successful run yet, or whose first run has not been
-- diffed against anything (no prior baseline), has neither set.

ALTER TABLE security_engagement_schedules ADD COLUMN last_diff_json TEXT;
ALTER TABLE security_engagement_schedules ADD COLUMN last_diff_at TEXT;
