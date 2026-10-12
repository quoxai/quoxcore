-- ============================================================================
-- PHASE 2: MULTI-TENANCY SCHEMA MIGRATION
-- ============================================================================
-- Adds org_id to tables that need tenant isolation
-- Run after existing schema is in place
-- ============================================================================

-- ============================================================================
-- TIER 1: CRITICAL - Direct data exposure risk
-- ============================================================================

-- 1. team_memberships - Add org_id for tenant isolation
-- Note: SQLite doesn't support ADD COLUMN with REFERENCES, so we add column
-- and enforce via trigger
ALTER TABLE team_memberships ADD COLUMN org_id TEXT;

-- Populate org_id from parent teams table
UPDATE team_memberships
SET org_id = (SELECT org_id FROM teams WHERE teams.id = team_memberships.team_id)
WHERE org_id IS NULL;

-- Create index for org-scoped queries
CREATE INDEX IF NOT EXISTS idx_team_memberships_org ON team_memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_team_memberships_org_team ON team_memberships(org_id, team_id);

-- Trigger to auto-populate org_id on INSERT
CREATE TRIGGER IF NOT EXISTS trg_team_memberships_org_id
AFTER INSERT ON team_memberships
WHEN NEW.org_id IS NULL
BEGIN
    UPDATE team_memberships
    SET org_id = (SELECT org_id FROM teams WHERE id = NEW.team_id)
    WHERE id = NEW.id;
END;


-- 2. message_reactions - Add org_id for tenant isolation
ALTER TABLE message_reactions ADD COLUMN org_id TEXT;

-- Populate from messages table
UPDATE message_reactions
SET org_id = (SELECT org_id FROM messages WHERE messages.id = message_reactions.message_id)
WHERE org_id IS NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_reactions_org ON message_reactions(org_id);
CREATE INDEX IF NOT EXISTS idx_reactions_org_message ON message_reactions(org_id, message_id);

-- Trigger to auto-populate org_id on INSERT
CREATE TRIGGER IF NOT EXISTS trg_message_reactions_org_id
AFTER INSERT ON message_reactions
WHEN NEW.org_id IS NULL
BEGIN
    UPDATE message_reactions
    SET org_id = (SELECT org_id FROM messages WHERE id = NEW.message_id)
    WHERE id = NEW.id;
END;


-- 3. conversation_participants - Add org_id for tenant isolation
ALTER TABLE conversation_participants ADD COLUMN org_id TEXT;

-- Populate from conversations table
UPDATE conversation_participants
SET org_id = (SELECT org_id FROM conversations WHERE conversations.id = conversation_participants.conversation_id)
WHERE org_id IS NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_participants_org ON conversation_participants(org_id);
CREATE INDEX IF NOT EXISTS idx_participants_org_conv ON conversation_participants(org_id, conversation_id);

-- Trigger to auto-populate org_id on INSERT
CREATE TRIGGER IF NOT EXISTS trg_conversation_participants_org_id
AFTER INSERT ON conversation_participants
WHEN NEW.org_id IS NULL
BEGIN
    UPDATE conversation_participants
    SET org_id = (SELECT org_id FROM conversations WHERE id = NEW.conversation_id)
    WHERE id = NEW.id;
END;


-- ============================================================================
-- TIER 2: HIGH - Child tables for runs, inbox, workflow
-- ============================================================================

-- 4. run_events - Add org_id (if table exists)
-- Note: Table may not exist in all installations
-- ALTER TABLE run_events ADD COLUMN org_id TEXT;

-- 5. inbox_item_assignees - Add org_id (if table exists)
-- ALTER TABLE inbox_item_assignees ADD COLUMN org_id TEXT;

-- 6. escalation_stages - Add org_id (if table exists)
-- ALTER TABLE escalation_stages ADD COLUMN org_id TEXT;

-- 7. workflow_steps - Add org_id (if table exists)
-- ALTER TABLE workflow_steps ADD COLUMN org_id TEXT;


-- ============================================================================
-- HELPER VIEWS FOR MULTI-TENANT QUERIES
-- ============================================================================

-- View: Team members with org context
CREATE VIEW IF NOT EXISTS v_team_members AS
SELECT
    tm.id,
    tm.team_id,
    tm.user_id,
    tm.role,
    tm.status,
    tm.created_at,
    COALESCE(tm.org_id, t.org_id) as org_id,
    t.name as team_name,
    u.display_name as user_name,
    u.primary_email as user_email
FROM team_memberships tm
JOIN teams t ON t.id = tm.team_id
JOIN users u ON u.id = tm.user_id
WHERE tm.status = 'active';

-- View: Conversation participants with org context
CREATE VIEW IF NOT EXISTS v_conversation_participants AS
SELECT
    cp.id,
    cp.conversation_id,
    cp.user_id,
    cp.role,
    cp.joined_at,
    cp.last_read_at,
    cp.left_at,
    COALESCE(cp.org_id, c.org_id) as org_id,
    c.title as conversation_title,
    c.agent_id,
    u.display_name as user_name
FROM conversation_participants cp
JOIN conversations c ON c.id = cp.conversation_id
JOIN users u ON u.id = cp.user_id
WHERE cp.left_at IS NULL;


-- ============================================================================
-- MIGRATION COMPLETE FLAG
-- ============================================================================
-- Insert a flag to indicate this migration has run
INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('schema-multitenancy', datetime('now'));
