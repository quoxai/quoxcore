-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE workflow_versions ADD COLUMN org_id TEXT;
UPDATE workflow_versions
SET org_id = (SELECT org_id FROM workflows WHERE workflows.id = workflow_versions.workflow_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_versions_org ON workflow_versions(org_id);
