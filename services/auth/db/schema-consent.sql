-- Schema for AI Data Consent Tracking (Security Issue #72)
-- This addresses: "High: Third-party AI providers receive data without consent"

-- ============================================================================
-- USER CONSENT PREFERENCES
-- ============================================================================

-- User consent preferences for AI data sharing
CREATE TABLE IF NOT EXISTS user_consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    -- Third-party AI provider consent
    -- Must be explicitly granted before sending data to OpenAI, Anthropic, etc.
    ai_data_sharing_consent INTEGER NOT NULL DEFAULT 0,
    ai_data_sharing_consent_at TEXT,  -- When consent was granted

    -- Granular provider consent (JSON object: { "openai": true, "anthropic": true, ... })
    provider_consent_json TEXT DEFAULT '{}',

    -- Consent version tracking (for re-consent on policy changes)
    consent_version TEXT NOT NULL DEFAULT '1.0',

    -- Audit fields
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip_address TEXT,  -- IP when consent was given
    user_agent TEXT   -- User agent when consent was given
);

CREATE INDEX IF NOT EXISTS idx_user_consent_user ON user_consent(user_id);

-- ============================================================================
-- CONSENT CHANGE LOG (Audit Trail)
-- ============================================================================

-- Audit trail for all consent changes
CREATE TABLE IF NOT EXISTS consent_change_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What changed
    consent_type TEXT NOT NULL,  -- 'ai_data_sharing', 'provider_specific', etc.
    old_value TEXT,
    new_value TEXT,

    -- Context
    reason TEXT,  -- 'user_action', 'policy_update', 'gdpr_request', etc.

    -- Audit metadata
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_log_user ON consent_change_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_log_type ON consent_change_log(consent_type, created_at DESC);

-- ============================================================================
-- AI PROVIDER CALL LOG (for consent verification audit)
-- ============================================================================

-- Log of AI provider calls for audit purposes
CREATE TABLE IF NOT EXISTS ai_provider_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    org_id TEXT REFERENCES orgs(id),

    -- Provider details
    provider TEXT NOT NULL,  -- 'openai', 'anthropic', 'perplexity', 'gemini'
    model TEXT,

    -- Consent status at time of call
    consent_verified INTEGER NOT NULL DEFAULT 0,
    consent_user_id TEXT,  -- User whose consent was checked

    -- Call metadata (no PII)
    endpoint TEXT,  -- 'chat', 'embeddings', 'completions'
    success INTEGER NOT NULL DEFAULT 1,
    blocked_reason TEXT,  -- If blocked: 'no_consent', 'consent_expired', etc.

    -- Audit
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_provider_calls(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_provider ON ai_provider_calls(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_blocked ON ai_provider_calls(blocked_reason, created_at DESC) WHERE blocked_reason IS NOT NULL;
