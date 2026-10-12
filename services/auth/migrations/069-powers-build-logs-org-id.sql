-- POWERS-VAULT-MIGRATION B.2
ALTER TABLE powers_build_logs ADD COLUMN org_id TEXT REFERENCES orgs(id);
CREATE INDEX IF NOT EXISTS idx_powers_build_logs_org ON powers_build_logs(org_id);
UPDATE powers_build_logs
SET org_id = (
    SELECT ti.org_id FROM tool_installations ti
    WHERE ti.tool_definition_id = powers_build_logs.tool_id LIMIT 1
)
WHERE org_id IS NULL;
