-- 074-credential-kind-release-policy.sql
-- VAULT-AUDIT P2: typed credential taxonomy. Two app-enforced columns —
-- no CHECK constraint (kinds/policies are validated in config/credentialKinds.js
-- + routes/integrations.js, not the DB layer, so new kinds can ship without a
-- migration). DDL DEFAULTs mean every existing row backfills to
-- 'service_api'/'api' automatically, and the raw INSERT in
-- lib/powersCredentialAdapter.js (which doesn't reference these columns)
-- keeps working unchanged.
ALTER TABLE integration_credentials ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'service_api';
ALTER TABLE integration_credentials ADD COLUMN release_policy TEXT NOT NULL DEFAULT 'api';
