-- Multi-tenancy Phase 2, Tier 1
ALTER TABLE team_memberships ADD COLUMN org_id TEXT;
UPDATE team_memberships
SET org_id = (SELECT org_id FROM teams WHERE teams.id = team_memberships.team_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_memberships_org ON team_memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_team_memberships_org_team ON team_memberships(org_id, team_id);
