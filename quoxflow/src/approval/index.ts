/**
 * Approval Module
 *
 * Exports all approval-related types, classes, and utilities.
 */

// Types
export {
  type ApprovalStatus,
  type ApprovalTrigger,
  type ApprovalRequest,
  type ApprovalResponse,
  type CreateApprovalRequest,
  type ApprovalListOptions,
  type ApprovalStore,
  type ApprovalOrgScope,
  ApprovalTriggerSchema,
  ApprovalRequestSchema,
} from './types.js';

// Store implementations
export {
  InMemoryApprovalStore,
  PostgresApprovalStore,
  createInMemoryApprovalStore,
  createPostgresApprovalStore,
} from './approval-store.js';

// Engine
export {
  ApprovalEngine,
  createApprovalEngine,
  type ApprovalEngineConfig,
  type PendingApprovalInfo,
} from './approval-engine.js';

// Expiry scheduler (#499)
export {
  scheduleApprovalExpirySweep,
  type ApprovalExpiryEngine,
  type ScheduleApprovalExpirySweepOpts,
  type ApprovalExpirySchedulerHandle,
  type ApprovalExpirySchedulerStats,
} from './approval-expiry-scheduler.js';

/**
 * TRUST-PROOF twin-item fix (FND_01M2XM4SJHGW46P447XAGW46P4): a caller that
 * mints and owns its own human-facing inbox item for an approval (the
 * collector's native-tool gate does — payload.type 'native_tool_approval',
 * the only shape the auth respond handler resumes a tool from) declares it
 * with metadata.suppress_inbox === true, and server.ts's onApprovalCreated
 * skips its own mint instead of creating a dead twin. Strictly boolean true:
 * a mis-serialised 'true' string must never silently cost a human their
 * only approval surface.
 */
export function shouldMintInboxItem(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.suppress_inbox !== true;
}
