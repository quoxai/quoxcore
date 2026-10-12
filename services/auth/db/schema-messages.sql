-- ============================================================================
-- Messages & Conversations Schema
-- Conversation audit trail for compliance and HITL integration
--
-- AOCL/AEE Alignment:
-- - aee_envelope_id: Links to AEE envelope (all layers)
-- - correlation_id: Maps to AEE corr field for conversation tracking
-- - sender_type/id: Maps to AEE from field
-- - aocl_layers_json: Tracks which AOCL layers processed (L0-L10)
-- - verify_status: L8 Verify output validation result
-- - requires_approval: L3 Policy HITL integration
-- - prev_message_hash/message_hash: L10 Audit immutable chain
--
-- See: /opt/quoxcore/docs/AOCL.md
-- ============================================================================

-- ============================================================================
-- CONVERSATIONS (threads/sessions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Scope (who owns this conversation)
    scope_type TEXT NOT NULL DEFAULT 'user',  -- user, team, division, org
    scope_id TEXT NOT NULL,                   -- user_id, team_id, division_id, or org_id

    -- Conversation metadata
    title TEXT,                             -- Auto-generated or user-set title
    summary TEXT,                           -- AI-generated summary
    agent_id TEXT,                          -- Primary agent/assistant (e.g., 'quox', 'sentinel')

    -- Status
    status TEXT NOT NULL DEFAULT 'active',  -- active, archived, deleted

    -- Counters (denormalized for performance)
    message_count INTEGER DEFAULT 0,
    token_count_in INTEGER DEFAULT 0,
    token_count_out INTEGER DEFAULT 0,

    -- Timestamps
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT,
    archived_at TEXT,

    -- Audit
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- MESSAGES (individual messages in conversations)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,                    -- ULID
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Message identification
    sequence_num INTEGER NOT NULL,          -- Order within conversation
    parent_id TEXT REFERENCES messages(id), -- For threaded replies

    -- Sender
    role TEXT NOT NULL,                     -- user, assistant, system, tool
    sender_type TEXT NOT NULL,              -- human, agent, system
    sender_id TEXT,                         -- user_id or agent_id
    sender_name TEXT,                       -- Display name at time of message

    -- Content
    content TEXT NOT NULL,                  -- Message content (may be markdown)
    content_type TEXT DEFAULT 'text',       -- text, markdown, json, image, file

    -- Attachments (JSON array)
    -- Structure: [{ id, filename, mime_type, size_bytes, url }]
    attachments_json TEXT,

    -- Tool calls and results (JSON)
    -- Structure for tool calls: [{ id, name, arguments }]
    -- Structure for tool results: { tool_call_id, output, error }
    tool_calls_json TEXT,
    tool_result_json TEXT,

    -- Token usage
    tokens_in INTEGER,
    tokens_out INTEGER,

    -- Model/provider info
    model TEXT,                             -- e.g., 'claude-3-opus', 'gpt-4'
    provider TEXT,                          -- e.g., 'anthropic', 'openai'

    -- Processing metadata
    processing_time_ms INTEGER,
    finish_reason TEXT,                     -- stop, length, tool_calls, error

    -- L8 Verify status (output validation)
    verify_status TEXT,                     -- passed, warning, failed, skipped
    verify_flags_json TEXT,                 -- JSON array of verification flags raised

    -- HITL integration
    requires_approval INTEGER DEFAULT 0,    -- Flagged for HITL review
    approval_status TEXT,                   -- pending, approved, rejected
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,

    -- Audit trail
    edited INTEGER DEFAULT 0,
    edited_at TEXT,
    deleted_at TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- AEE correlation (links to AEE envelope system)
    aee_envelope_id TEXT,                   -- AEE envelope ID if applicable
    correlation_id TEXT,                    -- Conversation/request correlation

    -- AOCL Layer Tracking (which layers processed this message)
    -- JSON array: ["L0", "L2", "L5", "L7", "L9", "L10"]
    aocl_layers_json TEXT,

    -- Audit Chain (L10 Audit immutability)
    -- SHA256 hash of: prev_hash + id + content + created_at
    prev_message_hash TEXT,                 -- Hash of previous message in conversation
    message_hash TEXT                       -- Hash of this message for chain verification
);

-- ============================================================================
-- MESSAGE REACTIONS (user feedback on messages)
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,                    -- ULID
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Reaction type
    reaction_type TEXT NOT NULL,            -- thumbs_up, thumbs_down, flag, bookmark

    -- Optional feedback
    feedback_text TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(message_id, user_id, reaction_type)
);

-- ============================================================================
-- CONVERSATION PARTICIPANTS (for multi-user conversations)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_participants (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Role in conversation
    role TEXT NOT NULL DEFAULT 'participant',  -- owner, moderator, participant, observer

    -- Notification preferences
    notify_on_message INTEGER DEFAULT 1,
    notify_on_mention INTEGER DEFAULT 1,

    -- Timestamps
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_read_at TEXT,
    left_at TEXT,

    UNIQUE(conversation_id, user_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Conversations
CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(org_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(org_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(org_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(org_id, created_at DESC);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_type, sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_hitl ON messages(org_id, requires_approval, approval_status);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id);
CREATE INDEX IF NOT EXISTS idx_messages_aee ON messages(aee_envelope_id);
CREATE INDEX IF NOT EXISTS idx_messages_verify ON messages(org_id, verify_status);
CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(message_hash);

-- Reactions
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_type ON message_reactions(message_id, reaction_type);

-- Participants
CREATE INDEX IF NOT EXISTS idx_participants_conversation ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_active ON conversation_participants(conversation_id, left_at);

-- ============================================================================
-- TRIGGERS (update counters and timestamps)
-- ============================================================================

-- Update conversation message count and last_message_at on new message
CREATE TRIGGER IF NOT EXISTS trg_message_insert
AFTER INSERT ON messages
BEGIN
    UPDATE conversations
    SET message_count = message_count + 1,
        last_message_at = NEW.created_at,
        token_count_in = token_count_in + COALESCE(NEW.tokens_in, 0),
        token_count_out = token_count_out + COALESCE(NEW.tokens_out, 0),
        updated_at = datetime('now')
    WHERE id = NEW.conversation_id;
END;

-- Decrement count on message delete (soft delete)
CREATE TRIGGER IF NOT EXISTS trg_message_soft_delete
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
    UPDATE conversations
    SET message_count = message_count - 1,
        updated_at = datetime('now')
    WHERE id = NEW.conversation_id;
END;
