-- POWERS-VAULT-MIGRATION B.1
ALTER TABLE powers_hosted ADD COLUMN org_id TEXT REFERENCES orgs(id);
CREATE INDEX IF NOT EXISTS idx_powers_hosted_org ON powers_hosted(org_id);
UPDATE powers_hosted
SET org_id = (
    SELECT ti.org_id FROM tool_installations ti
    WHERE ti.tool_definition_id = powers_hosted.tool_id LIMIT 1
)
WHERE org_id IS NULL;
