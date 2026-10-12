-- Org-scoped user preferences
ALTER TABLE org_memberships ADD COLUMN preferences_json TEXT DEFAULT '{}';
