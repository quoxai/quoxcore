-- ET-2B Phase A: SAML-specific sso_providers column
ALTER TABLE sso_providers ADD COLUMN entity_id TEXT;
