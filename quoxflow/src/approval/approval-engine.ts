/**
 * Approval Engine
 *
 * Manages the lifecycle of approval requests, including creation,
 * resolution, and notifications.
 */

import { ulid } from 'ulid';
import {
  ApprovalRequest,
  ApprovalStore,
  ApprovalResponse,
  CreateApprovalRequest,
  ApprovalTrigger,
  ApprovalOrgScope,
} from './types.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';

export interface ApprovalEngineConfig {
  store: ApprovalStore;
  defaultTimeoutMs?: number;
  onApprovalCreated?: (approval: ApprovalRequest) => void | Promise<void>;
  onApprovalResolved?: (approval: ApprovalRequest) => void | Promise<void>;
  onApprovalExpired?: (approval: ApprovalRequest) => void | Promise<void>;
  onApprovalCancelled?: (approval: ApprovalRequest) => void | Promise<void>;
}

export interface PendingApprovalInfo {
  approvalId: string;
  approvers: string[];
  timeout_ms: number;
  trigger: ApprovalTrigger;
}

export class ApprovalEngine {
  private store: ApprovalStore;
  private defaultTimeoutMs: number;
  private onApprovalCreated?: (approval: ApprovalRequest) => void | Promise<void>;
  private onApprovalResolved?: (approval: ApprovalRequest) => void | Promise<void>;
  private onApprovalExpired?: (approval: ApprovalRequest) => void | Promise<void>;
  private onApprovalCancelled?: (approval: ApprovalRequest) => void | Promise<void>;

  constructor(config: ApprovalEngineConfig) {
    this.store = config.store;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 86400000; // 24 hours
    this.onApprovalCreated = config.onApprovalCreated;
    this.onApprovalResolved = config.onApprovalResolved;
    this.onApprovalExpired = config.onApprovalExpired;
    this.onApprovalCancelled = config.onApprovalCancelled;
  }

  /**
   * Create a new approval request from pending approval info
   */
  async createFromPendingApproval(
    pendingApproval: PendingApprovalInfo,
    context: {
      correlationId: string;
      workflowId: string;
      workflowName?: string;
      executionId: string;
      nodeId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ApprovalRequest> {
    const request: CreateApprovalRequest = {
      correlationId: context.correlationId,
      workflowId: context.workflowId,
      workflowName: context.workflowName,
      executionId: context.executionId,
      nodeId: context.nodeId,
      trigger: pendingApproval.trigger,
      approvers: pendingApproval.approvers,
      timeoutMs: pendingApproval.timeout_ms || this.defaultTimeoutMs,
      metadata: context.metadata,
    };

    const approval = await this.store.create(request);

    if (this.onApprovalCreated) {
      await this.onApprovalCreated(approval);
    }

    return approval;
  }

  /**
   * Create a new approval request directly
   */
  async createApproval(request: CreateApprovalRequest): Promise<ApprovalRequest> {
    const approval = await this.store.create({
      ...request,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
    });

    if (this.onApprovalCreated) {
      await this.onApprovalCreated(approval);
    }

    return approval;
  }

  /**
   * Multi-stakeholder approve: record one approver's decision and complete
   * if the approval count reaches the threshold stored in metadata.threshold.
   *
   * Threshold semantics:
   *   - threshold defaults to 1 (single-approver, legacy behaviour)
   *   - When approve-count >= threshold → status flips to 'approved'
   *   - Any 'denied' decision short-circuits to 'denied' immediately
   *
   * Concurrent-safety: the store's recordMultiDecision method serialises
   * concurrent calls per approvalId via an async mutex chain (in-memory store)
   * or pg_advisory_xact_lock (PostgreSQL store). Callers do not need
   * additional synchronisation.
   */
  async approveMulti(
    approvalId: string,
    approver: string,
    comment?: string
  ): Promise<ApprovalRequest> {
    const updated = await this.store.recordMultiDecision(approvalId, approver, 'approved', comment);
    if (updated.status === 'approved' && this.onApprovalResolved) {
      await this.onApprovalResolved(updated);
    }
    return updated;
  }

  /**
   * Multi-stakeholder deny: any single denial immediately rejects the request.
   */
  async denyMulti(
    approvalId: string,
    approver: string,
    comment?: string
  ): Promise<ApprovalRequest> {
    const updated = await this.store.recordMultiDecision(approvalId, approver, 'denied', comment);
    if (updated.status === 'denied' && this.onApprovalResolved) {
      await this.onApprovalResolved(updated);
    }
    return updated;
  }

  /**
   * Approve an approval request. QF-MT WP6: `scope` is REQUIRED — a
   * defense-in-depth check on top of the caller's own ownership check
   * (routes fetch via `get(id, scope)` first). Callers with no real org
   * concept pass SYSTEM_SCOPE explicitly.
   */
  async approve(
    approvalId: string,
    approver: string,
    comment: string | undefined,
    metadata: Record<string, unknown> | undefined,
    scope: ApprovalOrgScope
  ): Promise<ApprovalRequest> {
    const response: ApprovalResponse = {
      approvalId,
      decision: 'approved',
      approver,
      comment,
      metadata,
      timestamp: new Date().toISOString(),
    };

    const approval = await this.store.resolve(approvalId, response, scope);

    if (this.onApprovalResolved) {
      await this.onApprovalResolved(approval);
    }

    return approval;
  }

  /**
   * Deny an approval request. Scoped like `approve()`.
   */
  async deny(
    approvalId: string,
    approver: string,
    comment: string | undefined,
    metadata: Record<string, unknown> | undefined,
    scope: ApprovalOrgScope
  ): Promise<ApprovalRequest> {
    const response: ApprovalResponse = {
      approvalId,
      decision: 'denied',
      approver,
      comment,
      metadata,
      timestamp: new Date().toISOString(),
    };

    const approval = await this.store.resolve(approvalId, response, scope);

    if (this.onApprovalResolved) {
      await this.onApprovalResolved(approval);
    }

    return approval;
  }

  /**
   * Cancel an approval request. Scoped like `approve()`.
   */
  async cancel(approvalId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest> {
    const cancelled = await this.store.cancel(approvalId, scope);
    // Fire the cancellation hook so downstream mirrors (the auth-service inbox
    // item created by onApprovalCreated) can be resolved, otherwise a cancelled
    // approval leaves an open dead-link inbox item that can never be actioned.
    if (this.onApprovalCancelled) {
      await this.onApprovalCancelled(cancelled);
    }
    return cancelled;
  }

  /**
   * Get an approval request by ID. Scoped — cross-org returns null (hides
   * existence). `scope` is REQUIRED; pass SYSTEM_SCOPE explicitly for full
   * visibility.
   */
  async get(approvalId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    return this.store.get(approvalId, scope);
  }

  /**
   * Get an approval request by correlation ID. Scoped like `get()`.
   */
  async getByCorrelationId(correlationId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    return this.store.getByCorrelationId(correlationId, scope);
  }

  /**
   * Get pending approvals for a specific approver. Scoped like `get()`.
   */
  async getPendingForApprover(approver: string, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    return this.store.getPendingForApprover(approver, scope);
  }

  /**
   * List all approval requests with optional filtering. Scoped like `get()`.
   * `scope` is REQUIRED, so `options` is typed `X | undefined` (not `?`) —
   * still positionally required (pass `undefined` explicitly to omit it),
   * since TS forbids a required parameter following an optional one.
   */
  async list(options: {
    status?: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
    workflowId?: string;
    correlationId?: string;
    approver?: string;
    limit?: number;
    offset?: number;
  } | undefined, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    return this.store.list(options, scope);
  }

  /**
   * Count approval requests. Scoped like `get()`. See `list()` re: `options`.
   */
  async count(options: {
    status?: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
    workflowId?: string;
    correlationId?: string;
    approver?: string;
  } | undefined, scope: ApprovalOrgScope): Promise<number> {
    return this.store.count(options, scope);
  }

  /**
   * Process expired approval requests
   * Should be called periodically (e.g., every minute)
   *
   * QF-MT WP6: this is a system-wide maintenance sweep across ALL orgs
   * (mirrors the admin/expire route, which is intentionally left unscoped —
   * see approvals.ts) — SYSTEM_SCOPE is passed explicitly, not implicitly.
   */
  async processExpired(): Promise<number> {
    // Get expired approvals before marking them
    const expiredApprovals = await this.store.list({ status: 'pending' }, SYSTEM_SCOPE);
    const now = new Date();
    const actuallyExpired = expiredApprovals.filter(
      a => new Date(a.expiresAt) < now
    );

    // Mark as expired in store
    const expiredCount = await this.store.expireOld();

    // Notify for each expired approval
    if (this.onApprovalExpired && actuallyExpired.length > 0) {
      for (const approval of actuallyExpired) {
        const updated = await this.store.get(approval.id, SYSTEM_SCOPE);
        if (updated && updated.status === 'expired') {
          await this.onApprovalExpired(updated);
        }
      }
    }

    return expiredCount;
  }

  /**
   * Check if an approver is authorized to resolve an approval
   */
  isAuthorizedApprover(approval: ApprovalRequest, approver: string): boolean {
    // Check if approver is in the list
    if (approval.approvers.includes(approver)) {
      return true;
    }

    // Check for wildcard
    if (approval.approvers.includes('*')) {
      return true;
    }

    // Check for group patterns (e.g., "team:engineering")
    for (const allowedApprover of approval.approvers) {
      if (allowedApprover.startsWith('group:')) {
        // In a real implementation, this would check group membership
        // For now, we just check if the approver matches the group
        const groupName = allowedApprover.slice(6);
        if (approver === groupName || approver.startsWith(`${groupName}:`)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get summary statistics for approvals. Scoped like `get()`.
   */
  async getStats(scope: ApprovalOrgScope): Promise<{
    pending: number;
    approved: number;
    denied: number;
    expired: number;
    cancelled: number;
    total: number;
  }> {
    const [pending, approved, denied, expired, cancelled] = await Promise.all([
      this.store.count({ status: 'pending' }, scope),
      this.store.count({ status: 'approved' }, scope),
      this.store.count({ status: 'denied' }, scope),
      this.store.count({ status: 'expired' }, scope),
      this.store.count({ status: 'cancelled' }, scope),
    ]);

    return {
      pending,
      approved,
      denied,
      expired,
      cancelled,
      total: pending + approved + denied + expired + cancelled,
    };
  }
}

/**
 * Create an approval engine instance
 */
export function createApprovalEngine(config: ApprovalEngineConfig): ApprovalEngine {
  return new ApprovalEngine(config);
}
