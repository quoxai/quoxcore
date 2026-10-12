-- QSKL-HARDEN HRD-1: Two-layer skill overrides
--
-- Skills (quox_skills) are immutable-versioned, multi-tenant PG rows. Per-org
-- and per-user customisation of a handful of non-behavioural display fields
-- (description, notes, display_category, default_params) must not mutate the
-- canonical row -- that would break version immutability and the audit trail
-- every patch already produces (quox_skill_patches, skill_firewall_log).
--
-- This table stores overrides out-of-band, keyed by skill NAME (not id) so an
-- override survives a version bump of the underlying skill. Merge precedence
-- (system default -> org override -> user override, last wins) is applied at
-- the serve layer (skill-overrides-merge.ts), never persisted back onto the
-- canonical row. See STREAM_OBSIDIAN_QSKLVOICE_QSKLHARDEN_PLAN.md SS III.4.1.

CREATE TABLE IF NOT EXISTS quox_skill_overrides (
  id            VARCHAR(26) PRIMARY KEY,
  org_id        VARCHAR(255) NOT NULL,
  skill_name    VARCHAR(255) NOT NULL,
  scope         VARCHAR(8) NOT NULL CHECK (scope IN ('org', 'user')),
  user_id       VARCHAR(255),                 -- required when scope='user', NULL when scope='org'
  overrides     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- allowlisted fields only (enforced in code)
  created_by    VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, skill_name, scope, user_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_overrides_lookup
  ON quox_skill_overrides (org_id, skill_name);

CREATE INDEX IF NOT EXISTS idx_skill_overrides_user
  ON quox_skill_overrides (org_id, skill_name, user_id) WHERE scope = 'user';
