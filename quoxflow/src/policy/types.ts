/**
 * Policy DSL Types
 *
 * Defines the structure for policy definitions, rules, and evaluation results.
 */

import { z } from 'zod';
import type { SystemScope } from '../api/middleware/org-scope.js';

// ============================================================================
// Policy Action Types
// ============================================================================

export const AllowActionSchema = z.object({
  type: z.literal('allow'),
});

export const DenyActionSchema = z.object({
  type: z.literal('deny'),
  reason: z.string(),
});

export const RequireApprovalActionSchema = z.object({
  type: z.literal('require_approval'),
  approvers: z.array(z.string()).min(1),
  timeout_ms: z.number().positive().optional().default(86400000), // 24 hours
});

export const RequireEvidenceActionSchema = z.object({
  type: z.literal('require_evidence'),
});

export const LogActionSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn']),
  message: z.string(),
});

export const PolicyActionSchema = z.discriminatedUnion('type', [
  AllowActionSchema,
  DenyActionSchema,
  RequireApprovalActionSchema,
  RequireEvidenceActionSchema,
  LogActionSchema,
]);

export type PolicyAction = z.infer<typeof PolicyActionSchema>;

// ============================================================================
// Policy Rule
// ============================================================================

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  condition: z.string().min(1), // Expression like "${input.amount > 10000}"
  action: PolicyActionSchema,
  message: z.string().optional(), // Template for messages
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// ============================================================================
// Policy Scope
// ============================================================================

export const PolicyScopeSchema = z.object({
  workflows: z.array(z.string()).optional(), // Workflow IDs or '*' for all
  nodeTypes: z.array(z.string()).optional(), // Node types to apply to
  intents: z.array(z.string()).optional(), // Intent patterns
});

export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

// ============================================================================
// Approval Template
// ============================================================================

export const ApprovalTemplateSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1).max(255),
  approvers: z.array(z.string()).min(1),
  escalation_chain: z.array(z.string()).optional().default([]),
  timeout_ms: z.number().positive().optional().default(86400000), // 24 hours
  multi_party_threshold: z.number().int().min(1).optional().default(1),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ApprovalTemplate = z.infer<typeof ApprovalTemplateSchema>;

// ============================================================================
// Approval Template Store Interface
// ============================================================================

export interface ApprovalTemplateStore {
  init(): Promise<void>;
  create(template: Omit<ApprovalTemplate, 'id' | 'createdAt' | 'updatedAt'>): Promise<ApprovalTemplate>;
  get(id: string, orgId: string): Promise<ApprovalTemplate | null>;
  list(orgId: string): Promise<ApprovalTemplate[]>;
  update(id: string, orgId: string, updates: Partial<Omit<ApprovalTemplate, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>>): Promise<ApprovalTemplate>;
  delete(id: string, orgId: string): Promise<boolean>;
  close(): Promise<void>;
}

// ============================================================================
// Policy Definition
// ============================================================================

export const PolicyDefinitionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  version: z.string().default('1.0'),
  description: z.string().optional(),
  scope: PolicyScopeSchema,
  rules: z.array(PolicyRuleSchema).min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0), // Higher = evaluated first
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  createdBy: z.string().optional(),
  /** P8.C: Governance discriminator — runtime_gate | budget_gate | data_egress */
  governance_kind: z.enum(['runtime_gate', 'budget_gate', 'data_egress']).optional().default('runtime_gate'),
  /** P8.C: When the gate fires — pre_node | pre_workflow | post_workflow */
  gate_position: z.enum(['pre_node', 'pre_workflow', 'post_workflow']).optional().default('pre_node'),
  /** P8.C: Reference to an ApprovalTemplate instead of inline approver list */
  approval_template_id: z.string().optional(),
  /** QF-MT: tenant owner of this policy. Populated from the org_id column in
   * Postgres. Optional on the schema for back-compat with legacy rows/callers
   * that predate org tracking — a policy with no orgId stamped is treated as
   * global/legacy and stays visible to every org (see PolicyOrgScope
   * docstring in this file and orgMatches() in store/policy-store.ts). */
  orgId: z.string().optional(),
});

export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;

// ============================================================================
// Policy Evaluation Results
// ============================================================================

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  condition: string;
  conditionResult: boolean;
  actionTaken: PolicyAction | null; // null if condition was false
  message?: string;
  error?: string;
}

export interface PolicyEvaluationResult {
  policyId: string;
  policyName: string;
  decision: 'allow' | 'deny' | 'pending_approval';
  rulesEvaluated: RuleEvaluationResult[];
  pendingApproval?: {
    approvalId: string;
    approvers: string[];
    timeout_ms: number;
    trigger: {
      policyId: string;
      ruleId: string;
      condition: string;
    };
  };
  reason?: string;
  requiresEvidence: boolean;
  logMessages: Array<{ level: 'info' | 'warn'; message: string }>;
  evaluationMs: number;
}

export interface AggregatedPolicyResult {
  overallDecision: 'allow' | 'deny' | 'pending_approval';
  policiesEvaluated: PolicyEvaluationResult[];
  totalPolicies: number;
  passedPolicies: number;
  failedPolicies: number;
  pendingPolicies: number;
  reason?: string;
  pendingApproval?: PolicyEvaluationResult['pendingApproval'];
  requiresEvidence: boolean;
  evaluationMs: number;
}

// ============================================================================
// Policy Store Types
// ============================================================================

export interface PolicyListOptions {
  enabled?: boolean;
  workflowId?: string;
  limit?: number;
  offset?: number;
}

/**
 * QF-MT WP7: org scope accepted by the store-level read methods — string org
 * id, or the explicit cross-org SYSTEM_SCOPE sentinel. Defense in depth:
 * `policies.ts` routes already do their own tenant filtering (see the
 * `policy.orgId` cross-tenant guards there), but the store itself was
 * previously unfiltered — any caller with a direct store reference (a wiring
 * bug, a future route, a test) got every org's policies. Making scope a
 * required param (never absent-by-accident) closes that gap without changing
 * the routes' existing behaviour: policies with no `orgId` stamped
 * (legacy/global — `orgId` is optional on `PolicyDefinition` for exactly this
 * back-compat reason) remain visible to every org, exactly as `policies.ts`'s
 * route-level filter already treats them. PostgresPolicyStore now persists
 * `orgId` to the `org_id` column (falling back to the `'default'` sentinel
 * when absent) so the SQL-level filters below actually match rows — see the
 * store's docstring.
 */
export type PolicyOrgScope = string | SystemScope;

export interface PolicyStore {
  init(): Promise<void>;
  /** Returns null when the id already exists under a DIFFERENT org — an
   * upsert never reassigns ownership across tenants (routes surface 403). */
  save(policy: PolicyDefinition): Promise<PolicyDefinition | null>;
  get(id: string, scope: PolicyOrgScope): Promise<PolicyDefinition | null>;
  list(scope: PolicyOrgScope, options?: PolicyListOptions): Promise<PolicyDefinition[]>;
  count(scope: PolicyOrgScope, options?: Omit<PolicyListOptions, 'limit' | 'offset'>): Promise<number>;
  update(id: string, updates: Partial<PolicyDefinition>): Promise<PolicyDefinition>;
  delete(id: string): Promise<boolean>;
  /** scope is required — SYSTEM_SCOPE for legitimate cross-org callers. */
  getApplicable(workflowId: string, nodeType: string | undefined, scope: PolicyOrgScope): Promise<PolicyDefinition[]>;
  close(): Promise<void>;
}

// ============================================================================
// Policy Evaluation Context
// ============================================================================

export interface PolicyContext {
  workflowId: string;
  workflowName: string;
  executionId: string;
  correlationId: string;
  nodeId?: string;
  nodeType?: string;
  input: unknown;
  variables: Record<string, unknown>;
  env: Record<string, string>;
}
