-- 082-matrix-rooms.sql
-- M-ROOMS #191 Phase 1: provisioning ledger for default Matrix rooms.
--
-- Source of truth for "does node X have a room, and which". One row per
-- org-tree node (org / division / department / team), per agentic team,
-- per admin-curated room, and one per-tenant CommanderQ room. Room identity
-- on the Matrix side is carried by the ai.quox.room state event; this table
-- is the auth-side record that provisioning consults and updates.
--
-- Idempotency is double-belted (see docs/STREAM_M_ROOMS_PLAN.md section 2.2):
--   1. UNIQUE(org_id, node_type, node_id) here (transactional dedup), and
--   2. the canonical room alias derived from stable ids (Matrix rejects a
--      second createRoom with the same alias, M_ROOM_IN_USE).
--
-- status lifecycle: pending (ledger row exists, Matrix room not yet created)
-- -> active (room created + stamped) -> archived (node removed; the room is
-- kept for evidence, never deleted) | failed (provision attempt errored; the
-- backfill sweep retries pending/failed rows).
CREATE TABLE IF NOT EXISTS matrix_rooms (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL CHECK (node_type IN ('org', 'division', 'department', 'team', 'agentic_team', 'curated', 'commanderq')),
    node_id TEXT NOT NULL,                  -- division/dept/team/agentic-team id; org_id for org; 'commanderq' for the per-tenant CommanderQ room
    scope_id TEXT REFERENCES scopes(id),    -- null for agentic_team / curated / commanderq (no scope row)
    room_id TEXT,                           -- !abc:server once created on the homeserver
    room_alias TEXT NOT NULL,               -- canonical #qx_<org8>_<node_type>_<node8>:server
    default_agent TEXT,                     -- assistants.id (scope assistant) or core agent id ('quox' for commanderq)
    status TEXT NOT NULL DEFAULT 'pending', -- pending | active | archived | failed
    last_synced_at TEXT,                    -- last successful reconcile against the homeserver
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, node_type, node_id)
);

CREATE INDEX IF NOT EXISTS idx_matrix_rooms_org ON matrix_rooms(org_id);
CREATE INDEX IF NOT EXISTS idx_matrix_rooms_status ON matrix_rooms(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matrix_rooms_alias ON matrix_rooms(room_alias);
CREATE INDEX IF NOT EXISTS idx_matrix_rooms_scope ON matrix_rooms(scope_id);

-- Explicit membership rows for CURATED rooms only. Default node rooms derive
-- membership from scopes/teams/org_memberships at provision time and need no
-- rows here. Humans and agents/plugin-agents alike. org_id is the OWNING
-- tenant (the curating admin's own org, never a supported org) so the MSP
-- isolation guard is a single-column check.
CREATE TABLE IF NOT EXISTS matrix_room_members (
    id TEXT PRIMARY KEY,                    -- ULID
    matrix_room_id TEXT NOT NULL REFERENCES matrix_rooms(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'agent')),
    principal_id TEXT NOT NULL,             -- user id or agent/assistant id
    added_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(matrix_room_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_matrix_room_members_room ON matrix_room_members(matrix_room_id);
CREATE INDEX IF NOT EXISTS idx_matrix_room_members_org ON matrix_room_members(org_id);
