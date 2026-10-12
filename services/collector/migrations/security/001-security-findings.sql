-- 001-security-findings.sql -- security_findings table (QUOX-SECURITY Phase 1,
-- continued): closes the gap flagged in Phase 0/1 STATUS_AND_LIMITS, "no
-- findings storage exists yet". Every candidate finding a specialist reports
-- and every verdict findings_verifier reaches now has a durable, org-scoped
-- record, instead of existing only inside a chat conversation.
--
-- status is app-validated (SQLite has no native enum), see
-- lib/securityFindings.js for the allowed value set (candidate, confirmed,
-- refuted). severity is a free-text label chosen from a fixed set in the
-- same module, not a CVSS score, Phase 1 has no scoring engine.

CREATE TABLE IF NOT EXISTS security_findings (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES security_engagements(id),
  org_id TEXT NOT NULL,
  target_value TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence TEXT,
  reported_by TEXT,
  verified_by TEXT,
  verdict_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_findings_engagement ON security_findings(engagement_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_org ON security_findings(org_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_status ON security_findings(status);
