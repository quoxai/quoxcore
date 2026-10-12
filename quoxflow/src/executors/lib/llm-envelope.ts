/**
 * LLM Envelope Helper
 *
 * Sibling to tool-envelope.ts. Centralises truncation + hash + EvidenceStore
 * writeback for LLM prompt and completion payloads. Delegates to
 * captureToolResult / captureToolArgs from tool-envelope.ts for the core
 * cap+hash+store mechanics (no duplication).
 *
 * Contract:
 *  - captureLlmPrompt: serialise messages array as JSON, apply tool-envelope
 *    cap mechanics via captureToolArgs (input → tool_args record type).
 *  - captureLlmCompletion: capture completion string via captureToolResult
 *    (output → tool_result record type).
 *  - buildLlmUsagePayload: pure function. Honest-zero path when collector
 *    returns no usage block (tokens_unknown: true, NOT a block).
 *
 * AEE-FULL Gap 3 — SD-4 / SD-5 implementation.
 */

import type { EvidenceStore } from '../../evidence/types.js';
import {
  captureToolArgs,
  captureToolResult,
  type CapturedPayload,
  type ToolPayloadCapConfig,
} from './tool-envelope.js';

// ============================================================================
// Types
// ============================================================================

export interface LlmCaptureContext {
  correlationId: string;
  envelopeId: string;
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  caps?: ToolPayloadCapConfig;
  evidenceStore?: EvidenceStore;
  /** AEE-FULL Gap 4: cancellation signal threaded from ExecutionContext */
  cancellationSignal?: AbortSignal;
  /** QF-MT WP5: the run's org — see tool-envelope.ts's CaptureContext.orgId. */
  orgId?: string;
}

export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  model?: string;
  cost_usd?: number;
}

// Re-export so callers importing from here get the shared type
export type { CapturedPayload };

// ============================================================================
// captureLlmPrompt
// ============================================================================

/**
 * Capture LLM prompt messages array for the quox.flow.llm.invoked envelope.
 * Delegates to captureToolArgs for the cap+hash+EvidenceStore mechanics.
 * The messages array is serialised as JSON (same as tool args).
 */
export async function captureLlmPrompt(
  messages: unknown[],
  ctx: LlmCaptureContext
): Promise<CapturedPayload> {
  return captureToolArgs(messages, {
    correlationId: ctx.correlationId,
    envelopeId: ctx.envelopeId,
    workflowId: ctx.workflowId,
    executionId: ctx.executionId,
    nodeId: ctx.nodeId,
    caps: ctx.caps,
    evidenceStore: ctx.evidenceStore,
    orgId: ctx.orgId,
  });
}

// ============================================================================
// captureLlmCompletion
// ============================================================================

/**
 * Capture LLM completion text for the quox.flow.llm.completed envelope.
 * Delegates to captureToolResult for the cap+hash+EvidenceStore mechanics.
 */
export async function captureLlmCompletion(
  text: string,
  ctx: LlmCaptureContext
): Promise<CapturedPayload> {
  return captureToolResult(text, {
    correlationId: ctx.correlationId,
    envelopeId: ctx.envelopeId,
    workflowId: ctx.workflowId,
    executionId: ctx.executionId,
    nodeId: ctx.nodeId,
    caps: ctx.caps,
    evidenceStore: ctx.evidenceStore,
    orgId: ctx.orgId,
  });
}

// ============================================================================
// buildLlmUsagePayload
// ============================================================================

export interface LlmUsagePayload {
  tokens_input: number;
  tokens_output: number;
  tokens_cached_input?: number;
  cost_usd?: number;
  model: string | null;
  provider: string;
  tokens_unknown: boolean;
}

/**
 * Pure function — no async, no side-effects.
 * Returns the canonical token payload fragment for the quox.flow.llm.completed
 * envelope.
 *
 * Honest-zero contract (SD-4):
 *   - undefined usage → tokens_unknown: true, tokens 0. NOT a block.
 *   - missing model → model: null, tokens_unknown: false (partial honesty).
 *   - complete usage → all fields, tokens_unknown: false.
 *   - cost_usd / tokens_cached_input: only present when in input.
 */
export function buildLlmUsagePayload(
  usage: LlmUsage | undefined,
  provider: string
): LlmUsagePayload {
  if (usage === undefined || usage === null) {
    return {
      tokens_input: 0,
      tokens_output: 0,
      model: null,
      provider,
      tokens_unknown: true,
    };
  }

  const result: LlmUsagePayload = {
    tokens_input: usage.input_tokens ?? 0,
    tokens_output: usage.output_tokens ?? 0,
    model: usage.model ?? null,
    provider,
    tokens_unknown: false,
  };

  if (usage.cached_input_tokens !== undefined) {
    result.tokens_cached_input = usage.cached_input_tokens;
  }

  if (usage.cost_usd !== undefined) {
    result.cost_usd = usage.cost_usd;
  }

  return result;
}
