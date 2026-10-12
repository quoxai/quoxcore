/**
 * Executor Interface
 *
 * Contract for node executors that handle specific node types.
 */

import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope } from '../core/envelope.js';

/**
 * Result of executing a node
 */
export interface ExecutorResult {
  success: boolean;
  output: unknown;
  error?: {
    code: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
  envelopes: Envelope[];       // Envelopes emitted during execution
  evidenceRefs?: string[];     // References to stored evidence
  nextNodes?: string[];        // Override default next nodes (for control flow)
  metadata?: Record<string, unknown>;
  /** Signal that execution should pause (e.g., awaiting human approval) */
  paused?: boolean;
  /** Reason for the pause (displayed in audit trail) */
  pauseReason?: string;
  /**
   * QUOXTRUST-B5: true when the external effect this executor attempted may
   * or may not have landed upstream (the request send phase completed, or
   * could not be ruled out, before a transport failure was observed), as
   * distinct from a definite failure. control-pipeline.ts's
   * dispatchExecutor() reads this to settle the node's dispatch outcome as
   * `outcome_unknown` rather than `failed`, so an ambiguous consequential
   * effect (a payment, a message send, ...) is never silently reported as a
   * clean failure that is safe to retry or ignore.
   */
  ambiguous?: boolean;
}

/**
 * Interface that all node executors must implement
 */
export interface NodeExecutor {
  /**
   * Node types this executor handles
   */
  readonly nodeTypes: string[];

  /**
   * QUOXTRUST-B3: true for executors that fire an external effect (HTTP
   * call, agent/team invoke, HITL-approval creation, tool/browser action)
   * as part of execute(). control-pipeline.ts's dispatchExecutor() uses
   * this flag to durably record a dispatch-intent envelope BEFORE calling
   * execute() (a crash between dispatch and completion must never look
   * like "nothing was attempted"). Defaults to falsy (no external effect,
   * no intent/settled envelopes) for pure-compute executors.
   */
  readonly hasExternalEffect?: boolean;

  /**
   * Execute a node
   */
  execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult>;

  /**
   * Validate node configuration (optional)
   */
  validate?(node: Node): { valid: boolean; errors?: string[] };
}

/**
 * QUOXTRUST-B5: thrown by an executor's execute() (or an inner retry
 * helper) to distinctly surface a dispatch whose outcome could not be
 * determined, an external effect where the request may have been received
 * upstream before a transport failure was observed, as opposed to a
 * definite failure. Carries the underlying cause plus the method/url so the
 * dispatch chokepoint (control-pipeline.ts's dispatchExecutor) and any
 * caller can tell "this effect is unresolved" apart from "this effect
 * definitely did not happen" or "this effect definitely failed".
 */
export class AmbiguousDispatchError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(message: string, options: { cause?: unknown; method: string; url: string }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AmbiguousDispatchError';
    this.method = options.method;
    this.url = options.url;
  }
}

/**
 * Registry for node executors
 */
export class ExecutorRegistry {
  private executors: Map<string, NodeExecutor> = new Map();

  /**
   * Register an executor for node types
   */
  register(executor: NodeExecutor): void {
    for (const nodeType of executor.nodeTypes) {
      this.executors.set(nodeType, executor);
    }
  }

  /**
   * Get executor for a node type
   */
  get(nodeType: string): NodeExecutor | undefined {
    return this.executors.get(nodeType);
  }

  /**
   * Check if an executor exists for a node type
   */
  has(nodeType: string): boolean {
    return this.executors.has(nodeType);
  }

  /**
   * Get all registered node types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.executors.keys());
  }
}

/**
 * Global executor registry
 */
export const executorRegistry = new ExecutorRegistry();
