/**
 * Execution Context
 *
 * Tracks the state of a workflow execution and provides access to node outputs.
 */

import { ulid } from 'ulid';
import { Envelope, EnvelopeFactory, Intents } from './envelope.js';
import { Workflow, Node } from './workflow.js';

export type ExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface NodeExecution {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; stack?: string };
  envelopeIds: string[];  // Envelopes emitted during this node's execution
}

export interface ExecutionState {
  id: string;
  workflowId: string;
  correlationId: string;
  orgId?: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  triggerData: unknown;
  nodes: Map<string, NodeExecution>;
  variables: Record<string, unknown>;
  currentNodeId?: string;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Execution context for a workflow run
 */
export class ExecutionContext {
  readonly id: string;
  readonly correlationId: string;
  readonly workflow: Workflow;
  readonly envelopes: EnvelopeFactory;
  /** QE2: Executor registry for agentic sub-dispatch */
  executors?: { get(type: string): any };
  /** P8.F HITL-ORGID-PLUMB: first-class org identity for this execution */
  readonly orgId?: string;
  /**
   * REPLAY-ONLY .A-1a: resolved ONCE at run start (control-pipeline.ts
   * execute()) via resolveEffectiveReplayOnly(). Foundation field only —
   * no gate/deny logic reads this yet (that's .A-1b). Defaults to false so
   * every existing run stays additive/backward-compatible when no resolver
   * is configured.
   */
  effectiveReplayOnly: boolean = false;

  private state: ExecutionState;
  private emittedEnvelopes: Envelope[] = [];
  private envelopeFlush: ((env: Envelope) => void) | null = null;
  private _cancelled = false;
  private _cancellationController = new AbortController();

  setEnvelopeFlush(fn: ((env: Envelope) => void) | null): void {
    this.envelopeFlush = fn;
  }

  /**
   * AEE-FULL Gap 3: Emit an envelope immediately via the flush hook (if set).
   * Used by LLM executors to write the quox.flow.llm.invoked envelope to the
   * store BEFORE calling the LLM, so the auditable pre-call record is durable
   * even if the call never returns (SD-2 contract).
   *
   * Does NOT add to emittedEnvelopes — the envelope is still expected in
   * result.envelopes for accumulation by the pipeline.
   */
  emitImmediate(env: Envelope): void {
    if (this.envelopeFlush) {
      try { this.envelopeFlush(env); }
      catch (err) {
        console.warn('[ExecutionContext] emitImmediate flush failed (non-fatal):',
          err instanceof Error ? err.message : err);
      }
    }
  }

  /** Push an envelope into the local accumulator and optionally stream it to the flush hook. */
  private pushEnvelope(env: Envelope): void {
    this.emittedEnvelopes.push(env);
    if (this.envelopeFlush) {
      try { this.envelopeFlush(env); }
      catch (err) {
        // Flush is best-effort; never crash emission path
        console.warn('[ExecutionContext] envelope flush failed (non-fatal):',
          err instanceof Error ? err.message : err);
      }
    }
  }

  constructor(workflow: Workflow, triggerData: unknown = {}, options?: { executionId?: string; orgId?: string; cancellationSignal?: AbortSignal; cancellationActorProvider?: () => string | undefined }) {
    this.id = options?.executionId || ulid();
    this.correlationId = `wf-${workflow.id}-${this.id.slice(-8)}`;
    this.orgId = options?.orgId;
    this.workflow = workflow;
    this.envelopes = new EnvelopeFactory('agent.quoxflow');

    this.state = {
      id: this.id,
      workflowId: workflow.id,
      correlationId: this.correlationId,
      orgId: options?.orgId,
      status: 'pending',
      startedAt: new Date().toISOString(),
      triggerData,
      nodes: new Map(),
      variables: { ...workflow.variables },
    };

    // AEE-FULL Gap 4 — external cancellation: when the registry's AbortController
    // aborts (via ExecutionService.cancel() → entry.ac.abort()), propagate to
    // the internal controller so context.cancellationSignal (consumed by executor
    // fetches via combineAbortSignals) actually fires, AND flip the _cancelled
    // flag so the dispatch loop's `if (context.cancelled) break;` check works.
    // Without this, the cancel API marks the row but in-flight fetches keep
    // running — the original 68h-stuck pattern would survive.
    if (options?.cancellationSignal) {
      const ext = options.cancellationSignal;
      const onExternalAbort = () => {
        if (this._cancelled) return;
        this._cancelled = true;
        this.state.status = 'cancelled';
        this.state.completedAt = new Date().toISOString();
        try { this._cancellationController.abort(ext.reason); } catch { /* already aborted */ }
        // Emit cancelled envelope via the flush hook so the audit chain is
        // complete even though the cancel originated outside the executor's
        // own call to context.cancel(). Counts node states at cancellation time.
        let nodesCompleted = 0;
        for (const [, exec] of this.state.nodes) {
          if (exec.status === 'completed') nodesCompleted++;
        }
        const reasonStr = typeof ext.reason === 'string'
          ? ext.reason
          : (ext.reason instanceof Error ? ext.reason.message : (ext.reason != null ? String(ext.reason) : ''));
        // LAUNCH-SPINE: an AbortSignal carries only a reason, so the actor has
        // to arrive by side-channel. Read it lazily HERE rather than at
        // construction: ExecutionService registers the cancellation entry
        // before it knows who will cancel, so an eager read is always
        // undefined. Absence stays absent (system/timeout cancels have no
        // human actor) and a throwing provider must never break cancellation.
        let actorId: string | undefined;
        try { actorId = options?.cancellationActorProvider?.(); }
        catch (err) {
          console.warn('[ExecutionContext] cancellation actor lookup failed (non-fatal):',
            err instanceof Error ? err.message : err);
        }
        const env = this.envelopes.event(
          Intents.WORKFLOW.CANCELLED,
          this.correlationId,
          {
            executionId: this.id,
            workflowId: this.workflow.id,
            workflowName: this.workflow.name,
            cancelled_by: 'user',
            cancelled_at: this.state.completedAt,
            reason: reasonStr,
            last_node_id: this.state.currentNodeId ?? null,
            last_node_name: this.state.currentNodeId ? this.getNodeName(this.state.currentNodeId) : undefined,
            actor_id: actorId,
            nodes_completed: nodesCompleted,
            nodes_total: this.state.nodes.size,
            duration: this.getDuration(),
          }
        );
        this.pushEnvelope(env);
      };
      if (ext.aborted) onExternalAbort();
      else ext.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  /**
   * Get execution status
   */
  get status(): ExecutionStatus {
    return this.state.status;
  }

  /**
   * Read-only view of node execution records (used by lifecycle hooks).
   */
  get nodeExecutions(): ReadonlyMap<string, NodeExecution> {
    return this.state.nodes;
  }

  /**
   * Mark execution as started — includes workflow topology summary.
   */
  start(): Envelope {
    this.state.status = 'running';

    // Summarise node types
    const nodeTypes: Record<string, number> = {};
    for (const node of this.workflow.nodes) {
      const t = node.type || 'unknown';
      nodeTypes[t] = (nodeTypes[t] || 0) + 1;
    }

    const env = this.envelopes.event(
      Intents.WORKFLOW.STARTED,
      this.correlationId,
      {
        executionId: this.id,
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        triggerData: this.preview(this.state.triggerData, 500),
        node_count: this.workflow.nodes.length,
        node_types: nodeTypes,
        variable_count: Object.keys(this.state.variables).length || undefined,
      }
    );
    this.pushEnvelope(env);
    return env;
  }

  /**
   * Mark execution as completed — includes node execution summary.
   */
  complete(output: unknown): Envelope {
    this.state.status = 'completed';
    this.state.completedAt = new Date().toISOString();

    // Build node execution summary
    let completed = 0, failed = 0, skipped = 0;
    const nodeSummary: Array<{ nodeId: string; name?: string; type?: string; status: string; duration?: number }> = [];
    for (const [id, exec] of this.state.nodes) {
      if (exec.status === 'completed') completed++;
      else if (exec.status === 'failed') failed++;
      else if (exec.status === 'skipped') skipped++;
      const dur = exec.startedAt && exec.completedAt
        ? new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()
        : undefined;
      nodeSummary.push({
        nodeId: id,
        name: this.getNodeName(id),
        type: this.getNodeType(id),
        status: exec.status,
        duration: dur,
      });
    }

    const env = this.envelopes.event(
      Intents.WORKFLOW.COMPLETED,
      this.correlationId,
      {
        executionId: this.id,
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        output: this.preview(output, 500),
        duration: this.getDuration(),
        nodes_completed: completed,
        nodes_failed: failed,
        nodes_skipped: skipped,
        nodes_total: this.state.nodes.size,
        node_summary: nodeSummary,
      }
    );
    this.pushEnvelope(env);
    return env;
  }

  /**
   * Mark execution as failed — includes error context and node state at failure.
   */
  fail(error: { code: string; message: string; details?: unknown }): Envelope {
    this.state.status = 'failed';
    this.state.completedAt = new Date().toISOString();
    this.state.error = error;

    // Count node states at time of failure
    let completed = 0, failed = 0, skipped = 0;
    for (const [, exec] of this.state.nodes) {
      if (exec.status === 'completed') completed++;
      else if (exec.status === 'failed') failed++;
      else if (exec.status === 'skipped') skipped++;
    }

    const env = this.envelopes.event(
      Intents.WORKFLOW.FAILED,
      this.correlationId,
      {
        executionId: this.id,
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        error_code: error?.code ?? 'UNKNOWN',
        error_message: error?.message ?? 'Unknown error',
        failed_node: this.state.currentNodeId || undefined,
        failed_node_name: this.state.currentNodeId ? this.getNodeName(this.state.currentNodeId) : undefined,
        duration: this.getDuration(),
        nodes_completed: completed,
        nodes_failed: failed,
        nodes_skipped: skipped,
        nodes_total: this.state.nodes.size,
      }
    );
    this.pushEnvelope(env);
    return env;
  }

  /**
   * AEE-FULL Gap 4: Cancel execution — emits quox.flow.cancelled envelope.
   */
  cancel(reason: string, cancelledBy: 'user' | 'system' | 'timeout', actorId?: string): Envelope {
    this._cancelled = true;
    this.state.status = 'cancelled';
    this.state.completedAt = new Date().toISOString();
    this._cancellationController.abort(reason);

    // Count node states at time of cancel
    let completed = 0, failed = 0;
    for (const [, exec] of this.state.nodes) {
      if (exec.status === 'completed') completed++;
      if (exec.status === 'failed') failed++;
    }

    const env = this.envelopes.event(
      Intents.WORKFLOW.CANCELLED,
      this.correlationId,
      {
        executionId: this.id,
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        cancelled_by: cancelledBy,
        cancelled_at: this.state.completedAt,
        reason,
        last_node_id: this.state.currentNodeId ?? null,
        last_node_name: this.state.currentNodeId ? this.getNodeName(this.state.currentNodeId) : undefined,
        actor_id: actorId,
        nodes_completed: completed,
        nodes_total: this.state.nodes.size,
        duration: this.getDuration(),
      }
    );
    this.pushEnvelope(env);
    return env;
  }

  /** AEE-FULL Gap 4: AbortSignal that fires when cancel() is called. */
  get cancellationSignal(): AbortSignal { return this._cancellationController.signal; }

  /** AEE-FULL Gap 4: True after cancel() has been called. */
  get cancelled(): boolean { return this._cancelled; }

  /**
   * Resolve the human-readable name for a node.
   */
  private getNodeName(nodeId: string): string | undefined {
    const node = this.workflow.nodes.find(n => n.id === nodeId);
    return node?.name;
  }

  /**
   * Resolve the type for a node.
   */
  private getNodeType(nodeId: string): string | undefined {
    const node = this.workflow.nodes.find(n => n.id === nodeId);
    return node?.type;
  }

  /**
   * Safely truncate unknown output to a serialisable preview.
   */
  private preview(data: unknown, max = 500): string | undefined {
    if (data === undefined || data === null) return undefined;
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      return str.length > max ? str.slice(0, max) + '…' : str;
    } catch {
      return undefined;
    }
  }

  /**
   * Start executing a node — emits quox.flow.node.started envelope.
   */
  startNode(nodeId: string, input: unknown): NodeExecution {
    const execution: NodeExecution = {
      nodeId,
      status: 'running',
      startedAt: new Date().toISOString(),
      input,
      envelopeIds: [],
    };
    this.state.nodes.set(nodeId, execution);
    this.state.currentNodeId = nodeId;

    // Emit node started envelope
    const env = this.envelopes.event(
      Intents.NODE.STARTED,
      this.correlationId,
      {
        executionId: this.id,
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        nodeId,
        nodeName: this.getNodeName(nodeId),
        nodeType: this.getNodeType(nodeId),
        input_preview: this.preview(input, 300),
      }
    );
    this.pushEnvelope(env);
    execution.envelopeIds.push(env.id);

    return execution;
  }

  /**
   * Complete a node execution — updates state only.
   * NODE.COMPLETED envelope is emitted by the executor directly via result.envelopes.
   */
  completeNode(nodeId: string, output: unknown): NodeExecution {
    const execution = this.state.nodes.get(nodeId);
    if (!execution) {
      throw new Error(`Node ${nodeId} not found in execution state`);
    }
    execution.status = 'completed';
    execution.completedAt = new Date().toISOString();
    execution.output = output;

    return execution;
  }

  /**
   * Mark a node as failed — updates state only.
   * NODE.FAILED envelope is emitted by the executor directly via result.envelopes,
   * or by the parallel executor's defensive catch-arm emit.
   */
  failNode(nodeId: string, error: { code: string; message: string; stack?: string }): NodeExecution {
    const execution = this.state.nodes.get(nodeId);
    if (!execution) {
      throw new Error(`Node ${nodeId} not found in execution state`);
    }
    execution.status = 'failed';
    execution.completedAt = new Date().toISOString();
    execution.error = error;

    return execution;
  }

  /**
   * Skip a node — updates state only.
   * NODE.SKIPPED envelope is emitted by the executor directly via result.envelopes.
   */
  skipNode(nodeId: string, reason: string): NodeExecution {
    const execution: NodeExecution = {
      nodeId,
      status: 'skipped',
      input: { reason },
      envelopeIds: [],
    };
    this.state.nodes.set(nodeId, execution);

    return execution;
  }

  /**
   * Get output from a previous node
   */
  getNodeOutput(nodeId: string): unknown {
    return this.state.nodes.get(nodeId)?.output;
  }

  /**
   * Get input for a node (from previous nodes)
   */
  getNodeInput(nodeId: string): unknown {
    return this.state.nodes.get(nodeId)?.input;
  }

  /**
   * Get all completed node outputs
   */
  getAllOutputs(): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    for (const [id, execution] of this.state.nodes) {
      if (execution.status === 'completed') {
        outputs[id] = execution.output;
      }
    }
    return outputs;
  }

  /**
   * Set a variable
   */
  setVariable(name: string, value: unknown): void {
    this.state.variables[name] = value;
  }

  /**
   * Get a variable
   */
  getVariable(name: string): unknown {
    return this.state.variables[name];
  }

  /**
   * Get all variables
   */
  getVariables(): Record<string, unknown> {
    return { ...this.state.variables };
  }

  /**
   * Record an emitted envelope
   */
  recordEnvelope(env: Envelope, nodeId?: string): void {
    this.pushEnvelope(env);
    if (nodeId) {
      const execution = this.state.nodes.get(nodeId);
      if (execution) {
        execution.envelopeIds.push(env.id);
      }
    }
  }

  /**
   * Get all emitted envelopes
   */
  getEnvelopes(): Envelope[] {
    return [...this.emittedEnvelopes];
  }

  /**
   * Get execution duration in ms
   */
  getDuration(): number {
    const start = new Date(this.state.startedAt).getTime();
    const end = this.state.completedAt
      ? new Date(this.state.completedAt).getTime()
      : Date.now();
    return end - start;
  }

  /**
   * Get full execution state (for persistence)
   */
  getState(): ExecutionState {
    return { ...this.state };
  }

  /**
   * Inject pre-computed node state (used during resume to restore prior node outputs)
   */
  setNodeState(nodeId: string, state: { input: unknown; output: unknown }): void {
    this.state.nodes.set(nodeId, {
      nodeId,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      input: state.input,
      output: state.output,
      envelopeIds: [],
    });
  }

  // Active loop context for the current body-node iteration (set by the pipeline)
  private _loopContext?: { item: unknown; index: number };

  /**
   * Set the active loop context for the current iteration.
   * Called by the pipeline before executing a loop body node.
   */
  setLoopContext(ctx: { item: unknown; index: number } | undefined): void {
    this._loopContext = ctx;
  }

  /**
   * Create expression context for evaluating expressions
   */
  createExpressionContext(currentNodeId: string, input: unknown): ExpressionContext {
    return {
      input,
      nodes: this.getNodeContexts(),
      vars: this.state.variables,
      workflow: {
        id: this.workflow.id,
        name: this.workflow.name,
      },
      execution: {
        id: this.id,
        correlationId: this.correlationId,
      },
      env: {},
      loop: this._loopContext,
    };
  }

  /**
   * Get node contexts for expressions (access via nodes.NodeName.output or nodes.nodeId.output)
   */
  private getNodeContexts(): Record<string, { input: unknown; output: unknown }> {
    const contexts: Record<string, { input: unknown; output: unknown }> = {};

    for (const node of this.workflow.nodes) {
      const execution = this.state.nodes.get(node.id);
      const data = {
        input: execution?.input ?? null,
        output: execution?.output ?? null,
      };
      // Index by both node.id and node.name so expressions can use either
      contexts[node.id] = data;
      if (node.name && node.name !== node.id) {
        contexts[node.name] = data;
      }
    }

    return contexts;
  }
}

/**
 * Context available in expressions
 */
export interface ExpressionContext {
  input: unknown;                                    // Current node's input
  nodes: Record<string, { input: unknown; output: unknown }>;  // Access other nodes
  vars: Record<string, unknown>;                     // Workflow variables
  workflow: { id: string; name: string };            // Workflow info
  execution: { id: string; correlationId: string };  // Execution info
  env: Record<string, string>;                        // Explicitly allowed env vars only
  /** Loop context — populated when expression is evaluated inside a loop body iteration */
  loop?: { item: unknown; index: number };
}
