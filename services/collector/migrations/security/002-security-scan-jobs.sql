-- 002-security-scan-jobs.sql -- security_scan_jobs table (QUOX-SECURITY
-- Phase 1, continued): closes the gap found 2026-08-10/11 running
-- sectest_vuln_scan (nuclei) live: a real default-template scan takes
-- longer than defaultCallBastion's 30s request budget, so the synchronous
-- POST .../capability/:tool call times out even when the tool genuinely
-- works. This table backs an async job model: a call starts a job and
-- returns immediately, execution continues in the background, the caller
-- polls for the result. See lib/securityScanJobs.js.
--
-- status is app-validated (SQLite has no native enum): queued, running,
-- succeeded, failed. result_json mirrors the same shape
-- executeSecurityCapabilityTool already returns synchronously (success,
-- output, error, exit_code, etc.), so callers that already handle the
-- sync response shape need no new parsing logic once a job completes.

CREATE TABLE IF NOT EXISTS security_scan_jobs (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES security_engagements(id),
  org_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_scan_jobs_engagement ON security_scan_jobs(engagement_id);
CREATE INDEX IF NOT EXISTS idx_security_scan_jobs_org ON security_scan_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_security_scan_jobs_status ON security_scan_jobs(status);
