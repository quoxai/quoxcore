-- ET-3 Phase C: users.external_id — SCIM stable identifier (Okta user.id, Azure object id, etc.)
ALTER TABLE users ADD COLUMN external_id TEXT;
