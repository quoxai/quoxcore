-- QUOXCHAT-PRO P2 — governed Matrix room per handed-off website conversation.
--
-- 1. matrix_rooms.node_type CHECK widened with 'quoxchat': one room per
--    handed-off widget conversation (node_id = widget_conversations.id, no
--    scope row, same no-scope pattern as agentic_team). SQLite cannot ALTER
--    a CHECK constraint, so this uses the standard table-recreate pattern
--    (see 081-notification-channel-type-widen.sql): create a new table with
--    the wider CHECK, copy rows across, drop, rename, recreate indexes.
--
-- 2. widget_conversations.matrix_room_id: the provisioned room for a
--    handed-off conversation. NULL = no room yet; a handed_off conversation
--    with a NULL matrix_room_id is the "provision pending" marker the
--    collector retries on the next visitor message. Indexed because the
--    operator relay path resolves conversations BY room id.
--
-- 3. widget_messages.sender_name: display name of the human operator for
--    role='operator' rows (relayed from the Matrix room). NULL for existing
--    user/assistant rows, zero behaviour change.
PRAGMA foreign_keys=OFF;

CREATE TABLE matrix_rooms_new (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL CHECK (node_type IN ('org', 'division', 'department', 'team', 'agentic_team', 'curated', 'commanderq', 'quoxchat')),
    node_id TEXT NOT NULL,                  -- division/dept/team/agentic-team id; org_id for org; 'commanderq' for the per-tenant CommanderQ room; widget_conversations.id for quoxchat
    scope_id TEXT REFERENCES scopes(id),    -- null for agentic_team / curated / commanderq / quoxchat (no scope row)
    room_id TEXT,                           -- !abc:server once created on the homeserver
    room_alias TEXT NOT NULL,               -- canonical #qx_<org8>_<node_type>_<node8>:server
    default_agent TEXT,                     -- assistants.id (scope assistant) or core agent id ('quox' for commanderq); null for quoxchat
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

ALTER TABLE widget_conversations ADD COLUMN matrix_room_id TEXT;
CREATE INDEX IF NOT EXISTS idx_widget_conversations_matrix_room ON widget_conversations(matrix_room_id);

ALTER TABLE widget_messages ADD COLUMN sender_name TEXT;
