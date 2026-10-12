-- 103-agent-attach.sql
-- QUOXIDENTITY P1 (#487): attach a live session (Claude Code / Codex) to a
-- registry agent identity (e.g. 'seer'). `quox agent attach <agentId>` asks
-- AUTH for a short-TTL lease + JWT bound to the agent's own users row; the
-- collector's ATTACH KIT endpoint (territory B) hands back the system
-- prompt, tool scope and llm config for that JWT.
--
-- Two tables, territory A (services/auth):
--
-- agent_attach_grants: per-agent attach permission for a specific human
-- user, distinct from the human's own org role. Org owner/admin can always
-- attach without a grant row (checked in routes/agent-attach.js); this
-- table is for delegating attach access to a non-admin builder. Append-only
-- revoke (revoked_at set, row never deleted) so the audit trail survives a
-- revoke. A user can be re-granted after revoke: the partial unique index
-- only constrains the currently-active grant, so a fresh INSERT after a
-- revoke is not blocked by the old revoked row.
CREATE TABLE IF NOT EXISTS agent_attach_grants (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  grantee_user_id   TEXT NOT NULL,
  granted_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at        TEXT NULL,
  revoked_by        TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_attach_grants_active
  ON agent_attach_grants(org_id, agent_id, grantee_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_attach_grants_org_agent
  ON agent_attach_grants(org_id, agent_id);

-- agent_attach_leases: single-active-lease-per-agent-per-org. holder_user_id
-- is the HUMAN whose session holds the lease (authz for heartbeat/release
-- is "holder or org admin"); agent_user_id is the actor_type='agent' users
-- row the attach JWT is minted for (sub claim). Staleness is computed as
-- now > last_heartbeat_at + ttl_seconds and checked lazily wherever a
-- lease is read or written (createLease / getLease / activeLeaseFor in
-- lib/agentAttachStore.js) — no new scheduler in P1, per the Loop Hygiene
-- triad (failure accounting / backoff / retirement) which applies only
-- once a recurring scheduler exists.
CREATE TABLE IF NOT EXISTS agent_attach_leases (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  agent_user_id      TEXT NOT NULL,
  holder_user_id     TEXT NOT NULL,
  session_label      TEXT,
  state              TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'released', 'expired', 'taken_over')),
  ttl_seconds        INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at           TEXT NULL,
  takeover_of        TEXT NULL
);

-- The single-active rule: at most one 'active' lease per (org, agent) at
-- any time. A takeover marks the prior row 'taken_over' before inserting
-- the new one, so this constraint is never violated by a legitimate
-- takeover; a genuine race (two lease requests with no takeover) is caught
-- by this index and surfaced as a 409 by the route.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_attach_leases_single_active
  ON agent_attach_leases(org_id, agent_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_attach_leases_org_agent
  ON agent_attach_leases(org_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_attach_leases_holder
  ON agent_attach_leases(holder_user_id);
