-- QUOXPERTICUS P2: governed identity. Every user row carries an actor_type.
--
-- human   - a person; the only type that may log in interactively.
-- agent   - an agent-as-user identity (e.g. the QUOXPERTICUS resident agent's
--           mcp_token binding). Never gets a password session: an agent
--           identity has exactly one credential class, the one that derives
--           actor_type=agent server-side (DEC-2), so it can never masquerade
--           as a human to a gate that checks credential class.
-- service - a non-agent service principal (reserved; #447 per-service identity).
--
-- Default 'human' backfills every existing row. The CHECK keeps unknown
-- types out of the substrate the approval gates are built on.
ALTER TABLE users ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_type IN ('human', 'agent', 'service'));
