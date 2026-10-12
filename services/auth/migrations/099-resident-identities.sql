-- #453 phase 15 — resident agent identity, derived from an Ed25519 keypair
-- on the dev server's own host, zero human minting.
--
-- Unlike lib/agentIdentity.js (mintAgentIdentity), which is a human-admin
-- action that hands back a bearer mcp_token, a resident identity binds a
-- host to a public key: the host proves possession of the matching private
-- key via challenge/response (routes/resident-identity.js) and is minted an
-- access JWT on success. No secret ever leaves the host and no admin step
-- is required to register one (POST /api/internal/resident-identities/register,
-- service-key gated — called by whatever provisions the dev server, not by
-- an interactive admin).
--
-- One row per (org_id, host_id): a host has exactly one live resident
-- identity at a time. Re-registering without rotate=true returns the
-- existing row unchanged (re-enable must not silently rotate identity);
-- rotate=true replaces the public key and mints a new key_id, keeping the
-- same user_id so audit history for that host stays attached to one actor.
CREATE TABLE IF NOT EXISTS resident_identities (
    id TEXT PRIMARY KEY,             -- ULID
    org_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    public_key TEXT NOT NULL,        -- base64 raw 32-byte Ed25519 public key
    user_id TEXT NOT NULL,           -- actor_type='agent' user row
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    rotated_at TEXT,
    last_used_at TEXT,
    UNIQUE (org_id, host_id)
);

CREATE INDEX IF NOT EXISTS idx_resident_identities_user ON resident_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_resident_identities_status ON resident_identities(status);
