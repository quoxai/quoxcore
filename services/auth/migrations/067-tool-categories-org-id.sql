-- STUDY-REV-2/P1.A: user-created tool categories
ALTER TABLE tool_categories ADD COLUMN org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tool_categories_org ON tool_categories(org_id);
