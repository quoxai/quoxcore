-- 006-finding-remediation.sql -- QUOX-SECURITY finding remediation status.
-- A finding whose remediation has been confirmed moves to status='resolved'
-- with resolved_at set (e.g. the GitHub issue it was filed as was closed).
-- This is distinct from 'refuted': refuted is a false positive that was never
-- a real thing, resolved is a real finding that has since been fixed. Both
-- columns are nullable: a finding still in candidate/confirmed has neither.
-- issue_state caches the last-known GitHub issue state (open/closed/null) so
-- the UI can show remediation progress without a live API call on every read.
-- See lib/securityFindings.js (resolveFinding/setFindingIssueState) and
-- lib/securityReportActions.js (syncFindingIssueStates).

ALTER TABLE security_findings ADD COLUMN resolved_at TEXT;
ALTER TABLE security_findings ADD COLUMN issue_state TEXT;
