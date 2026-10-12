-- REG-0: Universal Asset Registry foundation (2026-04-12)
--
-- Introduces four governance-metadata tables as the foundation for
-- Phase B "make Quox evidential":
--
--   model_definitions         — model catalog with risk tier, data residency
--   asset_owners              — polymorphic (asset_type, asset_id) → owner
--   asset_data_classes        — polymorphic data classification labels
--   data_class_definitions    — reference/vocabulary for standard classes
--
-- Plus ALTER TABLE additions on the existing `agents` table for governance
-- columns. The agents table lives in schema-b2-tools.sql — we augment it
-- rather than duplicate.
--
-- Pattern: conditional application at auth service startup (db/index.js)
-- guarded by a check for model_definitions existence. Matches how
-- schema-b1.sql / schema-b2-tools.sql are loaded.

-- ============================================================================
-- MODEL REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_definitions (
    id TEXT PRIMARY KEY,                    -- ULID
    model_id TEXT UNIQUE NOT NULL,          -- 'claude-sonnet-4-6', 'gpt-5.4'
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,                 -- 'anthropic', 'openai', 'gemini', 'local'
    provider_model_id TEXT,                 -- exact API string (may differ from model_id)

    -- Capabilities
    context_window INTEGER,                 -- tokens
    supports_vision INTEGER DEFAULT 0,
    supports_tools INTEGER DEFAULT 1,
    supports_streaming INTEGER DEFAULT 1,

    -- Cost tracking
    cost_per_input_mtok REAL,               -- USD per million input tokens
    cost_per_output_mtok REAL,

    -- Governance metadata (the whole point of REG)
    risk_tier TEXT DEFAULT 'standard' CHECK (risk_tier IN ('low', 'standard', 'high', 'critical')),
    data_residency TEXT,                    -- 'us', 'eu', 'global', 'on-premise'
    compliance_certifications TEXT DEFAULT '[]',  -- JSON array: ['SOC2', 'HIPAA', 'ISO27001']
    requires_approval INTEGER DEFAULT 0,    -- 1 = org admin must approve before use

    -- Lifecycle
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'beta', 'deprecated', 'disabled')),
    deprecated_at TEXT,
    replacement_model_id TEXT REFERENCES model_definitions(id),

    -- Metadata
    knowledge_cutoff TEXT,                  -- ISO date string
    is_core INTEGER DEFAULT 1,              -- Quox-shipped default (1) vs user-added (0)

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_def_provider ON model_definitions(provider);
CREATE INDEX IF NOT EXISTS idx_model_def_status ON model_definitions(status);
CREATE INDEX IF NOT EXISTS idx_model_def_risk ON model_definitions(risk_tier);

-- ============================================================================
-- DATA CLASS REFERENCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS data_class_definitions (
    id TEXT PRIMARY KEY,                    -- slug: 'pii', 'credentials', 'financial', etc.
    name TEXT NOT NULL,
    description TEXT,
    default_sensitivity TEXT DEFAULT 'confidential'
        CHECK (default_sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
    compliance_frameworks_json TEXT DEFAULT '[]',   -- ['gdpr', 'hipaa']
    sort_order INTEGER DEFAULT 0
);

-- ============================================================================
-- CROSS-CUTTING: ASSET OWNERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_owners (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,               -- 'agent', 'tool', 'workflow', 'model', 'plugin', 'integration'
    asset_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'team', 'system')),
    owner_id TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,           -- 1 = the accountable owner (1 per asset)
    role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'steward', 'reviewer')),
    assigned_by TEXT,
    assigned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(asset_type, asset_id, owner_type, owner_id, role)
);

CREATE INDEX IF NOT EXISTS idx_asset_owners_asset ON asset_owners(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_owners_owner ON asset_owners(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_asset_owners_org ON asset_owners(org_id);

-- ============================================================================
-- CROSS-CUTTING: ASSET DATA CLASSES
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_data_classes (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    data_class TEXT NOT NULL,               -- references data_class_definitions.id
    sensitivity TEXT DEFAULT 'internal'
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
    classified_by TEXT,
    classified_at TEXT DEFAULT (datetime('now')),
    UNIQUE(asset_type, asset_id, data_class)
);

CREATE INDEX IF NOT EXISTS idx_asset_data_classes_asset ON asset_data_classes(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_data_classes_class ON asset_data_classes(data_class);
