-- ============================================================================
-- Security Issue #88: Prevent invite double-spend via unique constraint
-- This creates a unique index to prevent the same invite from being accepted
-- multiple times at the database level (defense-in-depth)
-- ============================================================================

-- Create unique partial index: only one accepted record per invite
-- This allows multiple pending/expired/revoked records but only ONE accepted
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_single_acceptance
ON invites(id) WHERE status = 'accepted';

-- Also create an index on (accepted_by, org_id) to speed up membership checks
-- and prevent a user from accepting multiple invites to the same org simultaneously
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_user_org_accepted
ON invites(accepted_by, org_id) WHERE status = 'accepted' AND accepted_by IS NOT NULL;
