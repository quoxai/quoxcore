-- SDK-TEAM W5: org-scoped plugin revocation.
--
-- An org admin can revoke a signer key (raw Ed25519 public key, hex) or one
-- bundle digest (sha256 hex). Revoked bytes cannot be installed, upgraded to
-- or migrated in, and an existing install stops being served: /bundle and
-- /css answer 403 revoked and /me/plugins drops it, so the browser purges its
-- cached copy on the next load. Revocation wins over org_trusted_keys and
-- also applies in orgs that accept unsigned uploads (bundle_digest).
-- utils/plugins.js ensurePluginsSchema() creates the same table lazily.

CREATE TABLE IF NOT EXISTS plugin_revocations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('signer_key', 'bundle_digest')),
    value       TEXT NOT NULL,
    reason      TEXT,
    revoked_by  TEXT NOT NULL,
    revoked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_plugin_revocations_org ON plugin_revocations(org_id);
