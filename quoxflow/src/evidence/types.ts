/**
 * Evidence Subsystem Types
 *
 * Defines interfaces for evidence archival.
 */

import { z } from 'zod';
import type { SystemScope } from '../api/middleware/org-scope.js';

// ============================================================================
// Evidence Types
// ============================================================================

/** QF-MT WP5: org scope accepted by every EvidenceStore read method — string
 * org id, or the explicit cross-org SYSTEM_SCOPE sentinel (never an absent
 * parameter). Mirrors EnvelopeOrgScope/ExecutionOrgScope/WorkflowOrgScope. */
export type EvidenceOrgScope = string | SystemScope;

export type EvidenceType =
  | 'http_response'
  | 'http_request'
  | 'approval_record'
  | 'file'
  | 'log'
  | 'screenshot'
  | 'data_snapshot'
  | 'skill_patch_evaluation'
  | 'skill_invoked'
  | 'skill_status_change'
  | 'skill_archive_candidate'
  | 'skill_cooling'
  | 'skill_review_needed'
  | 'skill_judged'
  | 'skill_judge_error'
  | 'skill_judge_budget_warning'
  | 'skill_patch_rate_limited'
  | 'skill_firewall_scanned'
  | 'tool_args'
  | 'tool_result'
  | 'ward.policy_satisfies_changed'
  | 'skill.safety_judge_ran'
  | 'skill.safety_judge_passed'
  | 'skill.promotion_gated';

export type StorageBackend = 'file' | 's3' | 'memory';

// ============================================================================
// Evidence Record
// ============================================================================

export const EvidenceRecordSchema = z.object({
  id: z.string(),
  /** QF-MT WP5: tenant owner of this evidence row. Populated from the org_id
   * column in Postgres. Optional on the schema for back-compat with legacy
   * rows/callers that predate org tracking. */
  orgId: z.string().optional(),
  correlationId: z.string(),
  envelopeId: z.string(),
  workflowId: z.string().optional(),
  executionId: z.string().optional(),
  nodeId: z.string().optional(),
  type: z.enum([
    'http_response',
    'http_request',
    'approval_record',
    'file',
    'log',
    'screenshot',
    'data_snapshot',
    'skill_patch_evaluation',
    'skill_invoked',
    'skill_status_change',
    'skill_archive_candidate',
    'skill_cooling',
    'skill_review_needed',
    'skill_judged',
    'skill_judge_error',
    'skill_judge_budget_warning',
    'skill_patch_rate_limited',
    'skill_firewall_scanned',
    'tool_args',
    'tool_result',
    'ward.policy_satisfies_changed',
    'skill.safety_judge_ran',
    'skill.safety_judge_passed',
    'skill.promotion_gated',
  ]),
  contentType: z.string(),
  size: z.number(),
  hash: z.string(),
  storageBackend: z.enum(['file', 's3', 'memory']),
  storagePath: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Hash chain (AUDIT-REAL #5). chain_hash of the previous evidence row in the
   * same correlationId scope, or undefined for the first (genesis) row in the
   * scope. Undefined for rows written before the chain feature shipped.
   */
  prevHash: z.string().optional(),
  /**
   * Hash chain (AUDIT-REAL #5). sha256 digest binding this row to prevHash —
   * see computeEvidenceChainHash() in evidence-store.ts for the preimage
   * format. Undefined for rows written before the chain feature shipped
   * ("legacy" rows — tolerated, not a verification failure).
   */
  chainHash: z.string().optional(),
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ============================================================================
// Create Evidence Request
// ============================================================================

export interface CreateEvidenceRequest {
  correlationId: string;
  envelopeId: string;
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  type: EvidenceType;
  contentType: string;
  content: Buffer | string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * QF-MT WP5: tenant owner of this evidence row. OPTIONAL (unlike
   * execution-store/workflow-store's compile-required org param) — see
   * evidence-store.ts's module docstring for why. Callers on the
   * tenant-execution write path (tool-envelope.ts's captureToolArgs/
   * captureToolResult, durable-hooks.ts) already thread the real org through.
   * Absent → stored under the SYSTEM_SCOPE/legacy bucket (hidden from tenant
   * reads, never leaked).
   */
  orgId?: string;
}

// ============================================================================
// Evidence List Options
// ============================================================================

export interface EvidenceListOptions {
  correlationId?: string;
  envelopeId?: string;
  workflowId?: string;
  executionId?: string;
  type?: EvidenceType;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Storage Backend Interface
// ============================================================================

export interface EvidenceStorageBackend {
  /**
   * Backend type identifier
   */
  readonly type: StorageBackend;

  /**
   * Initialize the backend
   */
  init(): Promise<void>;

  /**
   * Store content and return the storage path
   */
  store(id: string, content: Buffer): Promise<string>;

  /**
   * Retrieve content by storage path
   */
  retrieve(path: string): Promise<Buffer>;

  /**
   * Delete content by storage path
   */
  delete(path: string): Promise<boolean>;

  /**
   * Check if content exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Close the backend
   */
  close(): Promise<void>;
}

// ============================================================================
// Evidence Store Interface
// ============================================================================

export interface EvidenceStore {
  /**
   * Initialize the store
   */
  init(): Promise<void>;

  /**
   * Store evidence and return the record. QF-MT WP5: org is OPTIONAL on
   * CreateEvidenceRequest — see the request type's docstring.
   */
  store(request: CreateEvidenceRequest): Promise<EvidenceRecord>;

  /**
   * Get evidence record by ID. QF-MT WP5: org-scoped — cross-org id returns
   * null (routes turn that into 404, never a thrown 403).
   */
  get(id: string, scope: EvidenceOrgScope): Promise<EvidenceRecord | null>;

  /**
   * Get evidence content by ID. QF-MT WP5: org-scoped.
   */
  getContent(id: string, scope: EvidenceOrgScope): Promise<Buffer | null>;

  /**
   * List evidence records. QF-MT WP5: org-scoped.
   */
  list(options: EvidenceListOptions | undefined, scope: EvidenceOrgScope): Promise<EvidenceRecord[]>;

  /**
   * Count evidence records. QF-MT WP5: org-scoped.
   */
  count(options: Omit<EvidenceListOptions, 'limit' | 'offset'> | undefined, scope: EvidenceOrgScope): Promise<number>;

  /**
   * Delete evidence by ID. QF-MT WP5: org-scoped — cross-org id is a no-op
   * (returns false; routes turn that into 404).
   */
  delete(id: string, scope: EvidenceOrgScope): Promise<boolean>;

  /**
   * Delete expired evidence. Deliberately cross-org (boot/cron maintenance
   * sweep, not exposed via any tenant route) — no scope parameter.
   */
  deleteExpired(): Promise<number>;

  /**
   * Get evidence records by envelope ID. QF-MT WP5: org-scoped.
   */
  getByEnvelopeId(envelopeId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]>;

  /**
   * Get evidence records by correlation ID. QF-MT WP5: org-scoped.
   */
  getByCorrelationId(correlationId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]>;

  /**
   * Close the store
   */
  close(): Promise<void>;
}

// === QSKL-7 — Skill Invocation Telemetry ===

/**
 * Zod schema for the metadata envelope emitted when a skill is invoked.
 * Used as the runtime contract; consumers validate with this schema when
 * EvidenceRecord.type === 'skill_invoked'.
 */
export const SkillInvokedMetadataSchema = z.object({
  /** ULID of the invoked skill definition */
  skill_id: z.string().min(1),
  /** Semver of the skill definition at invocation time */
  skill_version: z.string().min(1),
  /** Agent that invoked the skill (optional) */
  agent_id: z.string().optional(),
  /** Session context (optional) */
  session_id: z.string().nullable().optional(),
  /** LLM tokens consumed (>= 0; 0 when served from Crystal cache) */
  tokens_used: z.number().int().nonnegative(),
  /** Estimated USD cost of the invocation (>= 0) */
  cost_usd: z.number().nonnegative(),
  /** Wall-clock latency in milliseconds (>= 0) */
  latency_ms: z.number().nonnegative(),
  /** ULID of the Crystal that served this invocation, or null when LLM-served */
  crystal_id: z.string().nullable(),
  /** Whether the skill invocation completed successfully */
  success: z.boolean(),
  /**
   * Drift score relative to the Crystal reference snapshot, or null.
   * v0 always null — Crystal reference snapshot not yet computed.
   * TODO QSKL-7: populate when Crystal canonicalises reference snapshot
   */
  drift_score: z.number().nullable(),
});

/** TypeScript interface derived from SkillInvokedMetadataSchema (consumer convenience). */
export type SkillInvokedMetadata = z.infer<typeof SkillInvokedMetadataSchema>;
