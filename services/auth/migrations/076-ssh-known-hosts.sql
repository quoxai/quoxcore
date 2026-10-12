-- 076-ssh-known-hosts.sql
-- VAULT-AUDIT P4.A-auth: durable, org-scoped SSH known-hosts store with
-- server-enforced TOFU (trust-on-first-use) + drift detection. Used by the
-- collector SSH executor (P4.A-collector) to verify a host's SSH server key
-- against a remembered value — a container-local known_hosts file dies on
-- rebuild (ZERO-TOLERANCE server-side-persistence violation, see CLAUDE.md).
-- SSH host public keys are NOT secret — this table is plaintext, NOT
-- registered in config/encryptedStores.js.
CREATE TABLE IF NOT EXISTS ssh_known_hosts (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    host_key_fingerprint TEXT NOT NULL,   -- e.g. sha256 base64 of the server host key
    key_type TEXT,                        -- e.g. 'ssh-ed25519', 'ssh-rsa'
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, host, port)
);
CREATE INDEX IF NOT EXISTS idx_ssh_known_hosts_lookup ON ssh_known_hosts(org_id, host, port);
