-- ET-4 Phase C: security_flags_json column on orgs (nested ALTER inside the
-- session_policies/ip_allowlist guard in the original source; the CREATE
-- TABLE part of that block lives in 000-baseline.sql).
ALTER TABLE orgs ADD COLUMN security_flags_json TEXT;
