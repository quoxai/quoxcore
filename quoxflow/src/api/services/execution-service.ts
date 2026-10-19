/**
 * Execution Service
 *
 * Orchestrates workflow execution and tracks results.
 * Supports pause (approval gates) and resume.
 */

import { ulid } from 'ulid';
import { Workflow, WorkflowSettings } from '../../core/workflow.js';
import { ControlPipeline, PipelineResult, PauseState, BudgetScopeContext } from '../../pipeline/control-pipeline.js';
import { ApiError, ErrorCodes } from '../middleware/error-handler.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { ExecutionStore, StoredExecution, ExecutionStatus } from '../stores/execution-store.js';
import { SYSTEM_SCOPE } from '../middleware/org-scope.js';
import { EventBus } from '../../events/event-bus.js';
import { LifecycleHooks } from '../../pipeline/lifecycle-hooks.js';
import { createDurableHooks } from '../../pipeline/durable-hooks.js';
import { ObservationStore } from '../../store/observation-store.js';
import { ExecutionHistoryStore } from '../../store/execution-history-store.js';
import { SkillLibraryStore } from '../../store/skill-library-store.js';
import { EvidenceStore } from '../../evidence/index.js';
import { BudgetEvaluator } from '../../budget/budget-evaluator.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import { ApprovalEngine, type ApproverPrincipal } from '../../approval/approval-engine.js';
import type { SkillFirewall } from '../../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../../store/skill-firewall-log-store.js';
import type { ReplayOnlyResolveParams } from '../../store/replay-only-flags-store.js';
import { actorToString, actorFromString, type RunActor } from '../../core/execution.js';
import type { LineageAnalyzerLlmClient } from '../../pipeline/lineage-analyzer.js';

export interface ExecutionOptions {
  correlationId?: string;
  triggeredBy?: string;
  /**
   * FND_01M55X6TRMDS63SDZK3TDS63SD: the run's real initiator, decided by the entry point (never by
   * workflow content). When given it is persisted as triggered_by (actorToString) and carried into the
   * pipeline; it overrides any `triggeredBy` passed alongside.
   */
  actor?: RunActor;
  metadata?: Record<string, unknown>;
  /** P8.F HITL-ORGID-PLUMB: first-class org identity for this execution */
  orgId?: string;
  /** AEE-FULL Gap 4: allow pre-seeded executionId for registry timing-race fix */
  executionId?: string;
  /**
   * MACHINERY: respondToWebhook sync-hold. Invoked from `executeAsync`'s
   * background callback when the execution reaches a terminal FAILED state
   * before any respondToWebhook node had a chance to resolve the response
   * channel. Lets the webhook route settle a held-open request with a 500
   * instead of leaving it to time out. Not invoked on success/paused/
   * cancelled — a completed-without-responding workflow falls through to
   * the response channel's own timeout (→ 202) by design.
   */
  onExecutionFailed?: (error: { code: string; message: string }) => void;
  /**
   * STABILITY-AUDITS Fix 2: hop count carried through an event-triggered
   * dispatch chain. Absent (treated as 0) for manual/API/schedule/webhook
   * triggered runs — only trigger-bootstrap's trigger:event dispatch sets
   * this, incrementing the count it read off the originating execution's
   * own stored metadata. Persisted onto this run's execution row metadata
   * (see executionMeta below) so the next hop can read it back the same way.
   */
  eventHopCount?: number;
  /**
   * STABILITY-AUDITS Fix 3: best-effort hook invoked once this run's
   * background execution has truly settled (success, failure, pause, or
   * cancellation) — NOT when the executeAsync()/execute() promise resolves,
   * which for executeAsync() happens as soon as the row is created, long
   * before the pipeline actually finishes. The cron overlap guard uses this
   * to know when it's safe to admit the next tick of the same schedule.
   */
  onSettled?: () => void;
}

export interface ExecutionResult extends PipelineResult {
  stored: StoredExecution;
}

/**
 * STABILITY-AUDITS Fix 1: per-workflow concurrency cap applied when
 * WorkflowSettings.maxConcurrency is unset or non-positive.
 */
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * QUOXTRUST F12 (engagement c4): hard upper ceiling on per-workflow concurrency.
 * The admission guard exists to bound simultaneous in-flight executions of one
 * workflow (trigger storms); without a ceiling a workflow author could set
 * maxConcurrency arbitrarily high and defeat it (T10 bounded resource
 * consumption). 100 simultaneous runs of a single workflow is already extreme;
 * this mirrors loop.executor's HARD_MAX_ITERATIONS ceiling — an author may lower
 * the cap but never raise it past the hard ceiling.
 */
export const HARD_MAX_CONCURRENCY = 100;

/**
 * STABILITY-AUDITS Fix 1: resolve the effective per-workflow concurrency cap
 * from WorkflowSettings.maxConcurrency. Exported for direct unit testing.
 * QUOXTRUST F12: clamped to [1, HARD_MAX_CONCURRENCY].
 */
export function resolveWorkflowMaxConcurrency(settings?: WorkflowSettings): number {
  const requested = settings?.maxConcurrency;
  const base = typeof requested === 'number' && requested > 0 ? requested : DEFAULT_MAX_CONCURRENCY;
  return Math.min(base, HARD_MAX_CONCURRENCY);
}

export class ExecutionService {
  private pipeline: ControlPipeline;
  /** AEE-FULL Gap 4: in-process AbortController registry for cancellation */
  // LAUNCH-SPINE: `actorId` is attached by cancel() when the request arrives,
  // not at registration time — the entry exists long before anyone cancels.
  private cancellationMap: Map<string, { ac: AbortController; status: 'starting' | 'running'; cancelled: boolean; actorId?: string }> = new Map();
  /**
   * STABILITY-AUDITS Fix 1: count of runs currently admitted per workflow —
   * incremented synchronously at admission (before any DB row is created),
   * decremented once the run's background execution truly settles. Guards
   * against a trigger storm (misfiring schedule, event recursion, retried
   * webhooks) spawning unbounded simultaneous executions of one workflow.
   */
  private inFlightByWorkflow: Map<string, number> = new Map();

  /**
   * STABILITY-AUDITS Fix 1: admit a new run of `workflow`, or throw
   * ApiError(MAX_CONCURRENCY_EXCEEDED) if it would exceed
   * WorkflowSettings.maxConcurrency. Called synchronously before any state
   * (execution row, cancellation-map entry) is created, so a rejected run
   * leaves nothing behind to clean up.
   */
  private acquireSlot(workflow: Workflow): void {
    const cap = resolveWorkflowMaxConcurrency(workflow.settings);
    const current = this.inFlightByWorkflow.get(workflow.id) ?? 0;
    if (current >= cap) {
      throw new ApiError(
        ErrorCodes.MAX_CONCURRENCY_EXCEEDED,
        `Workflow ${workflow.id} has reached its concurrency limit (${cap} concurrent run(s))`,
        429
      );
    }
    this.inFlightByWorkflow.set(workflow.id, current + 1);
  }

  /** STABILITY-AUDITS Fix 1: release a slot acquired by acquireSlot(). */
  private releaseSlot(workflowId: string): void {
    const current = this.inFlightByWorkflow.get(workflowId) ?? 0;
    if (current <= 1) this.inFlightByWorkflow.delete(workflowId);
    else this.inFlightByWorkflow.set(workflowId, current - 1);
  }

  constructor(
    private config: {
      store: EnvelopeStore;
      executors: ExecutorRegistry;
      executionStore: ExecutionStore;
      eventBus?: EventBus;
      // STUDY-REV W2 + AOCL wire (Sprint 1 SC#3): when these stores are
      // supplied, the pipeline runs with durable observation + AOCL
      // evidence + Crystalliser auto-promotion. All four optional —
      // the constructor builds the hooks block only if at least the
      // mandatory three (observation + history + skill) are present;
      // evidenceStore is the SC#3 audit-chain channel and can be added
      // independently. orgId defaults to 'default' for single-tenant
      // deployments; multi-tenant callers must override.
      observationStore?: ObservationStore;
      executionHistoryStore?: ExecutionHistoryStore;
      skillLibraryStore?: SkillLibraryStore;
      evidenceStore?: EvidenceStore;
      orgId?: string;
      // P8.B: budget gate — forwarded to ControlPipeline so the pre-exec check fires
      budgetEvaluator?: BudgetEvaluator;
      budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
      // P8.C: policy gate — forwarded to ControlPipeline so per-node policy checks fire
      policyEvaluator?: PolicyEvaluator;
      // REPLAY-ONLY .A-1a: forwarded to ControlPipeline so context.effectiveReplayOnly
      // is actually resolved at run start instead of defaulting to false.
      replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
      approvalEngine?: ApprovalEngine;
      // MACHINERY: task-time crystal promotion sweep — same firewall gate as the
      // Skill write path, forwarded so durable-hooks' run-completion sweep can
      // scan Crystals before promoting them.
      skillFirewall?: SkillFirewall;
      skillFirewallLogStore?: SkillFirewallLogStore;
      crystalPromotionThreshold?: { confidence: number; consecutive_success: number };
      crystalTasktimePromotionEnabled?: boolean;
      /** MEM-DECAY MD.3: lineage graph — forwarded to durable-hooks.ts. Optional;
       * absent means parent pointers are still recorded but no failure lesson
       * is ever generated. */
      lineageLlmClient?: LineageAnalyzerLlmClient;
    }
  ) {
    let hooks: LifecycleHooks | undefined;
    if (config.observationStore && config.executionHistoryStore && config.skillLibraryStore) {
      hooks = createDurableHooks({
        observationStore: config.observationStore,
        executionHistoryStore: config.executionHistoryStore,
        skillLibraryStore: config.skillLibraryStore,
        evidenceStore: config.evidenceStore,
        orgId: config.orgId || 'default',
        skillFirewall: config.skillFirewall,
        skillFirewallLogStore: config.skillFirewallLogStore,
        crystalPromotionThreshold: config.crystalPromotionThreshold,
        crystalTasktimePromotionEnabled: config.crystalTasktimePromotionEnabled,
        lineageLlmClient: config.lineageLlmClient,
      });
    }
    this.pipeline = new ControlPipeline({
      store: config.store,
      executors: config.executors,
      eventBus: config.eventBus,
      hooks,
      // P8.B + P8.C: wire evaluators so the pipeline guards actually fire in production
      budgetEvaluator: config.budgetEvaluator,
      budgetScopeResolver: config.budgetScopeResolver,
      policyEvaluator: config.policyEvaluator,
      // REPLAY-ONLY .A-1a: wire the resolver so context.effectiveReplayOnly fires in production
      replayOnlyResolver: config.replayOnlyResolver,
      approvalEngine: config.approvalEngine,
    });
  }

  async execute(
    workflow: Workflow,
    triggerData: unknown,
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    // STABILITY-AUDITS Fix 1: admission control BEFORE any state is created —
    // a rejected run leaves no execution row or cancellation-map entry
    // behind. Throws ApiError(MAX_CONCURRENCY_EXCEEDED) synchronously.
    this.acquireSlot(workflow);
    try {
      return await this.executeAdmitted(workflow, triggerData, options);
    } finally {
      this.releaseSlot(workflow.id);
      try { options.onSettled?.(); } catch { /* best-effort */ }
    }
  }

  private async executeAdmitted(
    workflow: Workflow,
    triggerData: unknown,
    options: ExecutionOptions
  ): Promise<ExecutionResult> {
    // AEE-FULL P0.C: Generate execId up-front so the row's correlation_id matches
    // the engine's wf-corr from the start (ExecutionContext line 57).
    // The HTTP request id (options.correlationId) is preserved in metadata.requestCorrelationId.
    const execId = options.executionId || ulid();
    const ac = new AbortController();
    this.cancellationMap.set(execId, { ac, status: 'starting', cancelled: false });
    const correlationId = `wf-${workflow.id}-${execId.slice(-8)}`;
    const executionMeta = {
      ...(options.metadata || {}),
      ...(options.orgId ? { orgId: options.orgId } : {}),
      ...(options.correlationId ? { requestCorrelationId: options.correlationId } : {}),
      // STABILITY-AUDITS Fix 2: persisted so a downstream trigger:event
      // dispatch can read this run's hop count back off its own row.
      ...(typeof options.eventHopCount === 'number' ? { eventHopCount: options.eventHopCount } : {}),
    };
    const execution = await this.config.executionStore.create({
      id: execId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      correlationId,
      status: 'running',
      triggerData,
      startedAt: new Date().toISOString(),
      triggeredBy: options.actor ? actorToString(options.actor) : options.triggeredBy,
      metadata: executionMeta,
    }, options.orgId ?? SYSTEM_SCOPE); // QF-MT WP5: the run's org — see ExecutionOptions.orgId.

    const entry = this.cancellationMap.get(execId);
    if (entry) entry.status = 'running';

    try {
      // Execute workflow — pass the pre-generated execId so ExecutionContext computes
      // the same wf-corr form (wf-${workflowId}-${execId.slice(-8)}).
      // AEE-FULL Gap 4 — thread the registry AbortSignal into the pipeline so
      // ExecutionContext can propagate cancel to in-flight fetches.
      const result = await this.pipeline.execute(workflow, triggerData, {
        executionId: execution.id,
        orgId: options.orgId,
        actor: options.actor,
        cancellationSignal: ac.signal,
        cancellationActorProvider: () => this.cancellationMap.get(execId)?.actorId,
      });

      // Handle pause (approval gate)
      if (result.paused && result.pauseState) {
        const stored = await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
          status: 'paused',
          output: result.output,
          envelopeCount: result.envelopes.length,
          metadata: {
            ...executionMeta,
            pauseState: result.pauseState,
          },
        });
        this.cancellationMap.delete(execId);
        return { ...result, stored };
      }

      // AEE-FULL Gap 4: handle cancellation result from pipeline.
      // quoxflow#13: a cancel that aborted a node mid-flight (util:wait throws WAIT_ABORTED) comes back as a
      // plain failure, not result.cancelled; the abort signal is the truth, so it still ends 'cancelled'.
      if (result.cancelled || ac.signal.aborted) {
        result.cancelled = true;
        // Row may already be updated by cancel() — only update if not already cancelled
        const current = await this.config.executionStore.get(execution.id, SYSTEM_SCOPE);
        let stored: StoredExecution;
        if (current?.status !== 'cancelled') {
          stored = await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
            status: 'cancelled',
            completedAt: new Date().toISOString(),
            duration: result.duration,
            envelopeCount: result.envelopes.length,
          });
        } else {
          stored = current;
        }
        this.cancellationMap.delete(execId);
        return { ...result, stored };
      }

      // Update execution record with results — correlationId already correct, no rewrite needed
      const stored = await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error,
        completedAt: new Date().toISOString(),
        duration: result.duration,
        envelopeCount: result.envelopes.length,
      });

      this.cancellationMap.delete(execId);
      return { ...result, stored };
    } catch (error) {
      // Update execution as failed
      await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
        status: 'failed',
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date().toISOString(),
      });

      this.cancellationMap.delete(execId);
      // Re-throw to be handled by error middleware
      throw error;
    }
  }

  /**
   * Resume a paused execution after approval decision.
   */
  async resume(
    executionId: string,
    workflow: Workflow,
    decision: { approved: boolean; approver: string; reason?: string; requestChanges?: boolean; data?: Record<string, unknown> },
    /** quoxflow#14: the verified caller, for org role groups; undefined for service and no-auth callers. */
    principal?: ApproverPrincipal,
    /** quox#1037: async answers once every check has passed and the run is marked running; the post-gate part
     * continues in the background (same cancel registration and terminal writes as a synchronous resume). */
    options: { async?: boolean } = {}
  ): Promise<ExecutionResult> {
    const execution = await this.config.executionStore.get(executionId, SYSTEM_SCOPE);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }
    if (execution.status !== 'paused') {
      throw new Error(`Execution ${executionId} is not paused (status: ${execution.status})`);
    }

    const pauseState = (execution.metadata as Record<string, unknown>)?.pauseState as PauseState | undefined;
    if (!pauseState) {
      throw new Error(`Execution ${executionId} has no pause state`);
    }

    // FND_01M55X6TRMDS63SDZK3TDS63SD: a resumed run keeps its REAL initiator, rebuilt from the persisted
    // triggered_by. A row that does not parse (pre-change rows: null or a legacy string) is refused,
    // never given a made-up actor; such a run needs a fresh run / re-approval.
    const actor = actorFromString(execution.triggeredBy);
    if (!actor) {
      throw new Error(
        `Execution ${executionId} cannot resume: it has no recorded initiator (triggered_by=${JSON.stringify(execution.triggeredBy ?? null)}). ` +
        `Runs started before initiator tracking must be re-run and re-approved.`
      );
    }

    // Blocker 5 (stale-grants): a paused execution must not resume once its
    // approval is no longer actionable. Deactivating a workflow (or an expiry
    // sweep) cancels or expires the approval but leaves the execution 'paused';
    // without this check a stale resume would still run the workflow on a
    // cancelled, expired or denied approval. Refuse when the linked approval has
    // reached a terminal-negative state, and leave the execution paused so the
    // decision is not silently lost.
    if (pauseState.approvalId && this.config.approvalEngine) {
      const approval = await this.config.approvalEngine.get(pauseState.approvalId, SYSTEM_SCOPE);
      if (approval && ['cancelled', 'expired', 'denied'].includes(approval.status)) {
        throw new Error(
          `Execution ${executionId} cannot resume: approval ${pauseState.approvalId} is ${approval.status}`
        );
      }

      // SEC-FIX (mirrors approvals.ts isAuthorizedApprover check, SEC-FIX-1's
      // sibling): the route's identity bind only proves the caller IS who
      // they claim to be — it does not prove that person is allowed to
      // resolve THIS approval. Reuse the one authority function so a JWT
      // holder who names themselves as approver still can't resume a gate
      // they were never listed on.
      if (approval && !this.config.approvalEngine.isAuthorizedApprover(approval, decision.approver, principal)) {
        return {
          success: false,
          output: execution.output,
          error: {
            code: 'APPROVER_NOT_AUTHORIZED',
            message: `Approver ${decision.approver} is not authorized to resume execution ${executionId}`,
          },
          executionId,
          correlationId: execution.correlationId,
          envelopes: [],
          duration: execution.duration ?? 0,
          stored: execution,
        };
      }
    }

    // Mark as running again
    const running = await this.config.executionStore.update(executionId, SYSTEM_SCOPE, { status: 'running' });

    // quoxflow#14: a resumed run registers in the cancellation map like a fresh one, so
    // POST /api/executions/:id/cancel can actually stop it (it used to only write the row).
    const ac = new AbortController();
    this.cancellationMap.set(executionId, { ac, status: 'running', cancelled: false });

    const remainder = this.continueResume(executionId, execution, workflow, pauseState, decision, ac, actor);
    if (!options.async) return remainder;
    // quox#1037: the remainder's own catch already records a failure on the row; this only stops an unhandled rejection.
    remainder.catch(err => console.error(`[resume] background remainder of ${executionId} failed:`, err instanceof Error ? err.message : err));
    return {
      success: true,
      output: execution.output,
      executionId,
      correlationId: execution.correlationId,
      envelopes: [],
      duration: execution.duration ?? 0,
      stored: running ?? execution,
    } as ExecutionResult;
  }

  /** quox#1037: the post-gate part of a resume, after every check passed (see resume()). */
  private async continueResume(
    executionId: string,
    execution: StoredExecution,
    workflow: Workflow,
    pauseState: PauseState,
    decision: { approved: boolean; approver: string; reason?: string; requestChanges?: boolean; data?: Record<string, unknown> },
    ac: AbortController,
    actor: RunActor,
  ): Promise<ExecutionResult> {
    try {
      // quox#513: thread the ORIGINAL execution's id/orgId through so resume's
      // envelopes (decision + terminal) land under the same corr/org as the
      // rest of the run, instead of a freshly-minted, disconnected one.
      const result = await this.pipeline.resume(workflow, pauseState, decision, {
        executionId,
        orgId: execution.orgId,
        actor,
        cancellationSignal: ac.signal,
        cancellationActorProvider: () => this.cancellationMap.get(executionId)?.actorId,
      });

      // quoxflow#14: cancelled during the resumed part (also when a node failed BECAUSE it was aborted):
      // keep the 'cancelled' row cancel() wrote, never overwrite it with completed/failed.
      if (result.cancelled || ac.signal.aborted) {
        this.cancellationMap.delete(executionId);
        const current = await this.config.executionStore.get(executionId, SYSTEM_SCOPE);
        const stored = current?.status === 'cancelled' ? current : await this.config.executionStore.update(executionId, SYSTEM_SCOPE, {
          status: 'cancelled', completedAt: new Date().toISOString(),
        });
        return { ...result, cancelled: true, stored };
      }

      // Handle nested pause
      if (result.paused && result.pauseState) {
        const stored = await this.config.executionStore.update(executionId, SYSTEM_SCOPE, {
          status: 'paused',
          output: result.output,
          envelopeCount: (execution.envelopeCount ?? 0) + result.envelopes.length,
          metadata: {
            ...(execution.metadata as Record<string, unknown>),
            pauseState: result.pauseState,
          },
        });
        this.cancellationMap.delete(executionId);
        return { ...result, stored };
      }

      this.cancellationMap.delete(executionId);
      const stored = await this.config.executionStore.update(executionId, SYSTEM_SCOPE, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error,
        completedAt: new Date().toISOString(),
        duration: (execution.duration ?? 0) + result.duration,
        envelopeCount: (execution.envelopeCount ?? 0) + result.envelopes.length,
      });

      return { ...result, stored };
    } catch (error) {
      this.cancellationMap.delete(executionId);
      if (ac.signal.aborted) throw error; // quoxflow#14: cancel() already wrote 'cancelled'; do not stamp failed over it
      await this.config.executionStore.update(executionId, SYSTEM_SCOPE, {
        status: 'failed',
        error: {
          code: 'RESUME_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async executeAsync(
    workflow: Workflow,
    triggerData: unknown,
    options: ExecutionOptions = {}
  ): Promise<string> {
    // STABILITY-AUDITS Fix 1: admission control BEFORE any state is created,
    // and synchronously — a caller awaiting executeAsync() sees the rejection
    // immediately rather than having it silently swallowed inside the
    // background setImmediate task. If this throws, the background task
    // below is never scheduled, so there is nothing to release.
    this.acquireSlot(workflow);

    // AEE-FULL P0.C: Generate execId up-front so the row's correlation_id matches
    // the engine's wf-corr from the start.
    const execId = options.executionId || ulid();
    const ac = new AbortController();
    // AEE-FULL Gap 4 SD-6: register in map BEFORE setImmediate so cancel() arriving
    // before the async callback fires sees the entry and can set the cancelled flag.
    this.cancellationMap.set(execId, { ac, status: 'starting', cancelled: false });

    const correlationId = `wf-${workflow.id}-${execId.slice(-8)}`;
    const executionMeta = {
      ...(options.metadata || {}),
      ...(options.orgId ? { orgId: options.orgId } : {}),
      ...(options.correlationId ? { requestCorrelationId: options.correlationId } : {}),
      // STABILITY-AUDITS Fix 2: persisted so a downstream trigger:event
      // dispatch can read this run's hop count back off its own row.
      ...(typeof options.eventHopCount === 'number' ? { eventHopCount: options.eventHopCount } : {}),
    };
    const execution = await this.config.executionStore.create({
      id: execId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      correlationId,
      status: 'running',
      triggerData,
      startedAt: new Date().toISOString(),
      triggeredBy: options.actor ? actorToString(options.actor) : options.triggeredBy,
      metadata: executionMeta,
    }, options.orgId ?? SYSTEM_SCOPE); // QF-MT WP5: the run's org — see ExecutionOptions.orgId.

    // Execute in background (fire and forget)
    setImmediate(async () => {
      // STABILITY-AUDITS Fix 1 / Fix 3: release the concurrency slot and
      // fire onSettled() no matter which branch below returns — including
      // the early cancelled-before-start return, which is why this wraps
      // the WHOLE callback rather than just the inner try/catch.
      try {
        const mapEntry = this.cancellationMap.get(execId);
        if (mapEntry?.cancelled) {
          // Cancel arrived during 'starting' — skip pipeline entirely.
          // The cancel() method has already updated the DB row.
          this.cancellationMap.delete(execId);
          return;
        }
        if (mapEntry) mapEntry.status = 'running';

        try {
          // AEE-FULL Gap 4 — thread the registry AbortSignal so cancel propagates
          // to in-flight fetches via ExecutionContext.cancellationSignal.
          const result = await this.pipeline.execute(workflow, triggerData, {
            executionId: execution.id,
            orgId: options.orgId,
            actor: options.actor,
            cancellationSignal: ac.signal,
            cancellationActorProvider: () => this.cancellationMap.get(execId)?.actorId,
          });

          if (result.paused && result.pauseState) {
            await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
              status: 'paused',
              output: result.output,
              envelopeCount: result.envelopes.length,
              metadata: {
                ...executionMeta,
                pauseState: result.pauseState,
              },
            });
            this.cancellationMap.delete(execId);
            return;
          }

          // AEE-FULL Gap 4: handle cancelled result
          if (result.cancelled) {
            const current = await this.config.executionStore.get(execution.id, SYSTEM_SCOPE);
            if (current?.status !== 'cancelled') {
              await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
                status: 'cancelled',
                completedAt: new Date().toISOString(),
                duration: result.duration,
                envelopeCount: result.envelopes.length,
              });
            }
            this.cancellationMap.delete(execId);
            return;
          }

          // correlationId already correct at row creation; no rewrite needed
          await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
            status: result.success ? 'completed' : 'failed',
            output: result.output,
            error: result.error,
            completedAt: new Date().toISOString(),
            duration: result.duration,
            envelopeCount: result.envelopes.length,
          });
          this.cancellationMap.delete(execId);
          if (!result.success) {
            options.onExecutionFailed?.(
              result.error || { code: 'EXECUTION_ERROR', message: 'Workflow failed' }
            );
          }
        } catch (error) {
          const failure = {
            code: 'EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          };
          await this.config.executionStore.update(execution.id, SYSTEM_SCOPE, {
            status: 'failed',
            error: failure,
            completedAt: new Date().toISOString(),
          });
          this.cancellationMap.delete(execId);
          options.onExecutionFailed?.(failure);
        }
      } finally {
        this.releaseSlot(workflow.id);
        try { options.onSettled?.(); } catch { /* best-effort */ }
      }
    });

    return execution.id;
  }

  /**
   * AEE-FULL Gap 4: Cancel a running or starting execution.
   * Per SD-2: cancelledBy is always 'user' on the HTTP path.
   * Per SD-6: in-process registry handles timing-race between executeAsync and cancel.
   */
  async cancel(
    executionId: string,
    reason: string,
    cancelledBy: 'user' | 'system' | 'timeout' = 'user',
    actorId?: string
  ): Promise<
    | { ok: true; execution: StoredExecution }
    | { ok: false; reason: 'not_found' | 'already_terminal'; currentStatus?: ExecutionStatus }
  > {
    const existing = await this.config.executionStore.get(executionId, SYSTEM_SCOPE);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
      return { ok: false, reason: 'already_terminal', currentStatus: existing.status };
    }

    const entry = this.cancellationMap.get(executionId);
    if (entry) {
      entry.cancelled = true;
      // LAUNCH-SPINE: attach the actor BEFORE aborting. The abort listener in
      // ExecutionContext reads it synchronously via the provider, so setting it
      // afterwards would emit an envelope with actor_id still undefined.
      entry.actorId = actorId;
      entry.ac.abort(reason);
    }

    const cancelledAt = new Date().toISOString();
    const updated = await this.config.executionStore.update(executionId, SYSTEM_SCOPE, {
      status: 'cancelled',
      cancelledAt,
      cancelledBy,
      cancellationReason: reason || undefined,
      completedAt: cancelledAt,
    });

    return { ok: true, execution: updated };
  }
}
