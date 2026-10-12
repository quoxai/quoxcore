-- Migration 007: QuoxSkills substrate — QSKL-1
-- Procedural-knowledge layer distinct from the legacy skill_library (Crystals).
-- All table names prefixed quox_* to avoid collision with existing crystal tables.
--
-- Safe to re-run: all objects use IF NOT EXISTS.
-- Added 2026-05-10

-- ─── QSKL-1: Core skills table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quox_skills (
  id                      VARCHAR(26) PRIMARY KEY,          -- ULID

  org_id                  VARCHAR(255) NOT NULL,
  scope_id                VARCHAR(26),                      -- org/div/dept scope
  name                    VARCHAR(255) NOT NULL,            -- 'github-code-review'
  category                VARCHAR(64) NOT NULL,             -- 'github'
  description             TEXT NOT NULL,
  version                 VARCHAR(16) NOT NULL DEFAULT '1.0.0',
  superseded_by           VARCHAR(26),                      -- FK to quox_skills.id on patch promotion
  edition                 VARCHAR(16) NOT NULL DEFAULT 'experimental',
                          -- 'experimental' | 'beta' | 'stable' | 'deprecated'

  -- Authorship + provenance
  author                  VARCHAR(255) NOT NULL,            -- 'quox-core' | 'agent:sentinel' | 'user:admin@...'
  authoring_envelope_id   VARCHAR(26),                      -- AOCL provenance link
  last_patched_by         VARCHAR(255),
  last_patch_envelope_id  VARCHAR(26),

  -- Discovery + composition
  tags                    JSONB DEFAULT '[]'::jsonb,
  related_skills          JSONB DEFAULT '[]'::jsonb,
                          -- [{skill_id, relation: 'requires'|'composes'|'extends'|'supersedes'}]
  required_tools          JSONB DEFAULT '[]'::jsonb,
                          -- [{name, version_constraint, must_satisfy_policy}]
  required_capabilities   JSONB DEFAULT '[]'::jsonb,
  best_for_agents         JSONB DEFAULT '[]'::jsonb,        -- ['sentinel', 'cipher']
  delegate_targets        JSONB DEFAULT '[]'::jsonb,        -- [{step, to_agent, sub_skill, expected_output}]
  llm_preference          JSONB,                            -- {model: 'sonnet', max_tokens: ...}
  model_directives        JSONB DEFAULT '{}'::jsonb,        -- {model_id: directive_text} per-model overrides

  -- Body + assets
  body_md                 TEXT NOT NULL,                    -- the SKILL.md content
  refs                    JSONB DEFAULT '{}'::jsonb,        -- {filename: content_b64 | uri}
  scripts                 JSONB DEFAULT '{}'::jsonb,        -- {filename: content_b64}
  tests                   JSONB DEFAULT '{}'::jsonb,        -- {test_name: {input, expects}}
  -- NOTE: embedding VECTOR(1024) omitted — pgvector may not be installed.
  --       Add in QSKL-2 if needed.
  kind                    VARCHAR(16) DEFAULT 'procedural', -- 'procedural' | 'multimodal'

  -- Governance
  policy_satisfies        JSONB DEFAULT '[]'::jsonb,        -- AOCL policy IDs claimed
  policy_required         JSONB DEFAULT '[]'::jsonb,        -- policies the engine must enforce
  signature               TEXT,                             -- Ed25519 signature when published
  signed_by               VARCHAR(255),

  -- Telemetry + lifecycle (denormalised from materialised view for fast reads)
  evals                   JSONB DEFAULT '{}'::jsonb,
                          -- {success_rate_30d, avg_cost_usd, avg_latency_ms,
                          --  crystal_hit_rate, drift_trend, judge_score, last_run_at}
  last_used_at            TIMESTAMP WITH TIME ZONE,
  last_patched_at         TIMESTAMP WITH TIME ZONE,
  decay_state             VARCHAR(16) DEFAULT 'active',
                          -- 'active' | 'cooling' (60-180d) | 'archive_candidate' (180d+)

  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE (org_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_quox_skills_org            ON quox_skills (org_id);
CREATE INDEX IF NOT EXISTS idx_quox_skills_category       ON quox_skills (category);
CREATE INDEX IF NOT EXISTS idx_quox_skills_edition        ON quox_skills (edition);
CREATE INDEX IF NOT EXISTS idx_quox_skills_tags           ON quox_skills USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_quox_skills_required_tools ON quox_skills USING GIN (required_tools);
CREATE INDEX IF NOT EXISTS idx_quox_skills_best_for       ON quox_skills USING GIN (best_for_agents);
CREATE INDEX IF NOT EXISTS idx_quox_skills_last_used      ON quox_skills (last_used_at);


-- ─── QSKL-4 forward-ref: Patch attempts + Crystal eval results ─────────────

CREATE TABLE IF NOT EXISTS quox_skill_patches (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  from_version            VARCHAR(16) NOT NULL,
  to_version              VARCHAR(16) NOT NULL,
  patched_by              VARCHAR(255) NOT NULL,
  reason                  TEXT,
  diff                    JSONB NOT NULL,
                          -- {from_body_md, to_body_md, step_diff?}
  tests_run               INT DEFAULT 0,
  tests_passed            INT DEFAULT 0,
  crystals_evaluated      INT DEFAULT 0,
  crystals_passed         INT DEFAULT 0,
  crystals_failed         JSONB DEFAULT '[]'::jsonb,        -- [{crystal_id, failure_trace}]
  outcome                 VARCHAR(16) NOT NULL,             -- 'promoted' | 'reverted' | 'pending_hitl'
  envelope_id             VARCHAR(26),                      -- VOLT evidence link
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quox_skill_patches_skill   ON quox_skill_patches (skill_id);
CREATE INDEX IF NOT EXISTS idx_quox_skill_patches_outcome ON quox_skill_patches (outcome);


-- ─── QSKL-7 forward-ref: Skill invocation telemetry ───────────────────────

CREATE TABLE IF NOT EXISTS quox_skill_invocations (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  skill_version           VARCHAR(16) NOT NULL,
  agent_id                VARCHAR(64) NOT NULL,
  session_id              VARCHAR(26),
  org_id                  VARCHAR(255) NOT NULL,
  crystal_id              VARCHAR(26),                      -- non-null if Crystal replay served this
  tokens_used             INT,
  cost_usd                NUMERIC(10, 6),
  latency_ms              INT,
  success                 BOOLEAN,
  drift_score             NUMERIC(5, 4),
  envelope_id             VARCHAR(26),
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_skill  ON quox_skill_invocations (skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_agent  ON quox_skill_invocations (agent_id);
CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_org    ON quox_skill_invocations (org_id);


-- ─── QSKL-8 forward-ref: Marketplace publication tracking ─────────────────

CREATE TABLE IF NOT EXISTS quox_skill_publications (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  curator_index           VARCHAR(255) NOT NULL,            -- 'quox-core@official' | self-hosted url
  published_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  signature               TEXT NOT NULL,
  safety_review_envelope  VARCHAR(26),
  judge_score             NUMERIC(3, 2),
  status                  VARCHAR(16) DEFAULT 'pending',    -- 'pending' | 'live' | 'recalled'
  recall_reason           TEXT,
  telemetry_optin         BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_quox_skill_publications_skill ON quox_skill_publications (skill_id);


-- ─── QSKL-11 forward-ref: Capability negotiation log ──────────────────────

CREATE TABLE IF NOT EXISTS quox_capability_broadcasts (
  id                      VARCHAR(26) PRIMARY KEY,
  org_id                  VARCHAR(255) NOT NULL,
  requesting_agent        VARCHAR(64) NOT NULL,
  description             TEXT NOT NULL,
  responding_agents       JSONB DEFAULT '[]'::jsonb,        -- [{agent_id, skill_id, score}]
  selected_agent          VARCHAR(64),
  selected_skill          VARCHAR(26),
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quox_capability_broadcasts_org ON quox_capability_broadcasts (org_id, created_at);
