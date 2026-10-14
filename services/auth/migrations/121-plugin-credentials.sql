-- SEC-PLUGIN-TRUST C1: per-plugin host credentials (qplg_*).
--
-- An official plugin backend container used to receive the instance master key
-- INTERNAL_SERVICE_KEY as QUOX_HOST_LLM_KEY. It now receives a per-plugin
-- qplg_ secret instead. Only the SHA-256 hash is stored. One ACTIVE credential
-- per plugin (rotated on every backend start); revocable.

CREATE TABLE IF NOT EXISTS plugin_credentials (
    id           TEXT PRIMARY KEY,
    plugin_id    TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the raw qplg_ token
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_credentials_plugin ON plugin_credentials(plugin_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_credentials_active
    ON plugin_credentials(plugin_id) WHERE revoked_at IS NULL;
