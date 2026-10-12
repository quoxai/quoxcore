/**
 * Control Pipeline
 *
 * AOCL-inspired control layer orchestration.
 * Every execution passes through: Ingress → Identity → Policy → Context → Execute → Verify → Assemble
 */

import { Envelope, EnvelopeFactory, Intents } from '../core/envelope.js';
import { Workflow, WorkflowSettings, Node, getOutgoingEdges, getIncomingEdges, getNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { EnvelopeStore } from '../store/envelope-store.js';
import { ExecutorRegistry, ExecutorResult, NodeExecutor, AmbiguousDispatchError } from '../executors/executor.interface.js';
import { ControlLayer, LayerResult, IngressLayer, IdentityLayer, PolicyLayer, ContextLayer, VerifyLayer, AssembleLayer } from './layers/index.js';
import { EventBus } from '../events/event-bus.js';
import { LifecycleHooks, NO_OP_HOOKS, Observation } from './lifecycle-hooks.js';
import { BudgetEvaluator } from '../budget/budget-evaluator.js';
import { BudgetScopeKind } from '../budget/budget-store.js';
import { PolicyEvaluator } from '../policy/evaluator.js';
import { ApprovalEngine } from '../approval/approval-engine.js';
import { ContractEvaluator, resolveNodeAgentAction } from '../agentic/contract-evaluator.js';
import { logger } from '../logger.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';
import { ReplayOnlyResolveParams } from '../store/replay-only-flags-store.js';
import { hashSnapshot } from '../store/crystal-canonical-hash.js';

const log = logger.for('Pipeline');

/**
 * QUOXTRUST-B3: thrown by dispatchExecutor() when the pre-dispatch durable
 * intent envelope for an outward (hasExternalEffect) executor could not be
 * appended. Fail-closed by construction: this is thrown BEFORE
 * executor.execute() is ever called, so no durable intent means the
 * external effect never fires: "no record of an attempt" and "no attempt"
 * stay the same fact instead of drifting apart under a crash.
 */
export class DispatchIntentError extends Error {
  constructor(nodeId: string, nodeType: string, cause: Error) {
    super(
      `DispatchIntentError: failed to durably record dispatch intent for node ` +
      `${nodeId} (${nodeType}), refusing to dispatch: ${cause.message}`
    );
    this.name = 'DispatchIntentError';
  }
}

/**
 * REPLAY-ONLY .A-1b Gate 1: node types that call the collector LLM directly
 * and have NO replay path (unlike `agent:agentic`, which owns its own hard
 * gate — Gate 2 — inside agentic.executor.ts). Denied outright under
 * effective replay-only, before execution.
 * See docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §4 "The enforceable design".
 */
const REPLAY_ONLY_DENIED_NODE_TYPES = new Set([
  'agent:invoke',
  'assistant:invoke',
  'team:invoke',
  'team:member',
]);

export interface BudgetScopeContext {
  scope: BudgetScopeKind;
  scopeId: string;
  orgId: string;
}

/**
 * STABILITY-AUDITS Fix 1: WorkflowSettings.timeout applied when unset — a
 * user must opt into a longer run rather than getting an unbounded one by
 * omission.
 */
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * STABILITY-AUDITS Fix 1: absolute ceiling on WorkflowSettings.timeout,
 * enforced regardless of what a workflow author requests — a runaway
 * workflow must never take the host down.
 */
export const MAX_WORKFLOW_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * STABILITY-AUDITS Fix 1: resolve the effective workflow-run deadline from
 * WorkflowSettings.timeout. Exported for direct unit testing — the
 * default/ceiling behaviour doesn't need a real timer to verify.
 */
export function resolveWorkflowTimeoutMs(settings?: WorkflowSettings): number {
  const requested = settings?.timeout;
  if (typeof requested === 'number' && requested > 0) {
    return Math.min(requested, MAX_WORKFLOW_TIMEOUT_MS);
  }
  return DEFAULT_WORKFLOW_TIMEOUT_MS;
}

export interface PipelineConfig {
  store: EnvelopeStore;
  executors: ExecutorRegistry;
  eventBus?: EventBus;
  /** P8.B: Budget evaluator for pre-execution budget checks. No-op if absent. */
  budgetEvaluator?: BudgetEvaluator;
  /** P8.B: Resolves budget scope for a given workflow + orgId. No-op if absent. */
  budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  /** P8.C: Per-node policy gate evaluator. No-op if absent. */
  policyEvaluator?: PolicyEvaluator;
  /**
   * REPLAY-ONLY .A-1a: resolves the effective `replay_only` flag for this run
   * (org/workflow/agent/run flag store, OR-merged — see
   * resolveEffectiveReplayOnly() in store/replay-only-flags-store.ts).
   * Computed once at run start and stored on context.effectiveReplayOnly.
   * Foundation only — no gate reads this yet. No-op (defaults to false) if
   * absent.
   */
  replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  /** P8.C: Approval engine for creating policy-injected approval rows. No-op if absent. */
  approvalEngine?: ApprovalEngine;
  /**
   * RSP-CONTRACT Phase 1b: observe-mode contract-check evaluator. Defaults to
   * a real ContractEvaluator (env-configured collector URL/service key) —
   * override only for tests. Always best-effort/never-throw; see
   * contract-evaluator.ts for the degrade contract.
   */
  contractEvaluator?: ContractEvaluator;
  /** QE2: Lifecycle hooks for intelligence integration (QuoxMind, observations, learning) */
  hooks?: LifecycleHooks;
  layers?: {
    ingress?: IngressLayer;
    identity?: IdentityLayer;
    policy?: PolicyLayer;
    context?: ContextLayer;
    verify?: VerifyLayer;
    assemble?: AssembleLayer;
  };
}

/** Saved state for resuming a paused execution */
export interface PauseState {
  pausedNodeId: string;
  completedNodes: string[];
  nodeOutputs: Record<string, unknown>;
  approvalId?: string;
  pauseReason?: string;
  /** True if this is a human:task node (response data becomes node output) */
  humanTask?: boolean;
  /** Maps human actions to next-node IDs (null = terminate) */
  returnNodes?: Record<string, string | null>;
  /** quox#513: id of the ops.approval.request / ops.human_task.requested envelope that
   * caused the pause, so resume() can chain its decision envelope via reply_to. */
  requestEnvelopeId?: string;
}

export interface PipelineResult {
  success: boolean;
  output: unknown;
  error?: { code: string; message: string; details?: unknown };
  executionId: string;
  correlationId: string;
  envelopes: Envelope[];
  duration: number;
  /** True when execution paused (awaiting approval) */
  paused?: boolean;
  /** Node that caused the pause */
  pausedNodeId?: string;
  /** State needed to resume */
  pauseState?: PauseState;
  /** AEE-FULL Gap 4: True when execution was cancelled */
  cancelled?: boolean;
}

/**
 * Orchestrates workflow execution through control layers
 */
export class ControlPipeline {
  private store: EnvelopeStore;
  private executors: ExecutorRegistry;
  private eventBus?: EventBus;
  private hooks: LifecycleHooks;
  private budgetEvaluator?: BudgetEvaluator;
  private budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  private policyEvaluator?: PolicyEvaluator;
  private replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  private approvalEngine?: ApprovalEngine;
  private contractEvaluator: ContractEvaluator;
  /**
   * QUOXTRUST-B3: count of dispatch-settled envelope appends that failed
   * (the effect already happened, so this is accounted rather than
   * fail-closed, see dispatchExecutor()'s finally block). Never silently
   * swallowed; exposed for observability via
   * getDispatchSettledAppendFailures().
   */
  private dispatchSettledAppendFailures = 0;
  /**
   * QUOXTRUST-B4: count of durable-envelope-write failures on every other
   * store.append/appendBatch call in this class (post-hoc audit, pause,
   * resume, decision and per-node envelope writes). These appends fire
   * after the envelope's underlying event already happened, so they stay
   * non-blocking (.catch, not fail-closed) rather than aborting the run on
   * a transient store blip, but the failure is always accounted via
   * recordStoreAppendFailure() and never a bare swallow. Exposed via
   * getStoreAppendFailureCount(). Mirrors the dispatchSettledAppendFailures
   * pattern above; kept as a separate counter because dispatch-settled has
   * its own dedicated chokepoint (dispatchExecutor()'s finally block) with
   * outcome-specific context, while this counter covers everything else.
   */
  private storeAppendFailures = 0;
  private layers: {
    ingress: IngressLayer;
    identity: IdentityLayer;
    policy: PolicyLayer;
    context: ContextLayer;
    verify: VerifyLayer;
    assemble: AssembleLayer;
  };

  constructor(config: PipelineConfig) {
    this.store = config.store;
    this.executors = config.executors;
    this.eventBus = config.eventBus;
    this.hooks = config.hooks || NO_OP_HOOKS;
    this.budgetEvaluator = config.budgetEvaluator;
    this.budgetScopeResolver = config.budgetScopeResolver;
    this.policyEvaluator = config.policyEvaluator;
    this.replayOnlyResolver = config.replayOnlyResolver;
    this.approvalEngine = config.approvalEngine;
    this.contractEvaluator = config.contractEvaluator ?? new ContractEvaluator();

    // Use provided layers or defaults
    this.layers = {
      ingress: config.layers?.ingress ?? new DefaultIngressLayer(),
      identity: config.layers?.identity ?? new DefaultIdentityLayer(),
      policy: config.layers?.policy ?? new DefaultPolicyLayer(),
      context: config.layers?.context ?? new DefaultContextLayer(),
      verify: config.layers?.verify ?? new DefaultVerifyLayer(),
      assemble: config.layers?.assemble ?? new DefaultAssembleLayer(),
    };
  }

  /**
   * Execute a workflow with the given trigger data
   */
  async execute(workflow: Workflow, triggerData: unknown, options?: { executionId?: string; orgId?: string; cancellationSignal?: AbortSignal; cancellationActorProvider?: () => string | undefined }): Promise<PipelineResult> {
    const startTime = Date.now();
    const context = new ExecutionContext(workflow, triggerData, {
      executionId: options?.executionId,
      orgId: options?.orgId,
      // AEE-FULL Gap 4 — propagate external cancellation signal so the
      // ExecutionService.cancel() route can actually abort in-flight fetches.
      cancellationSignal: options?.cancellationSignal,
      // LAUNCH-SPINE — the signal carries no identity, so the actor comes
      // through this side-channel and is read at abort time.
      cancellationActorProvider: options?.cancellationActorProvider,
    });
    context.executors = this.executors; // QE2: expose registry for agentic sub-dispatch

    // STABILITY-AUDITS Fix 1: a workflow-run deadline was declared in the
    // Zod schema (WorkflowSettings.timeout) but never enforced anywhere —
    // a hung node (or one whose executor never honours cancellation) could
    // run forever. resolveWorkflowTimeoutMs() defaults to
    // DEFAULT_WORKFLOW_TIMEOUT_MS when settings.timeout is unset (a user
    // must opt into longer) and hard-caps at MAX_WORKFLOW_TIMEOUT_MS
    // regardless of what's requested. Cancels via context.cancel() — the
    // same cancellationSignal every other cancellation path already uses —
    // so Fix 4's executor wiring (util:wait etc.) actually observes it.
    const workflowTimeoutMs = resolveWorkflowTimeoutMs(workflow.settings);
    const timeoutHandle = setTimeout(() => {
      if (!context.cancelled) {
        context.cancel(`Workflow execution exceeded its ${workflowTimeoutMs}ms timeout`, 'timeout');
      }
    }, workflowTimeoutMs);
    // Never let a workflow-run deadline keep the process alive on its own.
    if (typeof (timeoutHandle as unknown as { unref?: () => void }).unref === 'function') {
      (timeoutHandle as unknown as { unref: () => void }).unref();
    }

    // REPLAY-ONLY .A-1a: resolve the effective replay_only flag ONCE at run
    // start, before any layer/executor runs, so every downstream consumer
    // (gates in .A-1b, LLM invoke bodies below) reads a stable value for the
    // life of the run. Foundation only — no gate/deny logic here. Best-effort:
    // a resolver failure defaults to false rather than blocking the run.
    if (this.replayOnlyResolver) {
      try {
        context.effectiveReplayOnly = await this.replayOnlyResolver({
          orgId: context.orgId,
          workflowId: workflow.id,
          runId: context.id,
        });
      } catch (err) {
        log.warn('replayOnlyResolver failed — defaulting effectiveReplayOnly to false', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allEnvelopes: Envelope[] = [];
    // R5.med: track reservation so we can finalize/release it after execution.
    let budgetReservationId: string | undefined;
    let budgetStore: import('../budget/budget-store.js').BudgetStore | undefined;

    // AEE-FULL P0.B: bind per-envelope flush hook so every emission streams to the store immediately.
    context.setEnvelopeFlush((env) => {
      this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
    });

    // Start execution
    const startEnv = context.start();
    allEnvelopes.push(startEnv);

    try {
      // P8.B: Pre-execution budget check
      if (this.budgetEvaluator && this.budgetScopeResolver) {
        const budgetScope = this.budgetScopeResolver(workflow.id, options?.orgId);
        if (budgetScope) {
          const budgetResult = await this.budgetEvaluator.evaluate({
            scope: budgetScope.scope,
            scopeId: budgetScope.scopeId,
            orgId: budgetScope.orgId,
            projected: { tokens_in: 0, tokens_out: 0, cost_usd_micro: 0, tool_calls: 0, duration_ms: 0, iterations: 0 },
          });
          // R5.med: capture reservationId for cleanup after execution.
          if (budgetResult.reservationId) {
            budgetReservationId = budgetResult.reservationId;
            budgetStore = this.budgetEvaluator.getStore?.();
          }
          if (!budgetResult.allowed) {
            // R3.med-1: Use reply() so reply_to chains back to the startEnv for audit trail.
            const exhaustedEnv = context.envelopes.reply(startEnv, {
              type: 'event',
              intent: Intents.BUDGET.EXHAUSTED,
              payload: {
                executionId: context.id,
                workflowId: workflow.id,
                scope: budgetScope.scope,
                scopeId: budgetScope.scopeId,
                orgId: budgetScope.orgId,
                exceeded: budgetResult.exceeded,
                reason: budgetResult.reason,
              },
            });
            allEnvelopes.push(exhaustedEnv);
            // Note: buildErrorResult now awaits appendBatch internally; the
            // explicit batch above already persisted the exhaustedEnv. Pass
            // the full allEnvelopes so buildErrorResult adds the fail envelope.
            return await this.buildErrorResult(context, 'BUDGET_EXHAUSTED', budgetResult.reason ?? 'Budget exhausted', allEnvelopes, startTime);
          }
        }
      }

      // R5.med: helper to release reservation before early-exit error results.
      const releaseAndBuildError = async (code: string, message: string, envs: Envelope[]) => {
        if (budgetReservationId && budgetStore?.releaseReservation) {
          await budgetStore.releaseReservation(budgetReservationId).catch(() => {});
          budgetReservationId = undefined;
        }
        return this.buildErrorResult(context, code, message, envs, startTime);
      };

      // 1. Ingress Layer - Normalize and validate input
      const ingressResult = await this.layers.ingress.process(triggerData, context);
      for (const env of ingressResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }
      if (!ingressResult.proceed) {
        return await releaseAndBuildError('INGRESS_REJECTED', ingressResult.reason ?? 'Request rejected', allEnvelopes);
      }

      // 2. Identity Layer - Authenticate/authorize
      const identityResult = await this.layers.identity.process(ingressResult.data, context);
      for (const env of identityResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }
      if (!identityResult.proceed) {
        return await releaseAndBuildError('IDENTITY_FAILED', identityResult.reason ?? 'Identity verification failed', allEnvelopes);
      }

      // 3. Policy Layer - Evaluate policies
      const policyResult = await this.layers.policy.process(identityResult.data, context);
      for (const env of policyResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }
      if (!policyResult.proceed) {
        return await releaseAndBuildError('POLICY_DENIED', policyResult.reason ?? 'Policy check failed', allEnvelopes);
      }

      // 4. Context Layer - Load variables, credentials
      const contextResult = await this.layers.context.process(policyResult.data, context);
      for (const env of contextResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }

      // 5. Execute Layer - Run the workflow nodes
      const executeResult = await this.executeWorkflow(workflow, contextResult.data, context, undefined, startEnv);
      // executor envelopes are drained per-envelope inside executeWorkflow; accumulate for PipelineResult
      allEnvelopes.push(...executeResult.envelopes);

      // Handle pause (approval gate)
      if (executeResult.paused && executeResult.pauseState) {
        const pauseEnv = context.envelopes.event(
          Intents.WORKFLOW.PAUSED,
          context.correlationId,
          {
            executionId: context.id,
            workflowId: workflow.id,
            pausedNodeId: executeResult.pauseState.pausedNodeId,
            approvalId: executeResult.pauseState.approvalId,
            reason: executeResult.pauseState.pauseReason,
          }
        );
        allEnvelopes.push(pauseEnv);
        this.store.append(pauseEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, pauseEnv, err));

        return {
          success: true,
          output: executeResult.output,
          executionId: context.id,
          correlationId: context.correlationId,
          envelopes: allEnvelopes,
          duration: Date.now() - startTime,
          paused: true,
          pausedNodeId: executeResult.pauseState.pausedNodeId,
          pauseState: executeResult.pauseState,
        };
      }

      // AEE-FULL Gap 4: handle cancellation — cancelled envelope already emitted via flush hook
      if (executeResult.cancelled) {
        await this.fireWorkflowComplete(false, workflow, context, startTime);
        return {
          success: false,
          output: null,
          error: { code: 'CANCELLED', message: 'Execution cancelled' },
          executionId: context.id,
          correlationId: context.correlationId,
          envelopes: allEnvelopes,
          duration: Date.now() - startTime,
          cancelled: true,
        };
      }

      if (!executeResult.success) {
        return await releaseAndBuildError(
          executeResult.error?.code ?? 'EXECUTION_FAILED',
          executeResult.error?.message ?? 'Workflow execution failed',
          allEnvelopes
        );
      }

      // 6. Verify Layer - Validate outputs
      const verifyResult = await this.layers.verify.process(executeResult.output, context);
      for (const env of verifyResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }
      if (!verifyResult.proceed) {
        return await releaseAndBuildError('VERIFY_FAILED', verifyResult.reason ?? 'Output verification failed', allEnvelopes);
      }

      // 7. Assemble Layer - Build final response
      const assembleResult = await this.layers.assemble.process(verifyResult.data, context);
      for (const env of assembleResult.envelopes) {
        allEnvelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }

      // Complete execution — context.complete() calls pushEnvelope() → flush hook streams it
      const completeEnv = context.complete(assembleResult.data);
      allEnvelopes.push(completeEnv);

      // Publish completion event to EventBus (enables event-driven triggers)
      if (this.eventBus) {
        this.eventBus.publish(completeEnv).catch(err => {
          log.error('EventBus publish error', { error: err instanceof Error ? err.message : String(err) });
        });
      }

      // AEE-FULL P0.B: envelopes already streamed per-emission; no end-of-run appendBatch needed.

      await this.fireWorkflowComplete(true, workflow, context, startTime);

      // R5.med: Finalize the budget reservation with actual (zero) cost on success.
      // The pipeline's pre-execution reservation is a placeholder — actual LLM/tool
      // costs are reported via the agentic executor's budget usage records.
      if (budgetReservationId && budgetStore?.finalizeReservation) {
        budgetStore.finalizeReservation(budgetReservationId, { tokens_in: 0, tokens_out: 0, cost_usd_micro: 0, tool_calls: 0, duration_ms: 0, iteration_count: 0 }).catch(() => {});
      }

      return {
        success: true,
        output: assembleResult.data,
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failEnv = context.fail({ code: 'PIPELINE_ERROR', message: errorMessage });
      allEnvelopes.push(failEnv);
      // context.fail() pushes through the flush hook; no explicit append needed.

      // R5.med: Release reservation on unhandled error so budget capacity is restored.
      if (budgetReservationId && budgetStore?.releaseReservation) {
        budgetStore.releaseReservation(budgetReservationId).catch(() => {});
      }

      // Publish failure event to EventBus
      if (this.eventBus) {
        this.eventBus.publish(failEnv).catch(() => {});
      }

      // AEE-FULL P0.B: envelopes already streamed per-emission; no end-of-run appendBatch needed.

      await this.fireWorkflowComplete(false, workflow, context, startTime);

      return {
        success: false,
        output: null,
        error: { code: 'PIPELINE_ERROR', message: errorMessage },
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
      };
    } finally {
      // STABILITY-AUDITS Fix 1: every return path above (success, paused,
      // cancelled, every gate rejection, and the thrown-error branch) runs
      // through this finally — stop the deadline timer so it never fires
      // after the run has already finished, and never keeps a completed
      // run's timer alive for the full timeout window.
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Execute workflow nodes in order
   */
  private async executeWorkflow(
    workflow: Workflow,
    input: unknown,
    context: ExecutionContext,
    resumeFrom?: { startNodeIds: string[]; nodeOutputs: Record<string, unknown> },
    startEnv?: Envelope
  ): Promise<{
    success: boolean;
    output: unknown;
    error?: { code: string; message: string };
    envelopes: Envelope[];
    paused?: boolean;
    pauseState?: PauseState;
    cancelled?: boolean;
  }> {
    const envelopes: Envelope[] = [];
    const completedNodes: string[] = [];
    const nodeOutputs: Record<string, unknown> = {};

    // AEE-FULL Gap 4: test seam — propagate context to executors that expose setContext().
    // Enables test executors to call context.cancel() mid-run to simulate cancellation.
    // Guard: getRegisteredTypes() may be absent on partial mock registries used in tests.
    if (typeof this.executors.getRegisteredTypes === 'function') {
      const seen = new Set<NodeExecutor>();
      for (const nodeType of this.executors.getRegisteredTypes()) {
        const exec = this.executors.get(nodeType);
        if (exec && !seen.has(exec) && typeof (exec as unknown as { setContext?: (c: ExecutionContext) => void }).setContext === 'function') {
          seen.add(exec);
          (exec as unknown as { setContext: (c: ExecutionContext) => void }).setContext(context);
        }
      }
    }

    let queue: Array<{ nodeId: string; input: unknown }>;
    const visited = new Set<string>();

    // STUDY-REV WB2-RELIABILITY R3: try/catch routing.
    // For each error:try node, precompute the set of nodes reachable from
    // its body (stopping at the catch node). Any failure inside that set
    // routes to the catch node with the error as input, instead of the
    // pipeline bailing out. This gives users real error handling.
    interface TryBlock { tryNodeId: string; bodyNodeIds: Set<string>; catchNodeId: string; finallyNodeId?: string }
    const tryBlocks: TryBlock[] = [];
    for (const node of workflow.nodes) {
      if (node.type === 'error:try') {
        const cfg = (node.config || {}) as { body?: string; catch?: string; finally?: string };
        if (!cfg.body || !cfg.catch) continue;
        const bodyNodeIds = new Set<string>();
        const stack = [cfg.body];
        while (stack.length) {
          const id = stack.pop()!;
          if (bodyNodeIds.has(id)) continue;
          if (id === cfg.catch) continue;
          bodyNodeIds.add(id);
          for (const edge of (workflow.edges || [])) {
            if (edge.source === id && !bodyNodeIds.has(edge.target)) {
              stack.push(edge.target);
            }
          }
        }
        tryBlocks.push({ tryNodeId: node.id, bodyNodeIds, catchNodeId: cfg.catch, finallyNodeId: cfg.finally });
      }
    }
    const findContainingTry = (failingNodeId: string): TryBlock | undefined =>
      tryBlocks.find(b => b.bodyNodeIds.has(failingNodeId));

    if (resumeFrom) {
      // Resume: start from specified nodes, pre-populate completed state
      queue = resumeFrom.startNodeIds.map(id => ({
        nodeId: id,
        input: resumeFrom.nodeOutputs[Object.keys(resumeFrom.nodeOutputs).pop()!] ?? input,
      }));
      Object.assign(nodeOutputs, resumeFrom.nodeOutputs);
      for (const id of Object.keys(resumeFrom.nodeOutputs)) {
        completedNodes.push(id);
        visited.add(id);
        // Inject into execution context so expressions can access nodes['id'].output
        context.setNodeState(id, { input: null, output: resumeFrom.nodeOutputs[id] });
      }
    } else {
      // Normal: find trigger nodes
      const triggers = workflow.nodes.filter(n => n.type.startsWith('trigger:'));
      if (triggers.length === 0) {
        return { success: false, output: null, error: { code: 'NO_TRIGGER', message: 'Workflow has no trigger nodes' }, envelopes };
      }
      queue = triggers.map(t => ({ nodeId: t.id, input }));
    }

    let lastOutput: unknown = input;

    while (queue.length > 0) {
      if (context.cancelled) break;  // AEE-FULL Gap 4: between-nodes cancel check
      const { nodeId, input: nodeInput } = queue.shift()!;

      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = getNode(workflow, nodeId);
      if (!node) continue;

      if (node.disabled) {
        context.skipNode(nodeId, 'disabled');
        continue;
      }

      // Get executor for this node type
      const executor = this.executors.get(node.type);
      if (!executor) {
        return {
          success: false,
          output: null,
          error: { code: 'UNKNOWN_NODE_TYPE', message: `No executor for node type: ${node.type}` },
          envelopes,
        };
      }

      // ─── Per-node governance gate (replay-only deny + policy deny/approval).
      // QUOXTRUST-B6: the gate body now lives in runPreExecutionGate(), shared
      // verbatim with the loop-body path so a node inside a loop cannot skip
      // it. The top-level path's disposition is unchanged: deny/gate-error →
      // fail the node; approval → pause at this node.
      const gate = await this.runPreExecutionGate(node, nodeInput, context, workflow, startEnv, nodeId, envelopes);
      if (gate.kind === 'deny' || gate.kind === 'gate_error') {
        return {
          success: false,
          output: null,
          error: {
            code: gate.kind === 'gate_error' ? 'POLICY_GATE_ERROR' : gate.code,
            message: gate.message,
          },
          envelopes,
        };
      }
      if (gate.kind === 'approval') {
        // Pause execution at this node — same flow as human:task
        return {
          success: true,
          output: nodeInput,
          envelopes,
          paused: true,
          pauseState: {
            pausedNodeId: nodeId,
            completedNodes: [...completedNodes],
            nodeOutputs,
            approvalId: gate.approvalId,
            pauseReason: gate.pauseReason,
          },
        };
      }

      // QE2: Pre-execution hook (QuoxMind advisory, context injection)
      let effectiveInput = nodeInput;
      if (this.hooks.beforeNodeExecute) {
        try {
          const hookResult = await this.hooks.beforeNodeExecute(node, nodeInput, {
            workflowId: workflow.id || '',
            correlationId: context.correlationId,
            nodeIndex: completedNodes.length,
            totalNodes: workflow.nodes.length,
          });
          if (hookResult?.additionalContext) {
            effectiveInput = typeof nodeInput === 'object' && nodeInput !== null
              ? { ...nodeInput as Record<string, unknown>, _hookContext: hookResult.additionalContext }
              : nodeInput;
          }
        } catch { /* hooks are non-fatal */ }
      }

      // Execute the node
      const execStartMs = Date.now();
      context.startNode(nodeId, effectiveInput);
      // AEE-FULL P0.B: context.startNode() now self-flushes NODE.STARTED via the hook.
      // Accumulate the envelope for PipelineResult.envelopes by reading the last one.
      const ctxEnvsAfterStart = context.getEnvelopes();
      envelopes.push(ctxEnvsAfterStart[ctxEnvsAfterStart.length - 1]);
      let result = await this.dispatchExecutor(executor, node, effectiveInput, context);
      const execDurationMs = Date.now() - execStartMs;
      for (const env of result.envelopes) {
        envelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }

      // Check for pause signal (approval gate)
      if (result.paused) {
        context.completeNode(nodeId, result.output);
        nodeOutputs[nodeId] = result.output;

        return {
          success: true,
          output: result.output,
          envelopes,
          paused: true,
          pauseState: {
            pausedNodeId: nodeId,
            completedNodes: [...completedNodes, nodeId],
            nodeOutputs,
            approvalId: result.metadata?.approvalId as string | undefined,
            pauseReason: result.pauseReason,
            humanTask: result.metadata?.humanTask as boolean | undefined,
            returnNodes: result.metadata?.returnNodes as Record<string, string | null> | undefined,
            // quox#513: capture the request envelope this pause originated from
            // (approval-gate emits ops.approval.request, human-task emits
            // ops.human_task.requested) so resume() can reply_to it.
            requestEnvelopeId: result.envelopes.find(
              e => e.intent === Intents.APPROVAL.REQUESTED || e.intent === 'ops.human_task.requested'
            )?.id,
          },
        };
      }

      if (!result.success) {
        context.failNode(nodeId, result.error ?? { code: 'NODE_FAILED', message: `Node ${nodeId} failed` });

        // SD-2: Per-node aocl.verify.* — fail branch (output null → output_exists fails).
        await this.emitPerNodeVerify(context, envelopes, workflow, node, nodeId, result.output ?? null);

        // QE2 / TRUST-GATE-1.4: Failure hook (pattern detection, escalation
        // decisions, bounded retry). Evaluated BEFORE try/catch routing so
        // that a successful retry recovers the node instead of
        // unconditionally handing off to the catch handler — retry
        // exhaustion still falls through to the same routing below.
        if (this.hooks.onNodeFail) {
          try {
            const failAction = await this.hooks.onNodeFail(node, result.error!, {
              workflowId: workflow.id || '',
              correlationId: context.correlationId,
              attempt: 1,
            });
            if (failAction?.action === 'retry') {
              result = await this.retryNode(executor, node, nodeId, effectiveInput, context, envelopes, failAction);
            } else if (failAction?.action === 'skip') {
              // Hook says skip this node — continue to next
              completedNodes.push(nodeId);
              const outEdges = getOutgoingEdges(workflow, nodeId);
              for (const edge of outEdges) {
                queue.push({ nodeId: edge.target, input: lastOutput });
              }
              continue;
            }
            // 'continue', 'escalate' — fall through to default behaviour for now
          } catch { /* hooks are non-fatal */ }
        }
      }

      if (!result.success) {
        // STUDY-REV WB2-RELIABILITY R3: try/catch routing.
        // If this failing node lives inside a try block's body chain, route
        // to the catch handler with the error as input instead of bailing.
        // Reached whether or not a retry was attempted above (retries are
        // exhausted by the time we get here).
        const containingTry = findContainingTry(nodeId);
        if (containingTry) {
          // Skip the catch's normal visited check by removing it from the
          // visited set if it was speculatively added (it shouldn't be, but
          // belt and braces).
          visited.delete(containingTry.catchNodeId);
          queue.push({
            nodeId: containingTry.catchNodeId,
            input: { error: result.error ?? { code: 'NODE_FAILED', message: `Node ${nodeId} failed` } },
          });
          // Once routed to catch, the try block's coverage no longer applies
          // (otherwise a failure inside the catch would loop back into itself).
          containingTry.bodyNodeIds.clear();
          continue;
        }

        // Check workflow error behavior
        if (workflow.settings?.errorBehavior !== 'continue') {
          return {
            success: false,
            output: null,
            error: result.error ?? { code: 'NODE_FAILED', message: `Node ${nodeId} failed without error details` },
            envelopes,
          };
        }
      } else {
        context.completeNode(nodeId, result.output);
        completedNodes.push(nodeId);
        nodeOutputs[nodeId] = result.output;
        lastOutput = result.output;

        // SD-2: Per-node aocl.verify.* — success branch.
        await this.emitPerNodeVerify(context, envelopes, workflow, node, nodeId, result.output);

        // QE2: Post-execution hook (observation capture, outcome recording, learning)
        if (this.hooks.afterNodeExecute) {
          try {
            const observation = this.hooks.captureObservation
              ? await this.hooks.captureObservation(node, result)
              : null;
            await this.hooks.afterNodeExecute(node, result, observation, {
              workflowId: workflow.id || '',
              correlationId: context.correlationId,
              nodeIndex: completedNodes.length,
              durationMs: execDurationMs,
              // QF-MT: thread the per-run org through so hooks can prefer the
              // real run org over their construction-time closure org.
              orgId: context.orgId,
            });
          } catch { /* hooks are non-fatal */ }
        }

        // Handle loop multi-iteration
        const output = result.output as Record<string, unknown> | null;
        if (output && output._isLoop === true) {
          const items = output.items as Array<Record<string, unknown>>;
          const bodyNodeId = output.bodyNodeId as string;
          const nextNodeId = output.nextNodeId as string | undefined;

          const iterationResults: unknown[] = [];
          if (bodyNodeId && items && items.length > 0) {
            const bodyNode = getNode(workflow, bodyNodeId);
            if (bodyNode) {
              const bodyExecutor = this.executors.get(bodyNode.type);
              if (bodyExecutor) {
                for (const iterationInput of items) {
                  // Allow body node to re-execute each iteration
                  visited.delete(bodyNodeId);
                  // Expose loop context so body node expressions can use
                  // ${item.x}, ${loop.item.x}, ${index}, ${loop.index}
                  const itemVar = (iterationInput as Record<string, unknown>).item;
                  const idxVar = (iterationInput as Record<string, unknown>).index as number
                    ?? (iterationInput as Record<string, unknown>).idx as number
                    ?? 0;
                  context.setLoopContext({ item: itemVar, index: idxVar });

                  // QUOXTRUST-B6: a loop body passes the SAME governance gate as
                  // a top-level node (replay-only deny + per-node policy deny/
                  // approval). Previously this branch skipped the gate entirely.
                  const bodyGate = await this.runPreExecutionGate(bodyNode, iterationInput, context, workflow, undefined, bodyNodeId, envelopes);
                  if (bodyGate.kind === 'deny' || bodyGate.kind === 'gate_error') {
                    const code = bodyGate.kind === 'gate_error' ? 'POLICY_GATE_ERROR' : bodyGate.code;
                    context.setLoopContext(undefined);
                    context.failNode(bodyNodeId, { code, message: bodyGate.message });
                    await this.emitPerNodeVerify(context, envelopes, workflow, bodyNode, bodyNodeId, null);
                    if (workflow.settings?.errorBehavior !== 'continue') {
                      return { success: false, output: null, error: { code, message: bodyGate.message }, envelopes };
                    }
                    continue;
                  }
                  if (bodyGate.kind === 'approval') {
                    // QUOXTRUST-B7: an approval-required loop body cannot be
                    // satisfied — mid-loop pause/resume is not supported — so
                    // fail CLOSED rather than proceed past an undecided approval.
                    context.setLoopContext(undefined);
                    const msg = `Approval-required node '${bodyNodeId}' cannot run as a loop body (mid-loop resume unsupported); execution blocked`;
                    context.failNode(bodyNodeId, { code: 'LOOP_BODY_APPROVAL_UNSUPPORTED', message: msg });
                    return { success: false, output: null, error: { code: 'LOOP_BODY_APPROVAL_UNSUPPORTED', message: msg }, envelopes };
                  }

                  context.startNode(bodyNodeId, iterationInput);
                  // AEE-FULL P0.B: self-flushed via hook; accumulate for PipelineResult.envelopes.
                  const bodyCtxEnvs = context.getEnvelopes();
                  envelopes.push(bodyCtxEnvs[bodyCtxEnvs.length - 1]);
                  // QUOXTRUST-B6: route through the ONE chokepoint (dispatchExecutor)
                  // so the loop body gets B3 durable dispatch-intent-before-effect,
                  // exactly like a top-level outward node.
                  const bodyResult = await this.dispatchExecutor(bodyExecutor, bodyNode, iterationInput, context);
                  context.setLoopContext(undefined); // clear after iteration
                  for (const env of bodyResult.envelopes) {
                    envelopes.push(env);
                    this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
                  }

                  // QUOXTRUST-B7: an executor that itself returns paused
                  // (approval-gate / human-task on the pending path) must NOT be
                  // treated as a completed iteration the loop silently runs past.
                  if (bodyResult.paused) {
                    const msg = `Loop body node '${bodyNodeId}' paused (awaiting approval); mid-loop pause/resume is not supported, execution blocked`;
                    context.failNode(bodyNodeId, { code: 'LOOP_BODY_PAUSE_UNSUPPORTED', message: msg });
                    await this.emitPerNodeVerify(context, envelopes, workflow, bodyNode, bodyNodeId, null);
                    return { success: false, output: null, error: { code: 'LOOP_BODY_PAUSE_UNSUPPORTED', message: msg }, envelopes };
                  }

                  if (bodyResult.success) {
                    context.completeNode(bodyNodeId, bodyResult.output);
                    iterationResults.push(bodyResult.output);
                    // SD-2: Per-node aocl.verify.* — loop body success.
                    await this.emitPerNodeVerify(context, envelopes, workflow, bodyNode, bodyNodeId, bodyResult.output);
                  } else {
                    context.failNode(bodyNodeId, bodyResult.error ?? { code: 'NODE_FAILED', message: `Node ${bodyNodeId} failed` });
                    // SD-2: Per-node aocl.verify.* — loop body fail.
                    await this.emitPerNodeVerify(context, envelopes, workflow, bodyNode, bodyNodeId, bodyResult.output ?? null);
                    if (workflow.settings?.errorBehavior !== 'continue') {
                      return { success: false, output: null, error: bodyResult.error, envelopes };
                    }
                  }
                }
              }
            }
          }

          // Mark body node as fully visited
          visited.add(bodyNodeId);

          // Update outputs with iteration results
          lastOutput = iterationResults;
          nodeOutputs[nodeId] = iterationResults;

          // Continue to the after-loop node
          if (nextNodeId && !visited.has(nextNodeId)) {
            queue.push({ nodeId: nextNodeId, input: iterationResults });
          }
          continue;
        }
      }

      // Determine next nodes
      const nextNodeIds = result.nextNodes ?? getOutgoingEdges(workflow, nodeId).map(e => e.target);

      for (const nextId of nextNodeIds) {
        if (!visited.has(nextId)) {
          queue.push({ nodeId: nextId, input: result.output });
        }
      }
    }

    // AEE-FULL Gap 4: check if loop exited due to cancellation
    if (context.cancelled) {
      return {
        success: false,
        output: null,
        error: { code: 'CANCELLED', message: 'Execution cancelled' },
        envelopes,
        cancelled: true,
      };
    }

    return { success: true, output: lastOutput, envelopes };
  }

  /**
   * Resume a paused workflow execution from the point it was paused.
   *
   * @param workflow - The workflow definition
   * @param pauseState - Saved state from the paused execution
   * @param decision - Approval decision (approved/denied)
   * @param runContext - quox#513: the ORIGINAL execution's id/orgId. Without
   *   these, ExecutionContext mints a fresh id and a fresh corr
   *   (`wf-${workflowId}-${newId.slice(-8)}`) that never matches the paused
   *   execution's own correlationId — every envelope resume() emits (the
   *   decision, the terminal quox.flow.failed/completed) would then be
   *   invisible to GET /api/executions/:id/envelopes, which queries by the
   *   execution's stored correlationId. Passing the same id back in makes
   *   ExecutionContext recompute the identical corr, so resume's envelopes
   *   land in the same trail as the paused run's.
   */
  async resume(
    workflow: Workflow,
    pauseState: PauseState,
    decision: { approved: boolean; approver: string; reason?: string; requestChanges?: boolean; data?: Record<string, unknown> },
    runContext: { executionId?: string; orgId?: string } = {}
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const context = new ExecutionContext(workflow, {}, { executionId: runContext.executionId, orgId: runContext.orgId });
    const allEnvelopes: Envelope[] = [];

    // AEE-FULL P0.B (orchestrator follow-up): bind per-envelope flush hook
    // so resume runs also stream live. Mirrors execute() at line ~135.
    context.setEnvelopeFlush((env) => {
      this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
    });

    // Emit resume event
    const resumeEnv = context.envelopes.event(
      Intents.WORKFLOW.RESUMED,
      context.correlationId,
      {
        executionId: context.id,
        workflowId: workflow.id,
        resumedNodeId: pauseState.pausedNodeId,
        approvalId: pauseState.approvalId,
        decision: decision.requestChanges ? 'request_changes' : decision.approved ? 'approved' : 'denied',
        approver: decision.approver,
      }
    );
    allEnvelopes.push(resumeEnv);
    this.store.append(resumeEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, resumeEnv, err));

    // quox#513: record the approve/deny decision itself as its own
    // ops.approval.* evidence-trail entry (distinct from quox.flow.resumed,
    // which is a workflow-lifecycle event, not the decision record). Skipped
    // for request_changes — that's a review-cycle event, not a grant/deny.
    if (!decision.requestChanges) {
      const decisionEnv = context.envelopes.create({
        to: 'quox.audit',
        type: 'event',
        intent: decision.approved ? Intents.APPROVAL.GRANTED : Intents.APPROVAL.DENIED,
        corr: context.correlationId,
        reply_to: pauseState.requestEnvelopeId ?? null,
        payload: {
          executionId: context.id,
          workflowId: workflow.id,
          nodeId: pauseState.pausedNodeId,
          approvalId: pauseState.approvalId,
          approver: decision.approver,
          reason: decision.reason,
        },
      });
      allEnvelopes.push(decisionEnv);
      this.store.append(decisionEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, decisionEnv, err));
    }

    // HV2-2: Request changes — re-enter the predecessor node with feedback
    if (decision.requestChanges) {
      const incomingEdges = getIncomingEdges(workflow, pauseState.pausedNodeId);
      if (incomingEdges.length === 0) {
        return await this.buildErrorResult(
          context, 'NO_PREDECESSOR',
          `Cannot request changes: approval node ${pauseState.pausedNodeId} has no predecessor to re-enter`,
          allEnvelopes, startTime
        );
      }

      // Re-enter the predecessor node(s) with human feedback merged into their previous input
      const predecessorIds = incomingEdges.map(e => e.source);

      // Build the re-entry input: previous output of the predecessor + human feedback
      const feedbackInput: Record<string, unknown> = {};
      for (const predId of predecessorIds) {
        if (pauseState.nodeOutputs[predId] && typeof pauseState.nodeOutputs[predId] === 'object') {
          Object.assign(feedbackInput, pauseState.nodeOutputs[predId] as Record<string, unknown>);
        }
      }
      feedbackInput._humanFeedback = {
        action: 'request_changes',
        reason: decision.reason || '',
        approver: decision.approver,
        iteration: ((feedbackInput._humanFeedback as Record<string, unknown>)?.iteration as number || 0) + 1,
      };

      // Remove predecessors and the approval gate from completed nodes so they re-execute
      const reEntryCompleted = pauseState.completedNodes.filter(
        id => !predecessorIds.includes(id) && id !== pauseState.pausedNodeId
      );
      const reEntryOutputs: Record<string, unknown> = {};
      for (const [id, output] of Object.entries(pauseState.nodeOutputs)) {
        if (!predecessorIds.includes(id) && id !== pauseState.pausedNodeId) {
          reEntryOutputs[id] = output;
        }
      }

      const executeResult = await this.executeWorkflow(workflow, feedbackInput, context, {
        startNodeIds: predecessorIds,
        nodeOutputs: reEntryOutputs,
      });
      allEnvelopes.push(...executeResult.envelopes);

      // If the re-execution hits the approval gate again, we pause again (new review cycle)
      if (executeResult.paused && executeResult.pauseState) {
        const pauseEnv = context.envelopes.event(
          Intents.WORKFLOW.PAUSED,
          context.correlationId,
          {
            executionId: context.id,
            workflowId: workflow.id,
            pausedNodeId: executeResult.pauseState.pausedNodeId,
            approvalId: executeResult.pauseState.approvalId,
          }
        );
        allEnvelopes.push(pauseEnv);
        this.store.append(pauseEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, pauseEnv, err));
        // AEE-FULL P0.B: envelopes streamed per-emission via flush hook.

        return {
          success: true,
          output: executeResult.output,
          executionId: context.id,
          correlationId: context.correlationId,
          envelopes: allEnvelopes,
          duration: Date.now() - startTime,
          paused: true,
          pausedNodeId: executeResult.pauseState.pausedNodeId,
          pauseState: executeResult.pauseState,
        };
      }

      // Re-execution completed without another pause
      if (executeResult.success) {
        const completeEnv = context.complete(executeResult.output);
        allEnvelopes.push(completeEnv);
        // context.complete() self-flushes via the flush hook bound above.
      }

      return {
        success: executeResult.success,
        output: executeResult.output,
        error: executeResult.error,
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
      };
    }

    // If denied, fail immediately
    if (!decision.approved) {
      const failEnv = context.fail({
        code: 'APPROVAL_DENIED',
        message: `Approval denied by ${decision.approver}${decision.reason ? ': ' + decision.reason : ''}`,
      });
      allEnvelopes.push(failEnv);
      // context.fail() self-flushes via the flush hook bound at resume() start.

      return {
        success: false,
        output: null,
        error: {
          code: 'APPROVAL_DENIED',
          message: `Approval denied by ${decision.approver}${decision.reason ? ': ' + decision.reason : ''}`,
        },
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
      };
    }

    // Enrich paused node output with human response data
    const isHumanTask = (pauseState as any).humanTask === true;
    const humanResponse = {
      action: decision.approved ? 'approved' : decision.requestChanges ? 'request_changes' : 'denied',
      approver: decision.approver,
      comment: decision.reason || '',
      data: (decision as any).data || {},
    };

    if (isHumanTask) {
      // For human:task nodes, merge response into the node output
      // so downstream nodes can access ${nodes['humanStep'].output.action}, .comment, .data
      const existingOutput = pauseState.nodeOutputs[pauseState.pausedNodeId] || {};
      pauseState.nodeOutputs[pauseState.pausedNodeId] = {
        ...(typeof existingOutput === 'object' ? existingOutput : {}),
        response: humanResponse,
        action: humanResponse.action,
        comment: humanResponse.comment,
        data: humanResponse.data,
      };
    }

    // Determine next nodes — check returnNodes mapping first, then fall back to edges
    const returnNodes = (pauseState as any).returnNodes as Record<string, string | null> | undefined;
    let nextNodeIds: string[];

    if (returnNodes && humanResponse.action in returnNodes) {
      const target = returnNodes[humanResponse.action];
      if (target === null) {
        // null = terminate workflow
        const completeEnv = context.complete(pauseState.nodeOutputs[pauseState.pausedNodeId]);
        allEnvelopes.push(completeEnv);
        // context.complete() self-flushes via the flush hook bound at resume() start.
        return {
          success: true,
          output: pauseState.nodeOutputs[pauseState.pausedNodeId],
          executionId: context.id,
          correlationId: context.correlationId,
          envelopes: allEnvelopes,
          duration: Date.now() - startTime,
        };
      }
      nextNodeIds = [target];
    } else {
      nextNodeIds = getOutgoingEdges(workflow, pauseState.pausedNodeId).map(e => e.target);
    }

    if (nextNodeIds.length === 0) {
      // Paused node was the last — execution complete
      const completeEnv = context.complete(pauseState.nodeOutputs[pauseState.pausedNodeId]);
      allEnvelopes.push(completeEnv);
      // context.complete() self-flushes via the flush hook bound at resume() start.

      return {
        success: true,
        output: pauseState.nodeOutputs[pauseState.pausedNodeId],
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
      };
    }

    // Resume execution from the next nodes
    const executeResult = await this.executeWorkflow(workflow, isHumanTask ? humanResponse : {}, context, {
      startNodeIds: nextNodeIds,
      nodeOutputs: pauseState.nodeOutputs,
    });
    allEnvelopes.push(...executeResult.envelopes);

    // Handle nested pause (another gate after the first)
    if (executeResult.paused && executeResult.pauseState) {
      const pauseEnv = context.envelopes.event(
        Intents.WORKFLOW.PAUSED,
        context.correlationId,
        {
          executionId: context.id,
          workflowId: workflow.id,
          pausedNodeId: executeResult.pauseState.pausedNodeId,
          approvalId: executeResult.pauseState.approvalId,
        }
      );
      allEnvelopes.push(pauseEnv);
      this.store.append(pauseEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, pauseEnv, err));
      // AEE-FULL P0.B: envelopes streamed per-emission via flush hook.

      return {
        success: true,
        output: executeResult.output,
        executionId: context.id,
        correlationId: context.correlationId,
        envelopes: allEnvelopes,
        duration: Date.now() - startTime,
        paused: true,
        pausedNodeId: executeResult.pauseState.pausedNodeId,
        pauseState: executeResult.pauseState,
      };
    }

    if (!executeResult.success) {
      return await this.buildErrorResult(
        context,
        executeResult.error?.code ?? 'EXECUTION_FAILED',
        executeResult.error?.message ?? 'Resume execution failed',
        allEnvelopes,
        startTime
      );
    }

    // Complete
    const completeEnv = context.complete(executeResult.output);
    allEnvelopes.push(completeEnv);
    // context.complete() self-flushes via the flush hook bound at resume() start.

    // Publish resume completion to EventBus
    if (this.eventBus) {
      this.eventBus.publish(completeEnv).catch(() => {});
    }

    return {
      success: true,
      output: executeResult.output,
      executionId: context.id,
      correlationId: context.correlationId,
      envelopes: allEnvelopes,
      duration: Date.now() - startTime,
    };
  }

  private async buildErrorResult(
    context: ExecutionContext,
    code: string,
    message: string,
    envelopes: Envelope[],
    startTime: number
  ): Promise<PipelineResult> {
    const failEnv = context.fail({ code, message });
    envelopes.push(failEnv);

    // Publish failure event to EventBus
    if (this.eventBus) {
      this.eventBus.publish(failEnv).catch(() => {});
    }

    // R5.high-3: Await envelope persistence so audit trail is durable before returning.
    // On failure, log lost envelopes to stdout so they are recoverable from logs.
    try {
      await this.store.appendBatch(envelopes, context.orgId ?? SYSTEM_SCOPE);
    } catch (storeErr) {
      const errMsg = storeErr instanceof Error ? storeErr.message : String(storeErr);
      log.error(
        `AUDIT_LOSS_RISK: appendBatch failed for ${code} rejection — envelopes lost. ` +
          `code=${code} executionId=${context.id} correlationId=${context.correlationId} ` +
          `envelopeCount=${envelopes.length} storeError=${errMsg} ` +
          `payloads=${JSON.stringify(envelopes.map(e => ({ id: e.id, intent: e.intent })))}`
      );
    }

    // Fire onWorkflowComplete hook for failed terminations.
    // Use the workflow stored on the context (set in constructor).
    this.fireWorkflowComplete(false, context.workflow, context, startTime).catch(() => {});

    return {
      success: false,
      output: null,
      error: { code, message },
      executionId: context.id,
      correlationId: context.correlationId,
      envelopes,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Fire the onWorkflowComplete lifecycle hook with a derived summary.
   * Hook errors are swallowed — execution must not depend on hook success.
   * Pause is intentionally NOT a completion event.
   */
  private async fireWorkflowComplete(
    success: boolean,
    workflow: Workflow,
    context: ExecutionContext,
    startTime: number
  ): Promise<void> {
    if (!this.hooks.onWorkflowComplete) return;

    const nodes = context.nodeExecutions;
    let nodesExecuted = 0;
    const errors: Array<{ nodeId: string; error: string }> = [];
    for (const exec of nodes.values()) {
      if (exec.status === 'completed') nodesExecuted++;
      if (exec.status === 'failed' && exec.error) {
        errors.push({ nodeId: exec.nodeId, error: exec.error.message });
      }
    }

    try {
      await this.hooks.onWorkflowComplete(success, {
        workflowId: workflow.id || '',
        correlationId: context.correlationId,
        nodesExecuted,
        nodesTotal: workflow.nodes.length,
        durationMs: Date.now() - startTime,
        errors,
      });
    } catch { /* hooks are non-fatal */ }
  }

  // SD-2: Per-node verify helper — mirrors thin checks in DefaultVerifyLayer.
  /**
   * TRUST-GATE-1.3: Dispatch an executor with a try/catch around it so a
   * THROWN exception is converted into the standard executor error-result
   * shape instead of bypassing per-node failure routing (try/catch-node
   * routing, onNodeFail hook) and hard-failing the whole run.
   *
   * QUOXTRUST-B3: this is the ONE chokepoint every executor passes through,
   * so durable dispatch-intent-before-effect lives here, generically,
   * driven by `executor.hasExternalEffect` rather than re-implemented per
   * executor. For outward executors:
   *   1. BEFORE execute() runs, a `quox.flow.dispatch.intent` envelope is
   *      durably appended and AWAITED. If the append rejects, execute() is
   *      NEVER called, this throws DispatchIntentError instead (fail
   *      closed: no durable intent, no effect).
   *   2. AFTER execute() resolves or throws, a `quox.flow.dispatch.settled`
   *      envelope records the outcome, correlated back to the intent via
   *      payload.corr = intentEnv.id. The effect already happened by this
   *      point, so this append is best-effort, but its failure is
   *      accounted (dispatchSettledAppendFailures + log.warn), never a bare
   *      swallow.
   */
  /**
   * QUOXTRUST-B6: the SINGLE per-node governance gate (replay-only deny +
   * per-node policy deny/approval), extracted so that BOTH the top-level node
   * path and the loop-body path run the identical enforcement. Previously the
   * loop body re-implemented node execution and this gate was inlined only on
   * the top-level path, so a node wrapped as a loop body skipped it entirely.
   * Sharing one gate is what structurally prevents that bypass from recurring.
   *
   * Side effects: pushes any deny / gate-error envelope (and, on the proceed
   * path, the POLICY_EVALUATED success-audit envelope) onto `envelopes`, and
   * durably appends the success-audit envelope. Returns a disposition; the
   * CALLER decides how to act on it (the top-level path pauses on 'approval';
   * the loop-body path fails closed, because mid-loop resume is not supported).
   */
  private async runPreExecutionGate(
    node: Node,
    nodeInput: unknown,
    context: ExecutionContext,
    workflow: Workflow,
    startEnv: Envelope | undefined,
    nodeId: string,
    envelopes: Envelope[]
  ): Promise<
    | { kind: 'proceed' }
    | { kind: 'deny'; code: string; message: string }
    | { kind: 'gate_error'; message: string }
    | { kind: 'approval'; approvalId: string; pauseReason: string }
  > {
    // ─── REPLAY-ONLY Gate: per-node hard-deny for LLM-capable node types
    // with no replay path (independent of org policy setup). ──────────────
    if (context.effectiveReplayOnly && REPLAY_ONLY_DENIED_NODE_TYPES.has(node.type)) {
      const denyPayload = {
        executionId: context.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId,
        nodeName: node.name ?? nodeId,
        nodeType: node.type,
        reason: 'replay_only_llm_node_denied',
        message: `Node type '${node.type}' is not permitted under replay-only mode: it calls the LLM directly and has no replay path`,
      };
      const denyEnv = startEnv
        ? context.envelopes.reply(startEnv, { type: 'event', intent: Intents.AOCL.POLICY_DENIED, payload: denyPayload })
        : context.envelopes.event(Intents.AOCL.POLICY_DENIED, context.correlationId, denyPayload);
      envelopes.push(denyEnv);
      return { kind: 'deny', code: 'replay_only_llm_node_denied', message: denyPayload.message };
    }

    // Per-node policy gate — evaluate before QE2 hook and actual execution.
    if (this.policyEvaluator && this.approvalEngine) {
      try {
        const policyResult = await this.policyEvaluator.evaluateForNode({
          workflowId: workflow.id || '',
          workflowName: workflow.name || '',
          executionId: context.id,
          correlationId: context.correlationId,
          nodeId,
          nodeType: node.type,
          input: nodeInput,
          variables: context.getVariables(),
          env: {},
          currentBudgetState: null,
          orgId: context.orgId,
        });

        if (policyResult.denied && policyResult.denySpec) {
          const spec = policyResult.denySpec;
          const denyPayload = {
            executionId: context.id,
            workflowId: workflow.id,
            workflowName: workflow.name,
            nodeId,
            nodeName: node.name ?? nodeId,
            nodeType: node.type,
            policyId: spec.policyId,
            policyName: spec.policyName,
            ruleId: spec.ruleId,
            reason: spec.reason,
            message: `Node '${nodeId}' denied by policy '${spec.policyId}' (${spec.policyName}): ${spec.reason}`,
          };
          const denyEnv = startEnv
            ? context.envelopes.reply(startEnv, { type: 'event', intent: Intents.AOCL.POLICY_DENIED, payload: denyPayload })
            : context.envelopes.event(Intents.AOCL.POLICY_DENIED, context.correlationId, denyPayload);
          envelopes.push(denyEnv);
          return { kind: 'deny', code: 'POLICY_DENIED', message: denyPayload.message };
        }

        if (policyResult.requiresApproval && policyResult.approvalSpec) {
          const spec = policyResult.approvalSpec;
          const approval = await this.approvalEngine.createApproval({
            correlationId: context.correlationId,
            workflowId: workflow.id || '',
            workflowName: workflow.name,
            executionId: context.id,
            nodeId,
            trigger: {
              policyId: spec.policyId,
              ruleId: spec.ruleId,
              condition: `policy:${spec.policyId}`,
            },
            approvers: spec.approvers,
            timeoutMs: spec.timeout_ms,
            metadata: {
              policy_injected: true,
              policyId: spec.policyId,
              policyName: spec.policyName,
              templateId: spec.templateId,
              orgId: context.orgId,
            },
          });
          return { kind: 'approval', approvalId: approval.id, pauseReason: `policy:${spec.policyId} — ${spec.policyName}` };
        }
      } catch (policyErr) {
        // Policy gate store failure → fail-CLOSED.
        log.error(`Policy gate store failure for node ${nodeId}`, {
          error: policyErr instanceof Error ? policyErr.message : String(policyErr),
        });
        const gateErrPayload = {
          executionId: context.id,
          workflowId: workflow.id,
          nodeId,
          error: policyErr instanceof Error ? policyErr.message : String(policyErr),
        };
        const gateErrEnv = startEnv
          ? context.envelopes.reply(startEnv, { type: 'event', intent: Intents.POLICY.GATE_ERROR, payload: gateErrPayload })
          : context.envelopes.event(Intents.POLICY.GATE_ERROR, context.correlationId, gateErrPayload);
        envelopes.push(gateErrEnv);
        return { kind: 'gate_error', message: 'Policy gate evaluation failed — execution blocked for safety' };
      }

      // RSP-CONTRACT Phase 1b: observe-mode contract check. Best-effort, never blocks.
      let contractCheck = { checked: false, would_violate: false, contract_clause: null as unknown };
      try {
        const { agentId: contractAgentId, action: contractAction } = resolveNodeAgentAction(node);
        contractCheck = await this.contractEvaluator.evaluate({
          orgId: context.orgId,
          agentId: contractAgentId,
          action: contractAction,
        });
      } catch (contractErr) {
        log.debug(`RSP-CONTRACT observe-mode check failed for node ${nodeId} — degrading to no-op`, {
          error: contractErr instanceof Error ? contractErr.message : String(contractErr),
        });
      }

      if (contractCheck.would_violate) {
        log.warn(`RSP-CONTRACT observe-mode: node ${nodeId} (${node.type}) would violate agent contract`, {
          workflowId: workflow.id,
          nodeId,
          nodeType: node.type,
          contract_clause: contractCheck.contract_clause,
        });
      }

      const policyAuditEnv = context.envelopes.event(
        Intents.AOCL.POLICY_EVALUATED,
        context.correlationId,
        {
          executionId: context.id,
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId,
          nodeName: node.name ?? nodeId,
          nodeType: node.type,
          requiresApproval: false,
          contract_clause: contractCheck.contract_clause,
          would_violate: contractCheck.would_violate,
        }
      );
      envelopes.push(policyAuditEnv);
      this.store.append(policyAuditEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, policyAuditEnv, err));
    }

    return { kind: 'proceed' };
  }

  private async dispatchExecutor(
    executor: NodeExecutor,
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    let intentEnv: Envelope | undefined;

    if (executor.hasExternalEffect) {
      intentEnv = context.envelopes.event(
        Intents.DISPATCH.INTENT,
        context.correlationId,
        {
          nodeId: node.id,
          executorType: node.type,
          execId: context.id,
          inputDigest: hashSnapshot(input),
        }
      );
      try {
        await this.store.append(intentEnv, context.orgId ?? SYSTEM_SCOPE);
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        log.error(
          `Dispatch-intent append failed for node ${node.id} (${node.type}), refusing to dispatch (fail-closed)`,
          { error: cause.message }
        );
        throw new DispatchIntentError(node.id, node.type, cause);
      }
    }

    // QUOXTRUST-B5: a third settlement value alongside 'completed'/'failed'
    // for a dispatch whose outcome could not be determined (an external
    // effect where the request may have already reached the upstream
    // before a transport failure was observed). Distinct from the crash-
    // path OUTCOME_UNKNOWN reconciliation (dispatch-intent-reconciliation.ts):
    // this is the in-flight case, recorded synchronously here rather than
    // discovered on a later boot.
    let outcome: 'completed' | 'failed' | 'outcome_unknown' = 'completed';
    try {
      const result = await executor.execute(node, input, context);
      outcome = result.success ? 'completed' : (result.ambiguous ? 'outcome_unknown' : 'failed');
      return result;
    } catch (err) {
      const isAmbiguous = err instanceof AmbiguousDispatchError;
      outcome = isAmbiguous ? 'outcome_unknown' : 'failed';
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Executor threw for node ${node.id} (${node.type})`, { error: error.message });
      return {
        success: false,
        output: null,
        error: {
          code: isAmbiguous ? 'AMBIGUOUS_DISPATCH' : 'EXECUTOR_EXCEPTION',
          message: error.message,
          stack: error.stack,
        },
        ambiguous: isAmbiguous || undefined,
        envelopes: [],
      };
    } finally {
      if (intentEnv) {
        const settledEnv = context.envelopes.event(
          Intents.DISPATCH.SETTLED,
          context.correlationId,
          {
            nodeId: node.id,
            execId: context.id,
            corr: intentEnv.id,
            outcome,
          }
        );
        this.store.append(settledEnv, context.orgId ?? SYSTEM_SCOPE).catch(err => {
          this.dispatchSettledAppendFailures++;
          log.warn(
            `Dispatch-settled append failed for node ${node.id} (${node.type}), accounted, not swallowed`,
            {
              error: err instanceof Error ? err.message : String(err),
              dispatchSettledAppendFailures: this.dispatchSettledAppendFailures,
            }
          );
        });
      }
    }
  }

  /**
   * QUOXTRUST-B3: observability for dispatch-settled append failures, see
   * dispatchExecutor()'s finally block.
   */
  getDispatchSettledAppendFailures(): number {
    return this.dispatchSettledAppendFailures;
  }

  /**
   * QUOXTRUST-B4: the one accounting chokepoint for every durable-envelope
   * append that is deliberately non-blocking (fired after the envelope's
   * underlying event already happened). Increments storeAppendFailures and
   * logs a warning with enough context to find the lost envelope in the
   * run's evidence trail — never a bare `.catch(() => {})`.
   */
  private recordStoreAppendFailure(context: ExecutionContext, envelope: Envelope, err: unknown): void {
    this.storeAppendFailures++;
    log.warn('Store append failed for durable envelope, accounted, not swallowed', {
      orgId: context.orgId ?? SYSTEM_SCOPE,
      executionId: context.id,
      envelopeType: envelope.type,
      envelopeIntent: envelope.intent,
      error: err instanceof Error ? err.message : String(err),
      storeAppendFailures: this.storeAppendFailures,
    });
  }

  /**
   * QUOXTRUST-B4: observability for store-append failures accounted via
   * recordStoreAppendFailure().
   */
  getStoreAppendFailureCount(): number {
    return this.storeAppendFailures;
  }

  /**
   * TRUST-GATE-1.4: Bounded synchronous retry for the onNodeFail 'retry'
   * action. Re-dispatches the node (through the TRUST-GATE-1.3 wrapped
   * dispatch, so a thrown exception on a retry attempt is retried too)
   * up to `maxAttempts` times total (including the attempt that already
   * failed before this was called), with an optional delay between
   * attempts. `maxAttempts`/`delayMs` are hard-capped regardless of what
   * the hook requests, so a misbehaving hook can't wedge a run.
   */
  private async retryNode(
    executor: NodeExecutor,
    node: Node,
    nodeId: string,
    originalInput: unknown,
    context: ExecutionContext,
    envelopes: Envelope[],
    failAction: { retryInput?: unknown; maxAttempts?: number; delayMs?: number }
  ): Promise<ExecutorResult> {
    const HARD_CAP_MAX_ATTEMPTS = 10;
    const HARD_CAP_DELAY_MS = 60000;
    const maxAttempts = Math.min(Math.max(1, failAction.maxAttempts ?? 3), HARD_CAP_MAX_ATTEMPTS);
    const delayMs = Math.min(Math.max(0, failAction.delayMs ?? 0), HARD_CAP_DELAY_MS);
    const retryInput = failAction.retryInput ?? originalInput;

    let result: ExecutorResult = {
      success: false,
      output: null,
      error: { code: 'NODE_FAILED', message: `Node ${nodeId} failed` },
      envelopes: [],
    };

    for (let attempt = 2; attempt <= maxAttempts; attempt++) {
      if (delayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      }

      log.warn(`Retrying node ${nodeId} (${node.type}) — attempt ${attempt}/${maxAttempts}`);

      context.startNode(nodeId, retryInput);
      const startEnvs = context.getEnvelopes();
      envelopes.push(startEnvs[startEnvs.length - 1]);

      result = await this.dispatchExecutor(executor, node, retryInput, context);
      for (const env of result.envelopes) {
        envelopes.push(env);
        this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
      }

      if (result.success) {
        return result;
      }

      context.failNode(nodeId, result.error ?? { code: 'NODE_FAILED', message: `Node ${nodeId} failed` });

      if (attempt === maxAttempts) {
        log.error(`Node ${nodeId} (${node.type}) exhausted retries after ${maxAttempts} attempts`);
      }
    }

    return result;
  }

  private async emitPerNodeVerify(
    context: ExecutionContext,
    envelopes: Envelope[],
    workflow: Workflow,
    node: Node,
    nodeId: string,
    output: unknown,
  ): Promise<void> {
    const checks = ['output_exists', 'no_error_marker'];
    const issues: string[] = [];

    if (output === undefined || output === null) {
      issues.push('Node produced no output');
    }
    if (output && typeof output === 'object' && 'error' in (output as object)) {
      const errObj = (output as Record<string, unknown>).error;
      if (errObj && typeof errObj === 'object') {
        issues.push('Output contains error object');
      }
    }

    const passed = issues.length === 0;
    const env = context.envelopes.event(
      passed ? Intents.AOCL.VERIFY_PASSED : Intents.AOCL.VERIFY_FAILED,
      context.correlationId,
      {
        executionId: context.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        nodeId,
        nodeName: node.name ?? nodeId,
        nodeType: node.type,
        checks,
        issues: passed ? undefined : issues,
      }
    );
    envelopes.push(env);
    this.store.append(env, context.orgId ?? SYSTEM_SCOPE).catch(err => this.recordStoreAppendFailure(context, env, err));
  }
}

// Default layer implementations (pass-through for MVP)

class DefaultIngressLayer implements IngressLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const env = context.envelopes.event(
      Intents.AOCL.INGRESS_RECEIVED,
      context.correlationId,
      { accepted: true }
    );
    return { proceed: true, data, envelopes: [env] };
  }
}

class DefaultIdentityLayer implements IdentityLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const env = context.envelopes.event(
      Intents.AOCL.IDENTITY_VERIFIED,
      context.correlationId,
      { identity: 'anonymous', verified: true }
    );
    return { proceed: true, data, envelopes: [env] };
  }
}

class DefaultPolicyLayer implements PolicyLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const env = context.envelopes.event(
      Intents.AOCL.POLICY_EVALUATED,
      context.correlationId,
      { policies: [], allPassed: true }
    );
    return { proceed: true, data, envelopes: [env] };
  }
}

class DefaultContextLayer implements ContextLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const env = context.envelopes.event(
      Intents.AOCL.CONTEXT_RETRIEVED,
      context.correlationId,
      { variables: Object.keys(context.getVariables()) }
    );
    return { proceed: true, data, envelopes: [env] };
  }
}

class DefaultVerifyLayer implements VerifyLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const factory = context.envelopes;
    const issues: string[] = [];

    // Check output exists
    if (data === undefined || data === null) {
      issues.push('Workflow produced no output');
    }

    // Check for unhandled error markers in output
    if (data && typeof data === 'object' && 'error' in (data as object)) {
      const errObj = data as Record<string, unknown>;
      if (errObj.error && typeof errObj.error === 'object') {
        issues.push('Output contains error object');
      }
    }

    const verified = issues.length === 0;
    const env = factory.event(
      verified ? Intents.AOCL.VERIFY_PASSED : Intents.AOCL.VERIFY_FAILED,
      context.correlationId,
      { verified, issues: verified ? undefined : issues }
    );

    // proceed: true always — verify layer RECORDS problems for audit,
    // it doesn't block execution. Blocking is the policy layer's job.
    return {
      proceed: true,
      data,
      envelopes: [env],
      metadata: verified ? undefined : { verifyIssues: issues },
    };
  }
}

class DefaultAssembleLayer implements AssembleLayer {
  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const env = context.envelopes.event(
      Intents.AOCL.ASSEMBLE_COMPLETE,
      context.correlationId,
      { assembled: true }
    );
    return { proceed: true, data, envelopes: [env] };
  }
}
