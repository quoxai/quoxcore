/**
 * Tool Envelope Helper
 *
 * Centralises the truncation + hash + EvidenceStore-writeback logic so all
 * 3 tool executors (tool-call, call, browser) stay consistent.
 *
 * Contract:
 *  - If payload fits within inlineMaxBytes: return inline, no store write.
 *  - If binary and over binaryMaxBytes: return too_large=true, no hash, no store.
 *  - Otherwise (over inlineMaxBytes, not too_large): hash, truncate, write to store.
 *  - If evidenceStore is absent on the truncated path: still compute hash + size,
 *    skip the store() call. Envelope is honest about truncation.
 *  - Errors from evidenceStore.store() are non-fatal: log + continue.
 *  - Dedup is implemented at the helper level by checking for an existing record
 *    with the same hash before writing. EvidenceStore interface is unchanged.
 */

import { createHash } from 'node:crypto';
import type { EvidenceStore } from '../../evidence/types.js';
import { SYSTEM_SCOPE } from '../../api/middleware/org-scope.js';

// ============================================================================
// Types
// ============================================================================

export interface ToolPayloadCapConfig {
  /** Inline cap in bytes. Default 16 * 1024. */
  inlineMaxBytes?: number;
  /**
   * Binary safety valve. Default 5 * 1024 * 1024.
   * Reads `AEE_TOOL_PAYLOAD_BINARY_MAX_BYTES` env var if set, else default.
   */
  binaryMaxBytes?: number;
}

export type ResultType = 'json' | 'text' | 'binary';

export interface CapturedPayload {
  /** Truncated value (if applicable) safe to embed in envelope. Absent on too_large. */
  value?: unknown;
  truncated: boolean;
  size_bytes: number;
  /** sha256 of the full original. Absent when result_too_large blocked storage. */
  full_sha256?: string;
  /** Only set on result captures */
  type?: ResultType;
  /** Only set when over binaryMaxBytes */
  too_large?: true;
}

export interface CaptureContext {
  evidenceStore?: EvidenceStore;
  correlationId: string;
  envelopeId: string;
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  caps?: ToolPayloadCapConfig;
  /** AEE-FULL Gap 4: cancellation signal threaded from ExecutionContext */
  cancellationSignal?: AbortSignal;
  /** QF-MT WP5: the run's org (ExecutionContext.orgId) — persisted on the
   * evidence row so tool args/results are tenant-scoped. Absent for runs
   * with no resolved org (falls to the SYSTEM_SCOPE/legacy bucket). */
  orgId?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

const DEFAULT_INLINE_MAX_BYTES = 16 * 1024;
const DEFAULT_BINARY_MAX_BYTES = 5 * 1024 * 1024;

function getInlineMax(caps?: ToolPayloadCapConfig): number {
  return caps?.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
}

function getBinaryMax(caps?: ToolPayloadCapConfig): number {
  if (caps?.binaryMaxBytes !== undefined) return caps.binaryMaxBytes;
  const envVal = process.env.AEE_TOOL_PAYLOAD_BINARY_MAX_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BINARY_MAX_BYTES;
}

function serialise(raw: unknown): { buf: Buffer; type: ResultType } {
  if (Buffer.isBuffer(raw)) {
    return { buf: raw, type: 'binary' };
  }
  if (typeof raw === 'string') {
    return { buf: Buffer.from(raw, 'utf8'), type: 'text' };
  }
  return { buf: Buffer.from(JSON.stringify(raw), 'utf8'), type: 'json' };
}

function computeHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function truncateValue(buf: Buffer, limit: number, type: ResultType): unknown {
  const slice = buf.slice(0, limit);
  if (type === 'binary') {
    return slice.toString('base64');
  }
  // text or json: return truncated string
  return slice.toString('utf8');
}

/**
 * Check whether a record with the given hash already exists.
 * Dedup is done here in the helper to keep EvidenceStore interface unchanged.
 * QF-MT WP5: deliberately SYSTEM_SCOPE — this is an internal dedup lookup
 * (existence-only, never returns content to a caller) spanning all orgs, not
 * a tenant-facing read; scoping it to one org would let two different orgs
 * both store the same bytes instead of deduping, which is a storage/hash-
 * chain concern, not an isolation one.
 */
async function recordExists(store: EvidenceStore, hash: string): Promise<boolean> {
  try {
    const all = await store.list({}, SYSTEM_SCOPE);
    return all.some(r => r.hash === hash);
  } catch {
    return false;
  }
}

// ============================================================================
// captureToolArgs
// ============================================================================

/**
 * Capture tool arguments for the quox.flow.tool.invoked envelope.
 * Args are always JSON; type field is not set on the returned payload.
 */
export async function captureToolArgs(
  raw: unknown,
  ctx: CaptureContext
): Promise<CapturedPayload> {
  const { buf } = serialise(raw);
  const size_bytes = buf.length;
  const inlineMax = getInlineMax(ctx.caps);

  if (size_bytes <= inlineMax) {
    return { value: raw, truncated: false, size_bytes };
  }

  // Over inline cap — hash, truncate, store
  const full_sha256 = computeHash(buf);
  const truncatedValue = truncateValue(buf, inlineMax, 'json');

  if (ctx.evidenceStore) {
    try {
      const exists = await recordExists(ctx.evidenceStore, full_sha256);
      if (!exists) {
        await ctx.evidenceStore.store({
          type: 'tool_args',
          content: buf,
          contentType: 'application/json',
          correlationId: ctx.correlationId,
          envelopeId: ctx.envelopeId,
          workflowId: ctx.workflowId,
          executionId: ctx.executionId,
          nodeId: ctx.nodeId,
          orgId: ctx.orgId,
        });
      }
    } catch (err) {
      console.warn('[tool-envelope] captureToolArgs: evidenceStore.store() failed (non-fatal):', err);
    }
  }

  return { value: truncatedValue, truncated: true, full_sha256, size_bytes };
}

// ============================================================================
// captureToolResult
// ============================================================================

/**
 * Capture tool result for the quox.flow.tool.completed envelope.
 * Detects content type (json/text/binary) and applies caps accordingly.
 */
export async function captureToolResult(
  raw: unknown,
  ctx: CaptureContext
): Promise<CapturedPayload> {
  const { buf, type } = serialise(raw);
  const size_bytes = buf.length;
  const inlineMax = getInlineMax(ctx.caps);
  const binaryMax = getBinaryMax(ctx.caps);

  // Binary safety valve — hard block
  if (type === 'binary' && size_bytes > binaryMax) {
    return { truncated: true, too_large: true, size_bytes, type };
  }

  if (size_bytes <= inlineMax) {
    return { value: raw, truncated: false, size_bytes, type };
  }

  // Over inline cap — hash, truncate, store
  const full_sha256 = computeHash(buf);
  const truncatedValue = truncateValue(buf, inlineMax, type);

  if (ctx.evidenceStore) {
    try {
      const exists = await recordExists(ctx.evidenceStore, full_sha256);
      if (!exists) {
        await ctx.evidenceStore.store({
          type: 'tool_result',
          content: buf,
          contentType: type === 'binary' ? 'application/octet-stream'
            : type === 'text' ? 'text/plain'
            : 'application/json',
          correlationId: ctx.correlationId,
          envelopeId: ctx.envelopeId,
          workflowId: ctx.workflowId,
          executionId: ctx.executionId,
          nodeId: ctx.nodeId,
          orgId: ctx.orgId,
        });
      }
    } catch (err) {
      console.warn('[tool-envelope] captureToolResult: evidenceStore.store() failed (non-fatal):', err);
    }
  }

  return { value: truncatedValue, truncated: true, full_sha256, size_bytes, type };
}
