/**
 * Lifecycle Hooks — Extension points for the control pipeline.
 *
 * Hooks are called at key moments during workflow execution.
 * They are purely observational by default (they receive data but
 * don't change execution flow). The `beforeNodeExecute` hook can
 * optionally return an `Observation` to feed agentic decision-making.
 *
 * Phase 0 of QuoxEngine v2: hooks are additive and optional.
 * Existing workflows continue to work identically.
 */

import { Node } from '../core/workflow.js';
import { ExecutorResult } from '../executors/executor.interface.js';
import { Envelope } from '../core/envelope.js';

/**
 * Observation from the environment after a node executes.
 * Different node types produce different observation types.
 */
export interface Observation {
  type: 'tool_output' | 'screenshot' | 'api_response' | 'command_output' | 'human_response' | 'generic';
  /** Compact text summary of what happened (for LLM consumption) */
  summary: string;
  /** Hash of the full content (stored as VOLT attachment, not inline) */
  contentHash?: string;
  /** Reference to full content in evidence store */
  contentRef?: string;
  /** Size of the raw content in bytes */
  contentSizeBytes?: number;
  /** Structured metadata specific to the observation type */
  metadata?: Record<string, unknown>;
  /** Base64-encoded image for vision-capable LLM reasoning (BQ Phase 2) */
  imageBase64?: string;
  /** MIME type of the image (e.g., 'image/jpeg') */
  imageMediaType?: string;
}

/**
 * Lifecycle hooks interface.
 * All methods are optional. Implement only what you need.
 */
export interface LifecycleHooks {
  /**
   * Called before a node executes.
   * Use for: pre-flight advisories, context injection, wisdom queries.
   *
   * @param node - The node about to execute
   * @param input - The input data for this node
   * @param context - Workflow execution context
   * @returns Optional context to inject (merged into node input)
   */
  beforeNodeExecute?(
    node: Node,
    input: unknown,
    context: { workflowId: string; correlationId: string; nodeIndex: number; totalNodes: number }
  ): Promise<{ additionalContext?: Record<string, unknown> } | void>;

  /**
   * Called after a node executes successfully.
   * Use for: observation capture, outcome recording, wisdom learning.
   *
   * @param node - The node that executed
   * @param result - The execution result
   * @param observation - Observation produced by the executor (if any)
   * @param context - Workflow execution context
   */
  afterNodeExecute?(
    node: Node,
    result: ExecutorResult,
    observation: Observation | null,
    context: { workflowId: string; correlationId: string; nodeIndex: number; durationMs: number; orgId?: string }
  ): Promise<void>;

  /**
   * Called when a node fails.
   * Use for: failure pattern detection, escalation decisions.
   *
   * @param node - The node that failed
   * @param error - The error details
   * @param context - Workflow execution context
   * @returns Optional override: retry with different input, skip, or escalate
   */
  onNodeFail?(
    node: Node,
    error: { code: string; message: string },
    context: { workflowId: string; correlationId: string; attempt: number }
  ): Promise<{
    action: 'continue' | 'retry' | 'skip' | 'escalate';
    retryInput?: unknown;
    /**
     * TRUST-GATE-1.4: only consulted when action === 'retry'.
     * Default 3, hard-capped at 10 regardless of what's returned.
     */
    maxAttempts?: number;
    /**
     * TRUST-GATE-1.4: only consulted when action === 'retry'.
     * Default 0 (no delay), hard-capped at 60000ms regardless of what's returned.
     */
    delayMs?: number;
  } | void>;

  /**
   * Called when the workflow completes (success or failure).
   * Use for: outcome analysis, wisdom recording, crystallisation check.
   *
   * @param success - Whether the workflow completed successfully
   * @param summary - Execution summary
   */
  onWorkflowComplete?(
    success: boolean,
    summary: {
      workflowId: string;
      correlationId: string;
      nodesExecuted: number;
      nodesTotal: number;
      durationMs: number;
      errors: Array<{ nodeId: string; error: string }>;
    }
  ): Promise<void>;

  /**
   * Called to produce an observation from a node's execution result.
   * Override per node type — browser nodes produce screenshots,
   * SSH nodes produce command output, etc.
   *
   * @param node - The node that executed
   * @param result - The execution result
   * @returns An observation object, or null if not applicable
   */
  captureObservation?(
    node: Node,
    result: ExecutorResult
  ): Promise<Observation | null>;
}

/**
 * No-op hooks implementation. Used when no hooks are configured.
 * Makes the pipeline behave identically to pre-QE2.
 */
export const NO_OP_HOOKS: LifecycleHooks = {};
