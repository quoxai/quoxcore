-- QUOXHAT P1 — authoritative hat storage (QUOXHAT_STUDY.md §3).
-- A hat is a named, bounded capability profile. Three objects:
--   hat record (identity/ownership) -> immutable revisions (definition+digest)
--   -> per-conversation bindings (which hat/revision a conversation wears).
-- Org-scoped throughout; follows the llm_routing_policies precedent
-- (org-scoped versioned server config, validated, audited on change).
-- P1 is storage + manual selection only: nothing here changes execution
-- until P2 wires the collector turn manifest.

CREATE TABLE IF NOT EXISTS quoxhat_hats (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,                  -- stable org-unique slug ('default', 'nsoc', ...)
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,                 -- NULL = org-owned; set = user-owned private hat
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private')),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'published', 'archived')),
  template_key TEXT,                  -- built-in provenance; NULL for custom hats
  template_version INTEGER,           -- installed template version (upgrade detection)
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, key)
);
CREATE INDEX IF NOT EXISTS idx_quoxhat_hats_org ON quoxhat_hats (org_id);

-- Immutable: rows are only ever INSERTed. The store enforces append-only;
-- a definition change = a new (hat_id, revision) row with a fresh digest.
CREATE TABLE IF NOT EXISTS quoxhat_revisions (
  hat_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  digest TEXT NOT NULL,               -- sha256 of canonicalised definition
  change_reason TEXT,
  created_by TEXT,                    -- user id, or 'template:<key>@<version>'
  created_at TEXT NOT NULL,
  PRIMARY KEY (hat_id, revision)
);

CREATE TABLE IF NOT EXISTS quoxhat_org_settings (
  org_id TEXT PRIMARY KEY,
  default_hat_id TEXT,
  selection_mode TEXT NOT NULL DEFAULT 'manual' CHECK (selection_mode IN ('manual', 'automatic', 'hybrid')),
  enforcement TEXT NOT NULL DEFAULT 'preview' CHECK (enforcement IN ('preview', 'enforce')),
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS quoxhat_user_prefs (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  default_hat_id TEXT,
  updated_at TEXT,
  PRIMARY KEY (org_id, user_id)
);

-- Conversation binding: seq is the transition sequence number the study's
-- governed-switch protocol (P5) will compare-and-swap on. Written from P1's
-- manual selection so the schema is exercised before enforcement lands.
CREATE TABLE IF NOT EXISTS quoxhat_bindings (
  org_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  hat_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  selected_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (org_id, conversation_id)
);
