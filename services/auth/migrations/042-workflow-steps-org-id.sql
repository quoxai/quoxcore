-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE workflow_steps ADD COLUMN org_id TEXT;
UPDATE workflow_steps
SET org_id = (SELECT org_id FROM workflows WHERE workflows.id = workflow_steps.workflow_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_steps_org ON workflow_steps(org_id);
