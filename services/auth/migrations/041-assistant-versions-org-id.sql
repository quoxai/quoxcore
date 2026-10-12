-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE assistant_versions ADD COLUMN org_id TEXT;
UPDATE assistant_versions
SET org_id = (SELECT org_id FROM assistants WHERE assistants.id = assistant_versions.assistant_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_assistant_versions_org ON assistant_versions(org_id);
