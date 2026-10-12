-- 007-schedule-cron.sql -- QUOX-SECURITY-SCHED: native cron cadence.
-- Until now a schedule's cadence was interval-only (interval_seconds), so a
-- "weekly Wednesday 03:00" instruction needed a manual next_run_at alignment.
-- This migration adds a native cron option. schedule_kind selects the cadence
-- model: 'interval' (the existing, default behaviour) or 'cron'. A cron row
-- carries its expression in cron_expression (a standard 5-field cron:
-- min hour dom month dow), evaluated in UTC (v1 is UTC-only; see
-- lib/securityCron.js). timezone is stored for a future phase but is NOT
-- honored yet.
--
-- interval_seconds stays NOT NULL because SQLite cannot drop a NOT NULL
-- constraint without a full table rebuild, so a 'cron' row stores
-- interval_seconds = 0 (a sentinel that is never read for cron rows: cron
-- next_run_at comes from cron_expression, see computeNextRun in
-- lib/securityEngagementSchedules.js). Purely additive, matching the 004/005/006 style.

ALTER TABLE security_engagement_schedules ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'interval';
ALTER TABLE security_engagement_schedules ADD COLUMN cron_expression TEXT;
ALTER TABLE security_engagement_schedules ADD COLUMN timezone TEXT;
