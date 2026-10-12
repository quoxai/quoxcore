-- Multi-tenancy Phase 2, Tier 2 (addOrgId helper — version tables inherit from parent)
ALTER TABLE tool_versions ADD COLUMN org_id TEXT;
UPDATE tool_versions
SET org_id = (SELECT org_id FROM tools WHERE tools.id = tool_versions.tool_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_versions_org ON tool_versions(org_id);
