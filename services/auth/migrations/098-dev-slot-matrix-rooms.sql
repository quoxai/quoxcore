-- DEVSUITE-SLOTS Phase 4 — matrix_rooms.node_type CHECK widened with
-- 'dev_slot': one room per collector-owned dev_slots row (node_id =
-- collector's dev_slots.id, no scope row, same no-scope pattern as
-- agentic_team / quoxchat). SQLite cannot ALTER a CHECK constraint, so this
-- uses the same table-recreate pattern 085-quoxchat-matrix-relay.sql used to
-- add 'quoxchat': create a new table with the wider CHECK, copy rows across,
-- drop, rename, recreate indexes.
--
-- dev_slots itself lives in the COLLECTOR's own database (migrations/aee/
-- 011-dev-slots.sql), a different process/DB than auth. The matrix_rooms
-- ledger here is still the single mapping truth (UNIQUE(org_id, node_type,
-- node_id)) per the substrate-native law; dev_slots.matrix_room_id on the
-- collector side is a denorm cache only, written back after a successful
-- provision-node call.
PRAGMA foreign_keys=OFF;

CREATE TABLE matrix_rooms_new (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL CHECK (node_type IN ('org', 'division', 'department', 'team', 'agentic_team', 'curated', 'commanderq', 'quoxchat', 'dev_slot')),
    node_id TEXT NOT NULL,                  -- division/dept/team/agentic-team id; org_id for org; 'commanderq' for the per-tenant CommanderQ room; widget_conversations.id for quoxchat; collector dev_slots.id for dev_slot
    scope_id TEXT REFERENCES scopes(id),    -- null for agentic_team / curated / commanderq / quoxchat / dev_slot (no scope row)
    room_id TEXT,                           -- !abc:server once created on the homeserver
    room_alias TEXT NOT NULL,               -- canonical #qx_<org8>_<node_type>_<node8>:server
    default_agent TEXT,                     -- assistants.id (scope assistant) or core agent id ('quox' for commanderq and dev_slot); null for quoxchat
    status TEXT NOT NULL DEFAULT 'pending', -- pending | active | archived | failed | retired
    last_synced_at TEXT,                    -- last successful reconcile against the homeserver
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, node_type, node_id)
);

INSERT INTO matrix_rooms_new (
    id, org_id, node_type, node_id, scope_id, room_id, room_alias,
    default_agent, status, last_synced_at, created_at, updated_at
)
SELECT
    id, org_id, node_type, node_id, scope_id, room_id, room_alias,
    default_agent, status, last_synced_at, created_at, updated_at
FROM matrix_rooms;

DROP TABLE matrix_rooms;
ALTER TABLE matrix_rooms_new RENAME TO matrix_rooms;

CREATE INDEX IF NOT EXISTS idx_matrix_rooms_org ON matrix_rooms(org_id);
CREATE INDEX IF NOT EXISTS idx_matrix_rooms_status ON matrix_rooms(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matrix_rooms_alias ON matrix_rooms(room_alias);
CREATE INDEX IF NOT EXISTS idx_matrix_rooms_scope ON matrix_rooms(scope_id);

PRAGMA foreign_keys=ON;
