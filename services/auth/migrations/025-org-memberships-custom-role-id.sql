-- ET-ENFORCE B: custom role overlay on org memberships
ALTER TABLE org_memberships ADD COLUMN custom_role_id TEXT;
