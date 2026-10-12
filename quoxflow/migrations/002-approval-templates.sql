-- Migration 002: Approval Templates — STUDY-REV-2 P8.C.1
--
-- Adds approval_templates table for reusable multi-stakeholder approval rosters.
-- Also adds policy_id column to approvals table for policy-injected traceability.
--
-- TRUST-GATE fresh-DB fix (2026-07-02): `approvals` was historically created
-- only by runtime store code (CREATE TABLE IF NOT EXISTS in
-- src/approval/approval-store.ts), never by an earlier migration. Same
-- disease as migration 004/skill_library: on a genuinely fresh DB this
-- migration's ALTER TABLE approvals would fail with "relation approvals does
-- not exist" (order 001->002->...). Prepending the canonical CREATE TABLE
-- (copied verbatim from approval-store.ts) makes this migration
-- self-sufficient. Safe to re-run: all objects use IF NOT EXISTS.

-- approvals table (mirrors src/approval/approval-store.ts PostgresApprovalStore.init())
CREATE TABLE IF NOT EXISTS approvals (
    id VARCHAR(26) PRIMARY KEY,
    org_id VARCHAR(255) NOT NULL DEFAULT 'default',
    correlation_id VARCHAR(255) NOT NULL,
    workflow_id VARCHAR(100) NOT NULL,
    workflow_name VARCHAR(255),
    execution_id VARCHAR(26) NOT NULL,
    node_id VARCHAR(100),
    trigger JSONB NOT NULL,
    approvers JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_by VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    resolution JSONB,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_approvals_org_id ON approvals(org_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_correlation ON approvals(correlation_id);
CREATE INDEX IF NOT EXISTS idx_approvals_workflow ON approvals(workflow_id);
CREATE INDEX IF NOT EXISTS idx_approvals_expires ON approvals(expires_at) WHERE status = 'pending';

-- approval_templates table (mirrors policies table pattern)
CREATE TABLE IF NOT EXISTS approval_templates (
    id VARCHAR(100) PRIMARY KEY,
    org_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    approvers JSONB NOT NULL DEFAULT '[]',
    escalation_chain JSONB NOT NULL DEFAULT '[]',
    timeout_ms BIGINT DEFAULT 86400000,
    multi_party_threshold INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_templates_org_id ON approval_templates(org_id);

-- Add policy_id to approvals table for policy-injected approval traceability
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS policy_id VARCHAR(100);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS policy_injected BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_approvals_policy_id ON approvals(policy_id);
