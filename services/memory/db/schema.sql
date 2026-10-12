-- QuoxCORE Memory Service Schema
-- SQLite with FTS5 for full-text search

-- Core memory storage
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,                    -- ULID
  org_id TEXT NOT NULL,                   -- Tenant isolation
  user_id TEXT NOT NULL,                  -- User who owns this
  agent_id TEXT,                          -- Agent that created it (null = system/migration)

  memory_type TEXT NOT NULL,              -- fact, preference, decision, entity, constraint, observation
  content TEXT NOT NULL,                  -- The actual memory
  importance TEXT DEFAULT 'medium',       -- low, medium, high, critical
  stability TEXT DEFAULT 'stable',        -- volatile (7d), stable (30d), permanent (1y)

  tags TEXT,                              -- JSON array
  provenance TEXT DEFAULT 'model_inference', -- tool_output, explicit_command, user_stated, model_inference
  confidence REAL DEFAULT 0.8,            -- 0.0 to 1.0

  source_conversation_id TEXT,            -- AEE corr ID
  source_message_id TEXT,                 -- AEE envelope ID

  memory_role TEXT DEFAULT 'fact' CHECK (memory_role IN ('fact', 'procedure', 'session_history')), -- QSKL-1: three-layer split

  valid INTEGER DEFAULT 1,                -- Soft delete (1=valid, 0=deleted)
  superseded_by TEXT,                     -- Points to newer version
  verified_at TEXT,                       -- Human verification timestamp (ISO)
  verified_by TEXT,                       -- Who verified
  metadata TEXT,                          -- JSON object for consolidation/audit data

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0
);

-- Core memories (always-loaded context, <500 tokens each)
CREATE TABLE IF NOT EXISTS core_memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,                 -- Per-agent core memories

  label TEXT NOT NULL,                    -- user_profile, project_context, preferences, infrastructure
  content TEXT NOT NULL,                  -- Compact summary
  token_count INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, user_id, agent_id, label)
);

-- Entities (people, systems, concepts)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,              -- person, host, service, concept, location, container, network, file
  attributes TEXT,                        -- JSON object

  first_seen TEXT DEFAULT (datetime('now')),
  last_referenced TEXT DEFAULT (datetime('now')),
  reference_count INTEGER DEFAULT 1,

  UNIQUE(org_id, user_id, name, entity_type)
);

-- Entity relationships (knowledge graph)
CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  source_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,            -- owns, uses, depends_on, manages, runs_on, hosts, monitors, stores_data_for
  target_entity_id TEXT NOT NULL,

  context TEXT,                           -- Why this relation exists
  confidence REAL DEFAULT 0.8,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_entity_id, relation_type, target_entity_id),
  FOREIGN KEY (source_entity_id) REFERENCES entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES entities(id)
);

-- Conversation summaries (for long-term memory)
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL UNIQUE,   -- AEE corr ID
  agent_id TEXT NOT NULL,

  summary TEXT NOT NULL,                  -- LLM-generated
  key_facts TEXT,                         -- JSON array
  entities_mentioned TEXT,                -- JSON array of entity IDs

  message_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now'))
);

-- Migration tracking
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,                   -- localStorage, import
  memories_count INTEGER DEFAULT 0,
  entities_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',          -- pending, completed, failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Regular indexes
CREATE INDEX IF NOT EXISTS idx_memories_org_user ON memories(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(valid);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(source_conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_role ON memories(memory_role);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

CREATE INDEX IF NOT EXISTS idx_core_org_user_agent ON core_memories(org_id, user_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_entities_org_user ON entities(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);

CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON conversation_summaries(conversation_id);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON conversation_summaries(user_id);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name,
  attributes,
  content='entities',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS triggers for automatic sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (NEW.rowid, NEW.content, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', OLD.rowid, OLD.content, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', OLD.rowid, OLD.content, OLD.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (NEW.rowid, NEW.content, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, attributes) VALUES (NEW.rowid, NEW.name, NEW.attributes);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, attributes) VALUES('delete', OLD.rowid, OLD.name, OLD.attributes);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, attributes) VALUES('delete', OLD.rowid, OLD.name, OLD.attributes);
  INSERT INTO entities_fts(rowid, name, attributes) VALUES (NEW.rowid, NEW.name, NEW.attributes);
END;

-- ============================================================================
-- AUDIT ENVELOPES (AEE protocol)
-- Fire-and-forget mutation audit trail for the memory service.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_envelopes (
  id TEXT PRIMARY KEY,                       -- ULID
  ts TEXT NOT NULL,                          -- ISO timestamp
  intent TEXT NOT NULL,                      -- e.g. quox.memory.created
  from_addr TEXT DEFAULT 'service.memory',
  to_addr TEXT NOT NULL,
  payload TEXT,                              -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_intent ON audit_envelopes(intent);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_envelopes(ts);

-- ============================================================================
-- MEMORY QUOTAS & TIER TRACKING
-- Enforces free/premium limits server-side. Frontend also enforces for UX.
-- ============================================================================

CREATE TABLE IF NOT EXISTS memory_quotas (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  tier TEXT NOT NULL DEFAULT 'free',        -- 'free' or 'premium'
  tier_source TEXT DEFAULT 'default',       -- 'default', 'plugin', 'admin_override', 'trial'
  tier_expires_at TEXT,                     -- NULL for permanent, ISO date for trials

  learned_count INTEGER DEFAULT 0,          -- facts + preferences + decisions + constraints
  preference_count INTEGER DEFAULT 0,       -- preferences subset
  episodic_count INTEGER DEFAULT 0,         -- conversation summaries
  entity_count INTEGER DEFAULT 0,           -- entities tracked

  last_reset_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_quotas_tier ON memory_quotas(tier);

-- ============================================================================
-- CONVERSATION ARCHIVES
-- Full conversation storage for imported AI conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_archives (
  id TEXT PRIMARY KEY,                         -- ULID
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,        -- Original platform conversation ID
  platform TEXT NOT NULL,                      -- 'chatgpt', 'claude', 'perplexity'
  title TEXT NOT NULL,
  summary TEXT,
  message_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  topics TEXT,                                 -- JSON array of topic strings
  entities_mentioned TEXT,                     -- JSON array
  first_message_at TEXT,                       -- Earliest message timestamp
  last_message_at TEXT,                        -- Latest message timestamp
  metadata TEXT,                               -- JSON: { model, source_format, ... }
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,                         -- ULID
  conversation_archive_id TEXT NOT NULL,       -- FK to conversation_archives
  message_idx INTEGER NOT NULL,                -- Order in thread (0-based)
  role TEXT NOT NULL,                          -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,
  model TEXT,                                  -- Model used for this message
  created_at TEXT,                             -- Message timestamp (ISO)
  platform_message_id TEXT,                    -- Original platform message ID
  FOREIGN KEY (conversation_archive_id) REFERENCES conversation_archives(id),
  UNIQUE(conversation_archive_id, message_idx)
);

-- Indexes for conversation archive queries
CREATE INDEX IF NOT EXISTS idx_conv_org_user ON conversation_archives(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversation_archives(platform);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversation_archives(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_conversation_id ON conversation_archives(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msgs_conv ON conversation_messages(conversation_archive_id, message_idx);
CREATE INDEX IF NOT EXISTS idx_msgs_role ON conversation_messages(role);

-- ============================================================================
-- IDENTITY BLOBS (TRUST-GATE-1.15 / 1.16)
-- Namespaced document-shaped storage for user "identity" data that used to
-- live ONLY in browser localStorage (profile, projects, narratives,
-- syntheses, trends, personalization, reflection_state,
-- importance_evolution, alerts). One row per (org, user, namespace);
-- versioned by updated_at rather than bespoke per-namespace schemas.
-- ============================================================================

CREATE TABLE IF NOT EXISTS identity_blobs (
  id TEXT PRIMARY KEY,                       -- ULID
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,                   -- profile, projects, narratives, syntheses, trends, personalization, reflection_state, importance_evolution, alerts
  content_json TEXT NOT NULL,                -- JSON document (arbitrary shape per namespace)
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_id, user_id, namespace)
);

CREATE INDEX IF NOT EXISTS idx_identity_org_user ON identity_blobs(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_identity_namespace ON identity_blobs(namespace);

-- Full-text search for conversation archives
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  title,
  summary,
  topics,
  content='conversation_archives',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS triggers for conversation archives
CREATE TRIGGER IF NOT EXISTS conv_ai AFTER INSERT ON conversation_archives BEGIN
  INSERT INTO conversation_fts(rowid, title, summary, topics)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.topics);
END;

CREATE TRIGGER IF NOT EXISTS conv_ad AFTER DELETE ON conversation_archives BEGIN
  INSERT INTO conversation_fts(conversation_fts, rowid, title, summary, topics)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.topics);
END;

CREATE TRIGGER IF NOT EXISTS conv_au AFTER UPDATE ON conversation_archives BEGIN
  INSERT INTO conversation_fts(conversation_fts, rowid, title, summary, topics)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.topics);
  INSERT INTO conversation_fts(rowid, title, summary, topics)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.topics);
END;
