/**
 * Approval Subsystem Types
 *
 * Defines interfaces for human approval workflows.
 */

import { z } from 'zod';
import type { SystemScope } from '../api/middleware/org-scope.js';

// ============================================================================
// Approval Status
// ============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

// ============================================================================
// Org scope (QF-MT WP6)
// ============================================================================

/**
 * Org scope accepted by every ApprovalStore read/mutate — a tenant org id or
 * the explicit cross-org SYSTEM_SCOPE sentinel. Mirrors `WorkflowOrgScope`
 * (api/stores/workflow-store.ts). Type-only import of `SystemScope` from
 * org-scope.ts — erased at compile time, so it does not introduce a runtime
 * dependency cycle with api/types.ts (which imports ApprovalEngine from
 * ./index.js only for a type position).
 *
 * REQUIRED on every store/engine method (mirrors WorkflowOrgScope) — an
 * absent scope must be a compile error, not silent cross-org (plan §4).
 * Non-route callers that legitimately need full visibility (executors
 * creating approvals during a run pass no scope to `create()`, which derives
 * org from `metadata.orgId`; trigger-bootstrap's startup scan; validation
 * agents; direct unit tests against the store) pass `SYSTEM_SCOPE` loudly
 * and explicitly rather than relying on an implicit default.
 */
export type ApprovalOrgScope = string | SystemScope;

// ============================================================================
// Approval Request
// ============================================================================

export const ApprovalTriggerSchema = z.object({
  policyId: z.string(),
  ruleId: z.string(),
  condition: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type ApprovalTrigger = z.infer<typeof ApprovalTriggerSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  /** Tenant owner of this approval. Populated from the org_id column
   * (Postgres) / in-memory orgId field. Absent/'default' = legacy or
   * system-authored row, visible to SYSTEM_SCOPE reads only (QF-MT WP6). */
  orgId: z.string().optional(),
  correlationId: z.string(),
  workflowId: z.string(),
  workflowName: z.string().optional(),
  executionId: z.string(),
  nodeId: z.string().optional(),
  trigger: ApprovalTriggerSchema,
  approvers: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  createdAt: z.string(),
  expiresAt: z.string(),
  resolvedBy: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  resolution: z.object({
    decision: z.enum(['approved', 'denied']),
    comment: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ============================================================================
// Approval Response
// ============================================================================

export interface ApprovalResponse {
  approvalId: string;
  decision: 'approved' | 'denied';
  approver: string;
  comment?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// ============================================================================
// Create Approval Request
// ============================================================================

export interface CreateApprovalRequest {
  correlationId: string;
  workflowId: string;
  workflowName?: string;
  executionId: string;
  nodeId?: string;
  trigger: ApprovalTrigger;
  approvers: string[];
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Approval Store Interface
// ============================================================================

export interface ApprovalListOptions {
  status?: ApprovalStatus;
  workflowId?: string;
  correlationId?: string;
  approver?: string;
  limit?: number;
  offset?: number;
}

export interface ApprovalStore {
  /**
   * Initialize the store (create tables if needed)
   */
  init(): Promise<void>;

  /**
   * Create a new approval request
   */
  create(request: CreateApprovalRequest): Promise<ApprovalRequest>;

  /**
   * Get an approval request by ID. QF-MT WP6: `scope` filters by org — a
   * cross-org id (or an unbackfilled legacy row read by a tenant scope)
   * returns null, same as a missing row (hides existence). REQUIRED — pass
   * SYSTEM_SCOPE explicitly for full visibility.
   */
  get(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null>;

  /**
   * Get approval request by correlation ID. Scoped like `get()`.
   */
  getByCorrelationId(correlationId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null>;

  /**
   * List approval requests with filtering. Scoped like `get()`.
   */
  list(options: ApprovalListOptions | undefined, scope: ApprovalOrgScope): Promise<ApprovalRequest[]>;

  /**
   * Count approval requests. Scoped like `get()`.
   */
  count(options: Omit<ApprovalListOptions, 'limit' | 'offset'> | undefined, scope: ApprovalOrgScope): Promise<number>;

  /**
   * Resolve an approval request (approve or deny). Scoped like `get()` — a
   * cross-org id behaves exactly like a not-found/not-pending id (same error).
   */
  resolve(id: string, response: ApprovalResponse, scope: ApprovalOrgScope): Promise<ApprovalRequest>;

  /**
   * Resolve a multi-stakeholder approval — writes updated metadata alongside status.
   * For single-approver flows this behaves identically to resolve().
   */
  resolveMulti(id: string, response: ApprovalResponse, updatedMetadata: Record<string, unknown>): Promise<ApprovalRequest>;

  /**
   * Update metadata on a pending approval without changing status.
   * Used by multi-stakeholder flows to accumulate per-approver decisions.
   */
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<ApprovalRequest>;

  /**
   * Atomically record a multi-stakeholder decision. Returns the updated approval.
   * Handles threshold check internally so callers need no separate read-modify-write.
   * decision='approved' accumulates; decision='denied' short-circuits to denied.
   */
  recordMultiDecision(
    id: string,
    approver: string,
    decision: 'approved' | 'denied',
    comment?: string
  ): Promise<ApprovalRequest>;

  /**
   * Cancel an approval request. Scoped like `get()`.
   */
  cancel(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest>;

  /**
   * Expire old pending approval requests
   */
  expireOld(): Promise<number>;

  /**
   * Get pending approvals for a specific approver. Scoped like `get()`.
   */
  getPendingForApprover(approver: string, scope: ApprovalOrgScope): Promise<ApprovalRequest[]>;

  /**
   * Close the store
   */
  close(): Promise<void>;
}
