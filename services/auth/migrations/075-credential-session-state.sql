-- 075-credential-session-state.sql
-- VAULT-AUDIT P3.B1 (F17): server-side encrypted session-state store.
-- Fixes screencap writing plaintext browser session cookies to disk (a
-- session-hijack risk and a ZERO-TOLERANCE server-side-persistence
-- violation — see CLAUDE.md). Cookies are stored envelope-encrypted
-- (utils/encryption.js v2 envelope, same as integration_credentials) keyed
-- by an org-scoped session_key (screencap uses `${sessionId}__${domain}`).
CREATE TABLE IF NOT EXISTS credential_session_state (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    credential_id TEXT REFERENCES integration_credentials(id) ON DELETE SET NULL,
    session_key TEXT NOT NULL,      -- screencap uses `${sessionId}__${domain}`
    domain TEXT,
    ciphertext TEXT NOT NULL,       -- v2-envelope-encrypted JSON { cookies:[...], saved_at }
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,                -- staleness horizon (saved_at + 12h)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_session_state_org_key ON credential_session_state(org_id, session_key);
