/**
 * Utility Executors
 *
 * Handles util:wait, util:log, and util:subworkflow nodes.
 */

import { NodeExecutor, ExecutorResult, ExecutorRegistry } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import type { WorkflowStore } from '../api/stores/workflow-store.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';
import type { EnvelopeStore } from '../store/envelope-store.js';
import { ControlPipeline } from '../pipeline/control-pipeline.js';
import { processValue } from '../expression/engine.js';
import { combineAbortSignals } from './lib/abort-utils.js';

// ============================================================================
// Wait Executor
// ============================================================================

interface WaitConfig {
  duration: number; // milliseconds
}

export class WaitExecutor implements NodeExecutor {
  readonly nodeTypes = ['util:wait'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as WaitConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const duration = config.duration || 1000;

    // Emit start event
    const startEnvelope = factory.event(
      'quox.flow.node.wait.started',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        duration,
      }
    );
    emitted.push(startEnvelope);

    // Wait — respects an AbortSignal injected by flow:parallel (B3.4) AND
    // the pipeline's own cancellation signal (STABILITY-AUDITS Fix 4).
    // context.cancellationSignal is the same Gap-4 signal every other
    // abort-aware executor (call, tool-call, agent-invoke, browser, agentic)
    // already honours via combineAbortSignals — util:wait was the one
    // executor still only listening for the parallel-branch signal, so a
    // plain (non-parallel) wait node ignored cancellation/timeout until its
    // own duration elapsed. When either signal fires before the duration
    // elapses, the wait rejects with a clean WAIT_ABORTED error.
    const abortSignal = combineAbortSignals(
      (context as any).abortSignal as AbortSignal | undefined,
      context.cancellationSignal
    );
    try {
      await new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('WAIT_ABORTED: abort signal was already set before wait started'));
          return;
        }
        const handle = setTimeout(resolve, duration);
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            clearTimeout(handle);
            reject(new Error('WAIT_ABORTED: abort signal fired during wait'));
          }, { once: true });
        }
      });
    } catch (err: any) {
      // Abort signal fired — surface as a clean executor failure
      const errorEnvelope = factory.event(
        'quox.flow.node.wait.aborted',
        context.correlationId,
        { nodeId: node.id, nodeName: node.name ?? node.id, reason: err.message }
      );
      emitted.push(errorEnvelope);
      return {
        success: false,
        output: null,
        error: { code: 'WAIT_ABORTED', message: err.message },
        envelopes: emitted,
      };
    }

    // Emit completion event
    const completeEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        duration,
      }
    );
    emitted.push(completeEnvelope);

    return {
      success: true,
      output: input, // Pass through unchanged
      envelopes: emitted,
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as WaitConfig;
    const errors: string[] = [];

    if (config.duration !== undefined && (typeof config.duration !== 'number' || config.duration < 0)) {
      errors.push('duration must be a non-negative number');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ============================================================================
// Log Executor
// ============================================================================

interface LogConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  data?: unknown;
}

export class LogExecutor implements NodeExecutor {
  readonly nodeTypes = ['util:log'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as LogConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const level = config.level || 'info';
    const message = config.message || 'Log entry';

    // Emit log event
    const logEnvelope = factory.event(
      `quox.flow.node.log.${level}`,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        level,
        message,
        data: config.data ?? input,
        timestamp: new Date().toISOString(),
      }
    );
    emitted.push(logEnvelope);

    // Also emit to console for visibility
    const logFn = level === 'error' ? console.error :
                  level === 'warn' ? console.warn :
                  level === 'debug' ? console.debug : console.log;
    logFn(`[${level.toUpperCase()}] ${node.name ?? node.id}: ${message}`);

    // Emit completion event
    const completeEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
      }
    );
    emitted.push(completeEnvelope);

    return {
      success: true,
      output: input, // Pass through unchanged
      envelopes: emitted,
    };
  }
}

// ============================================================================
// Subworkflow Executor
// ============================================================================

interface SubworkflowConfig {
  workflowId: string;
  input?: Record<string, unknown>;
}

const MAX_SUBWORKFLOW_DEPTH = 5;

export interface SubworkflowDeps {
  workflowStore: WorkflowStore;
  executors: ExecutorRegistry;
  envelopeStore: EnvelopeStore;
}

export class SubworkflowExecutor implements NodeExecutor {
  readonly nodeTypes = ['util:subworkflow'];

  constructor(private deps?: SubworkflowDeps) {}

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as SubworkflowConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Without deps, fall back to pass-through (backward compat)
    if (!this.deps) {
      const warningEnvelope = factory.event(
        'quox.flow.node.subworkflow.placeholder',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          workflowId: config.workflowId,
          message: 'Subworkflow execution not yet implemented - passing input through',
        }
      );
      emitted.push(warningEnvelope);

      const completeEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        { nodeId: node.id, nodeName: node.name ?? node.id, nodeType: node.type, workflowId: config.workflowId }
      );
      emitted.push(completeEnvelope);

      return { success: true, output: input, envelopes: emitted };
    }

    // Circular reference guard via depth counter
    const depth = (context.getVariable('_subworkflowDepth') as number) || 0;
    if (depth >= MAX_SUBWORKFLOW_DEPTH) {
      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        { nodeId: node.id, error: `Subworkflow nesting depth exceeded (max ${MAX_SUBWORKFLOW_DEPTH})` }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: { code: 'SUBWORKFLOW_MAX_DEPTH', message: `Subworkflow nesting depth exceeded (max ${MAX_SUBWORKFLOW_DEPTH})` },
        envelopes: emitted,
      };
    }

    // Load referenced workflow. QF-MT WP3: scope from the parent execution's
    // org context when present, else SYSTEM_SCOPE (subworkflow references are
    // typically same-org, but no org is guaranteed on every ExecutionContext).
    const stored = await this.deps.workflowStore.get(config.workflowId, context.orgId ?? SYSTEM_SCOPE);
    if (!stored) {
      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        { nodeId: node.id, error: `Workflow ${config.workflowId} not found` }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: { code: 'SUBWORKFLOW_NOT_FOUND', message: `Workflow ${config.workflowId} not found` },
        envelopes: emitted,
      };
    }

    // Prepare input — evaluate any ${...} expressions in config.input so that
    // loop body context (${item.x}, ${loop.item.x}) is resolved before
    // the child workflow receives the value.
    const rawSubInput = config.input ?? input;
    const subInput = config.input
      ? processValue(rawSubInput, context.createExpressionContext(node.id, input))
      : input;
    const subWorkflow = {
      ...stored.definition,
      variables: { ...stored.definition.variables, _subworkflowDepth: depth + 1 },
    };

    // Execute nested workflow
    const pipeline = new ControlPipeline({
      store: this.deps.envelopeStore,
      executors: this.deps.executors,
    });

    const result = await pipeline.execute(subWorkflow, subInput);
    emitted.push(...result.envelopes);

    // Emit completion event
    const completeEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        workflowId: config.workflowId,
        subworkflowSuccess: result.success,
      }
    );
    emitted.push(completeEnvelope);

    if (!result.success) {
      return {
        success: false,
        output: null,
        error: result.error || { code: 'SUBWORKFLOW_FAILED', message: 'Subworkflow execution failed' },
        envelopes: emitted,
      };
    }

    return { success: true, output: result.output, envelopes: emitted };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as SubworkflowConfig;
    const errors: string[] = [];

    if (!config.workflowId) {
      errors.push('workflowId is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const waitExecutor = new WaitExecutor();
export const logExecutor = new LogExecutor();
export const subworkflowExecutor = new SubworkflowExecutor();
