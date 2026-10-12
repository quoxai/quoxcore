/**
 * Parallel and Merge Executors
 *
 * Handles flow:parallel and flow:merge nodes for concurrent execution.
 *
 * B3.3 fix: Branches now run via Promise.all (real concurrency) rather than
 * sequential queue entries. A `concurrency` cap from node config limits the
 * maximum number of branches running simultaneously (default = 8, hard
 * ceiling = 64 regardless of configured value — STABILITY-AUDITS fix for
 * unbounded fan-out, see DEFAULT_CONCURRENCY / MAX_CONCURRENCY below).
 *
 * B3.4 fix: When `branchTimeoutMs` is configured, each branch gets its own
 * AbortController. The signal is stored on the ExecutionContext (per-branch
 * clone) so downstream executors (util:wait, call:http) can respect it.
 *
 * Abort-signal-aware executors (AEE-FULL Gap 4):
 *   - util:wait (WaitExecutor)        — wired in B3.4
 *   - call:http (CallExecutor)        — combineAbortSignals wired in Gap 4
 *   - action:tool (ToolCallExecutor)  — combineAbortSignals wired in Gap 4
 *   - browser:* (BrowserExecutor)     — combineAbortSignals wired in Gap 4
 *   - agent:invoke (AgentInvoke)      — combineAbortSignals wired in Gap 4
 *   - assistant:invoke (AssistantInvoke) — combineAbortSignals wired in Gap 4
 *   - agent:agentic (AgenticExecutor) — combineAbortSignals wired in Gap 4
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';

// ============================================================================
// Parallel Executor
// ============================================================================

interface ParallelConfig {
  branches: string[];       // Node IDs to execute in parallel
  concurrency?: number;     // Max simultaneous branches (default: DEFAULT_CONCURRENCY, hard-capped at MAX_CONCURRENCY)
  branchTimeoutMs?: number; // Per-branch timeout in ms (default: none)
}

// STABILITY-AUDITS: an unbounded (Infinity) default let a workflow author
// fan out to every branch in the workflow simultaneously — unlimited
// concurrent outbound calls / node executions from a single node. Bound it.
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 64;

export class ParallelExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:parallel'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as ParallelConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Derive branches from config, falling back to outgoing edges
    let branches = config.branches || [];
    if (branches.length === 0 && context.workflow?.edges) {
      branches = context.workflow.edges
        .filter(e => e.source === node.id)
        .map(e => e.target);
    }

    // Default to DEFAULT_CONCURRENCY when unset/invalid; always clamp to
    // MAX_CONCURRENCY even when the workflow author configures higher.
    const requestedConcurrency = (config.concurrency && config.concurrency > 0) ? config.concurrency : DEFAULT_CONCURRENCY;
    const concurrency = Math.min(requestedConcurrency, MAX_CONCURRENCY);
    const branchTimeoutMs = config.branchTimeoutMs;

    // Emit parallel start event
    const startEnvelope = factory.event(
      'quox.flow.node.parallel.started',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        branchCount: branches.length,
        branches,
        concurrency: isFinite(concurrency) ? concurrency : null,
        branchTimeoutMs: branchTimeoutMs ?? null,
      }
    );
    emitted.push(startEnvelope);

    // Execute branches concurrently, respecting the concurrency cap.
    // Branches run in batches: chunk the branch list by `concurrency` and
    // await each chunk before starting the next.
    const branchErrors: Array<{ branchId: string; error: { code: string; message: string } }> = [];
    const branchEnvelopes: Envelope[] = [];

    const runBranch = async (branchId: string): Promise<void> => {
      const workflow = context.workflow;
      const branchNode = workflow.nodes.find(n => n.id === branchId);
      if (!branchNode) {
        branchErrors.push({ branchId, error: { code: 'BRANCH_NOT_FOUND', message: `Branch node '${branchId}' not found in workflow` } });
        return;
      }

      const branchExecutor = context.executors?.get(branchNode.type);
      if (!branchExecutor) {
        branchErrors.push({ branchId, error: { code: 'UNKNOWN_NODE_TYPE', message: `No executor for branch node type: ${branchNode.type}` } });
        return;
      }

      // Create an AbortController for this branch when branchTimeoutMs is configured.
      let abortController: AbortController | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (branchTimeoutMs != null && branchTimeoutMs > 0) {
        abortController = new AbortController();
        timeoutHandle = setTimeout(() => abortController!.abort(), branchTimeoutMs);
      }

      // Store abort signal on context so downstream executors can respect it.
      // We use a simple property extension (the context class allows dynamic props).
      const prevAbortSignal = (context as any).abortSignal as AbortSignal | undefined;
      if (abortController) {
        (context as any).abortSignal = abortController.signal;
      }

      try {
        context.startNode(branchId, input);

        // Execute the branch. When branchTimeoutMs is set, the AbortController
        // fires after the timeout, and abort-aware executors (util:wait etc.)
        // catch it and return { success: false, error: { code: 'WAIT_ABORTED' } }
        // quickly — so this await unblocks at approximately branchTimeoutMs.
        const branchResult = await branchExecutor.execute(branchNode, input, context);

        branchEnvelopes.push(...branchResult.envelopes);

        if (branchResult.success) {
          context.completeNode(branchId, branchResult.output);
        } else {
          const err = branchResult.error ?? { code: 'BRANCH_FAILED', message: `Branch ${branchId} failed` };
          // Normalise WAIT_ABORTED to BRANCH_TIMEOUT when a timeout is configured
          const surfacedErr = (abortController && err.code === 'WAIT_ABORTED')
            ? { code: 'BRANCH_TIMEOUT', message: `Branch '${branchId}' exceeded ${branchTimeoutMs}ms timeout` }
            : err;
          context.failNode(branchId, surfacedErr);
          branchErrors.push({ branchId, error: surfacedErr });
        }
      } catch (err: any) {
        const errMsg = err?.message ?? `Branch ${branchId} threw unexpectedly`;
        const errCode = 'BRANCH_ERROR';
        context.failNode(branchId, { code: errCode, message: errMsg });
        // Defensive emit: context.failNode no longer emits an envelope (strip in P0.B).
        // Emit one here so the audit trail has a NODE.FAILED for this branch.
        const branchFailEnvelope = factory.event(
          Intents.NODE.FAILED,
          context.correlationId,
          {
            executionId: context.id,
            workflowId: context.workflow.id,
            nodeId: branchId,
            nodeName: branchNode.name ?? branchId,
            nodeType: branchNode.type,
            error_code: errCode,
            error_message: errMsg,
          }
        );
        branchEnvelopes.push(branchFailEnvelope);
        branchErrors.push({ branchId, error: { code: errCode, message: errMsg } });
      } finally {
        // Restore previous abort signal and clear timeout
        if (abortController) {
          clearTimeout(timeoutHandle);
          (context as any).abortSignal = prevAbortSignal;
        }
      }
    };

    // Chunk branches by concurrency cap and await each chunk in series.
    if (isFinite(concurrency) && concurrency > 0) {
      for (let i = 0; i < branches.length; i += concurrency) {
        const chunk = branches.slice(i, i + concurrency);
        await Promise.all(chunk.map(runBranch));
      }
    } else {
      // Unbounded: run all branches in parallel
      await Promise.all(branches.map(runBranch));
    }

    emitted.push(...branchEnvelopes);

    // If any branch failed, surface the first error
    if (branchErrors.length > 0) {
      const firstError = branchErrors[0].error;
      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          branchErrors,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: firstError,
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
        branchCount: branches.length,
      }
    );
    emitted.push(completeEnvelope);

    // Branches have been pre-executed and stored in the context.
    // Find the merge/downstream node from branch outgoing edges.
    // Return those as nextNodes so the pipeline continues to the merge node.
    const downstreamNodeIds = new Set<string>();
    if (context.workflow?.edges) {
      for (const branchId of branches) {
        for (const edge of context.workflow.edges) {
          if (edge.source === branchId) {
            downstreamNodeIds.add(edge.target);
          }
        }
      }
    }

    return {
      success: true,
      output: input,
      envelopes: emitted,
      // Signal pipeline to skip the branch nodes (already run) and proceed
      // directly to the merge/downstream nodes.
      nextNodes: downstreamNodeIds.size > 0 ? Array.from(downstreamNodeIds) : undefined,
      metadata: { preExecutedBranches: branches },
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as ParallelConfig;
    const errors: string[] = [];

    if (!config.branches || !Array.isArray(config.branches)) {
      errors.push('branches array is required');
    } else if (config.branches.length === 0) {
      errors.push('branches array must not be empty');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ============================================================================
// Merge Executor
// ============================================================================

interface MergeConfig {
  mode?: 'wait_all' | 'first' | 'append';
  inputs?: string[]; // Node IDs to wait for
}

export class MergeExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:merge'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as MergeConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const mode = config.mode || 'wait_all';

    // Derive input nodes from config, falling back to incoming edges
    let inputNodes = config.inputs || [];
    if (inputNodes.length === 0 && context.workflow?.edges) {
      inputNodes = context.workflow.edges
        .filter(e => e.target === node.id)
        .map(e => e.source);
    }

    // Collect outputs from input nodes
    const collectedOutputs: Record<string, unknown> = {};
    for (const inputNodeId of inputNodes) {
      const output = context.getNodeOutput(inputNodeId);
      if (output !== undefined) {
        collectedOutputs[inputNodeId] = output;
      }
    }

    // Merge based on mode
    let mergedOutput: unknown;
    switch (mode) {
      case 'append':
        // Combine all outputs into an array
        mergedOutput = Object.values(collectedOutputs);
        break;
      case 'first':
        // Take the first available output
        mergedOutput = Object.values(collectedOutputs)[0] ?? input;
        break;
      case 'wait_all':
      default:
        // Combine into an object keyed by node ID
        mergedOutput = collectedOutputs;
        break;
    }

    // Emit merge event
    const mergeEnvelope = factory.event(
      'quox.flow.node.merge.complete',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        mode,
        inputCount: Object.keys(collectedOutputs).length,
        expectedCount: inputNodes.length,
      }
    );
    emitted.push(mergeEnvelope);

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
      output: mergedOutput,
      envelopes: emitted,
    };
  }
}

export const parallelExecutor = new ParallelExecutor();
export const mergeExecutor = new MergeExecutor();
