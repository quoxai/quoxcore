-- QUOXPERTICUS P2: bind the agent identity to the TOKEN, not the request.
--
-- mcp_tokens rows minted through the admin agent-identity route carry the
-- agent id they represent. The collector's validate call returns it, and
-- httpAuth prefers it over the request-body agent_id (which any token
-- holder could set to impersonate a different agent's tool grants). NULL =
-- an ordinary user token, body/default behaviour unchanged.
ALTER TABLE mcp_tokens ADD COLUMN agent_id TEXT;
