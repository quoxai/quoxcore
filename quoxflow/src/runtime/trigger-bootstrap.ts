/**
 * Trigger Bootstrap
 *
 * Loads active workflows at server startup and registers their triggers:
 * - trigger:schedule → registers cron jobs via ScheduleExecutor
 * - trigger:event → subscribes to EventBus patterns
 * - trigger:webhook → returns webhook paths for route registration
 *
 * Each workflow is independently try/caught — a bad workflow doesn't
 * stop the others from being registered.
 */

import { ulid } from 'ulid';
import { Workflow, Node } from '../core/workflow.js';
import { WorkflowStore, StoredWorkflow, WorkflowOrgScope } from '../api/stores/workflow-store.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';
import { ExecutionStore } from '../api/stores/execution-store.js';
import { EnvelopeStore } from '../store/envelope-store.js';
import { ExecutorRegistry } from '../executors/executor.interface.js';
import { ScheduleExecutor } from '../executors/schedule.executor.js';
import { EventBus } from '../events/event-bus.js';
import { ExecutionService } from '../api/services/execution-service.js';
import { ObservationStore } from '../store/observation-store.js';
import { ExecutionHistoryStore } from '../store/execution-history-store.js';
import { SkillLibraryStore } from '../store/skill-library-store.js';
import { EvidenceStore } from '../evidence/index.js';
import { BudgetEvaluator } from '../budget/budget-evaluator.js';
import { BudgetScopeContext } from '../pipeline/control-pipeline.js';
import { PolicyEvaluator } from '../policy/evaluator.js';
import { ApprovalEngine } from '../approval/approval-engine.js';
import type { ApprovalStore } from '../approval/types.js';
import type { ReplayOnlyResolveParams } from '../store/replay-only-flags-store.js';
import type { LineageAnalyzerLlmClient } from '../pipeline/lineage-analyzer.js';
import { logger } from '../logger.js';

const bootLog = logger.for('Bootstrap');
const scheduleLog = logger.for('Schedule');
const eventLog = logger.for('Event');
const deactivateLog = logger.for('deactivateWorkflow');

interface BootstrapDeps {
  workflowStore: WorkflowStore;
  executionStore: ExecutionStore;
  envelopeStore: EnvelopeStore;
  scheduleExecutor: ScheduleExecutor;
  eventBus: EventBus;
  executors: ExecutorRegistry;
  // STUDY-REV W2 + AOCL wire (Sprint 1 SC#3): forward to ExecutionService
  // so schedule + event triggered workflows get the same durable hooks
  // the API-triggered runs do.
  observationStore?: ObservationStore;
  executionHistoryStore?: ExecutionHistoryStore;
  skillLibraryStore?: SkillLibraryStore;
  evidenceStore?: EvidenceStore;
  orgId?: string;
  // R3.crit-2: budget + policy gates must fire for schedule/event/webhook triggers too.
  budgetEvaluator?: BudgetEvaluator;
  budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  policyEvaluator?: PolicyEvaluator;
  // REPLAY-ONLY .A-1a: forwarded into ExecutionService so schedule/event/
  // webhook triggered runs also resolve context.effectiveReplayOnly.
  replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  approvalEngine?: ApprovalEngine;
  /** MEM-DECAY MD.3: lineage graph — forwarded into ExecutionService ->
   * durable-hooks.ts for schedule/event/webhook triggered runs too. */
  lineageLlmClient?: LineageAnalyzerLlmClient;
}

interface WebhookEntry {
  path: string;
  method: string;
  workflowId: string;
  nodeId: string;
  // QF-MT WP4: owning org, resolved from the workflow row (stored.orgId ??
  // stored.metadata.orgId ?? deps.orgId). Threaded into WebhookRegistry.register()
  // by the caller (server.ts / workflows-lifecycle.ts) so the registry can
  // filter listings by scope and reject cross-org path collisions.
  orgId: string;
}

/**
 * QF-MT WP4: resolve the org that owns a stored workflow, for stamping
 * trigger registrations (webhook/schedule/event). Post-WP3 `stored.orgId`
 * is the authoritative column; `metadata.orgId` and `deps.orgId` are
 * fallbacks for older in-memory fixtures / bootstrap-level overrides.
 * 'default' is the last resort — matches ExecutionService's single-tenant
 * default and the legacy-row convention used elsewhere in this stream.
 */
function resolveWorkflowOrgId(stored: StoredWorkflow, deps: BootstrapDeps): string {
  return stored.orgId ?? (stored.metadata?.orgId as string | undefined) ?? deps.orgId ?? 'default';
}

interface BootstrapResult {
  registered: number;
  errors: string[];
  webhooks: WebhookEntry[];
}

/**
 * STUDY-REV Sprint 2 K2 — config-flag for the trigger:schedule bootstrap.
 *
 * In QuoxCORE deployments the Tasks service is the sole scheduler and
 * QuoxFlow must NOT register cron jobs of its own (otherwise the same
 * workflow fires twice). Standalone QuoxFlow users — those running the
 * engine without QuoxCORE — flip this flag and keep their croner.
 *
 * Read fresh on each call so tests can vary the env between cases.
 * Default: off. Anything other than the literal string 'true' is off
 * (fail-closed — explicit opt-in).
 */
export function quoxflowOwnsScheduler(): boolean {
  return process.env.QUOXFLOW_OWN_SCHEDULER === 'true';
}

/**
 * STABILITY-AUDITS Fix 2 — event trigger hop cap.
 *
 * Confirmed defect: nothing tracked hop/depth/origin for a trigger:event
 * dispatch. A workflow's own completion/failure is published back onto the
 * EventBus (ControlPipeline.execute()); if any trigger:event subscription
 * matches that intent (directly, or transitively through another workflow),
 * the resulting run's own completion republishes, forever.
 *
 * Default cap 5, configurable via QUOXFLOW_EVENT_HOP_CAP. Read fresh on each
 * call so tests can vary the env between cases (same pattern as
 * quoxflowOwnsScheduler() above). Any non-positive/non-numeric override
 * falls back to the default rather than disabling the guard.
 */
export function eventHopCap(): number {
  const raw = Number(process.env.QUOXFLOW_EVENT_HOP_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/**
 * Bootstrap all triggers for active workflows.
 * Called once at server startup after stores are initialized.
 */
export async function bootstrapTriggers(deps: BootstrapDeps): Promise<BootstrapResult> {
  const { workflowStore, scheduleExecutor, eventBus } = deps;

  // QF-MT WP3: startup bootstrap legitimately spans every org's active
  // workflows — SYSTEM_SCOPE explicit and loud (never an accidental
  // cross-org read).
  const activeWorkflows = await workflowStore.list(SYSTEM_SCOPE, { active: true });
  const result: BootstrapResult = { registered: 0, errors: [], webhooks: [] };

  const executionService = new ExecutionService({
    store: deps.envelopeStore,
    executors: deps.executors,
    executionStore: deps.executionStore,
    eventBus,
    observationStore: deps.observationStore,
    executionHistoryStore: deps.executionHistoryStore,
    skillLibraryStore: deps.skillLibraryStore,
    evidenceStore: deps.evidenceStore,
    orgId: deps.orgId,
    // R3.crit-2: forward budget + policy evaluators so schedule/event/webhook
    // triggered workflows are subject to the same guards as API-triggered ones.
    budgetEvaluator: deps.budgetEvaluator,
    budgetScopeResolver: deps.budgetScopeResolver,
    policyEvaluator: deps.policyEvaluator,
    // REPLAY-ONLY .A-1a: same wiring for schedule/event triggered runs.
    replayOnlyResolver: deps.replayOnlyResolver,
    approvalEngine: deps.approvalEngine,
    lineageLlmClient: deps.lineageLlmClient,  // MEM-DECAY MD.3
  });

  for (const stored of activeWorkflows) {
    try {
      const triggerResult = registerWorkflowTriggers(
        stored,
        scheduleExecutor,
        eventBus,
        executionService,
        deps
      );

      if (triggerResult.hasTriggers) {
        result.registered++;
        result.webhooks.push(...triggerResult.webhooks);
      }
    } catch (err) {
      const msg = `Error for ${stored.id}: ${err instanceof Error ? err.message : String(err)}`;
      bootLog.error(msg);
      result.errors.push(`[Bootstrap] ${msg}`);
    }
  }

  bootLog.info(`Registered triggers for ${result.registered} workflows (${result.errors.length} errors)`);
  if (result.webhooks.length > 0) {
    bootLog.info(`${result.webhooks.length} webhook paths registered`);
  }

  return result;
}

/**
 * STABILITY-AUDITS Fix 3 — cron overlap guard.
 *
 * Confirmed defect: the cron tick callback called
 * executionService.executeAsync() unconditionally, with no per-schedule
 * in-flight guard. A slow workflow on a fast cron (or a workflow that
 * temporarily hangs) piled up overlapping concurrent runs of itself, one per
 * tick, without bound.
 *
 * `inFlight` is a closure-local flag (one per trigger:schedule node — a
 * fresh closure is created each time this function is called), NOT a
 * module-level map: each schedule's own callback is reused across every one
 * of its ticks, so a simple boolean captured in its closure is sufficient
 * and can't collide with another schedule's guard or leak across test runs.
 *
 * `onSettled` fires when the run's BACKGROUND execution truly finishes
 * (success, failure, pause, or cancellation) — not when the executeAsync()
 * promise resolves, which happens as soon as the execution row is created,
 * long before the pipeline actually runs. If executeAsync() itself throws
 * before ever reaching the background task (e.g. admission control in
 * ExecutionService rejects it), onSettled never fires, so the `.catch()`
 * below also releases the flag — the two release paths are mutually
 * exclusive with the promise settling once, so there's no double-release
 * and no leak.
 *
 * Exported for direct unit testing — croner ticks can't be fired
 * deterministically from a unit test.
 */
export function buildScheduleCallback(
  workflow: Workflow,
  node: Node,
  config: { expression: string; timezone?: string; paused?: boolean; label?: string },
  executionService: ExecutionService,
  workflowOrgId: string,
  deps: BootstrapDeps
): () => void {
  const jobKey = `${workflow.id}:${node.id}`;
  let inFlight = false;

  return () => {
    if (inFlight) {
      scheduleLog.warn(`Cron fire SKIPPED (overlap guard): ${jobKey} — previous run still executing`);
      return;
    }
    inFlight = true;

    const firedAt = new Date().toISOString();
    executionService.executeAsync(workflow, {
      trigger: 'schedule',
      firedAt,
      expression: config.expression,
    }, {
      // FND_01M55X6TRMDS63SDZK3TDS63SD: a cron fire runs as a named system actor, never as a user.
      actor: { kind: 'system', id: `schedule:${node.id}` },
      triggeredBy: `system:schedule:${node.id}`,
      orgId: workflowOrgId,
      onSettled: () => { inFlight = false; },
    }).catch(async (err) => {
      // The run never reached the background task (e.g. rejected by
      // admission control) — onSettled above will never fire for it.
      inFlight = false;
      const msg = err instanceof Error ? err.message : String(err);
      scheduleLog.error(`Execution failed for ${workflow.id}`, { error: msg });
      // Record the failure so it's visible in execution history
      try {
        await deps.executionStore.create({
          workflowId: workflow.id,
          workflowName: workflow.name,
          correlationId: `wf-${workflow.id}-fail-${ulid().slice(-8)}`,
          status: 'failed',
          triggerData: { trigger: 'schedule', firedAt, expression: config.expression },
          startedAt: firedAt,
          completedAt: new Date().toISOString(),
          error: { code: 'SCHEDULE_FIRE_ERROR', message: msg },
          triggeredBy: `system:schedule:${node.id}`,
        }, workflowOrgId); // QF-MT WP5: forced by execution-store signature change; workflowOrgId already resolved above.
      } catch (recordErr) {
        scheduleLog.error(`Could not record failure for ${workflow.id}`, {
          error: recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
      }
    });
  };
}

/**
 * Register triggers for a single stored workflow.
 */
function registerWorkflowTriggers(
  stored: StoredWorkflow,
  scheduleExecutor: ScheduleExecutor,
  eventBus: EventBus,
  executionService: ExecutionService,
  deps: BootstrapDeps
): { hasTriggers: boolean; webhooks: WebhookEntry[] } {
  const workflow = stored.definition;
  const triggerNodes = workflow.nodes.filter(n => n.type.startsWith('trigger:'));

  if (triggerNodes.length === 0) {
    return { hasTriggers: false, webhooks: [] };
  }

  const webhooks: WebhookEntry[] = [];
  let registeredAny = false;

  for (const node of triggerNodes) {
    if (node.type === 'trigger:schedule') {
      // STUDY-REV K2: skip schedule registration in QuoxCORE deployments.
      // The Tasks service owns scheduling there; double-registration would
      // fire the workflow twice. Standalone QuoxFlow opts back in via
      // QUOXFLOW_OWN_SCHEDULER=true.
      if (!quoxflowOwnsScheduler()) {
        bootLog.info(`Schedule SKIPPED (QUOXFLOW_OWN_SCHEDULER=off): ${workflow.id}:${node.id}`);
        continue;
      }
      // Handle both 'expression' (executor convention) and 'cron' (TS type convention)
      const rawConfig = node.config as Record<string, unknown>;
      const config = {
        expression: (rawConfig.expression || rawConfig.cron) as string,
        timezone: rawConfig.timezone as string | undefined,
        paused: rawConfig.paused as boolean | undefined,
        label: rawConfig.label as string | undefined,
      };
      // P8.F / QF-MT WP4: resolve orgId from the workflow row at registration time.
      const workflowOrgId = resolveWorkflowOrgId(stored, deps);
      scheduleExecutor.registerSchedule(
        workflow.id,
        node.id,
        config,
        buildScheduleCallback(workflow, node, config, executionService, workflowOrgId, deps),
        workflowOrgId
      );
      bootLog.info(`Schedule: ${workflow.id}:${node.id} — ${config.expression}`);
      registeredAny = true;
    } else if (node.type === 'trigger:event') {
      // Handle both 'pattern' (executor convention) and 'event' (TS type convention)
      const rawEvtConfig = node.config as Record<string, unknown>;
      const config = { pattern: (rawEvtConfig.pattern || rawEvtConfig.event) as string };
      // P8.F / QF-MT WP4: resolve the owning workflow's org for the
      // Subscription stamp (used by GET /api/triggers/events isolation).
      const workflowOrgIdForEvent = resolveWorkflowOrgId(stored, deps);
      eventBus.subscribe(config.pattern, async (envelope) => {
        const firedAt = new Date().toISOString();
        // Prefer envelope's tenant org_id (it carries the originating org),
        // then fall back to the workflow's owning org, then bootstrap-level orgId.
        const envelopeTenantOrgId = (envelope as any)?.tenant?.org_id as string | undefined;
        const resolvedOrgId = envelopeTenantOrgId || workflowOrgIdForEvent;

        // STABILITY-AUDITS Fix 2: hop count carried through the dispatch
        // chain via the ORIGINATING execution's own stored metadata — every
        // WORKFLOW.COMPLETED/FAILED/CANCELLED envelope carries payload.
        // executionId, so this reads back whatever hop count that run was
        // dispatched with (0 for anything not itself event-triggered, e.g.
        // manual/API/schedule/webhook runs, or an event with no known
        // origin). SYSTEM_SCOPE is used deliberately here — this is an
        // internal loop-prevention lookup, not a tenant data read.
        const originExecutionId = (envelope as any)?.payload?.executionId as string | undefined;
        let incomingHop = 0;
        if (originExecutionId) {
          try {
            const originRow = await deps.executionStore.get(originExecutionId, SYSTEM_SCOPE);
            const originMeta = originRow?.metadata as Record<string, unknown> | undefined;
            if (typeof originMeta?.eventHopCount === 'number') incomingHop = originMeta.eventHopCount;
          } catch { /* best-effort — treat as a fresh origin on lookup failure */ }
        }
        const hopCount = incomingHop + 1;
        const cap = eventHopCap();

        if (hopCount > cap) {
          eventLog.error(
            `Event hop limit exceeded for workflow ${workflow.id} (hop ${hopCount} > cap ${cap}) — refusing to dispatch`,
            { pattern: config.pattern, triggeringIntent: envelope.intent, originExecutionId }
          );
          try {
            await deps.executionStore.create({
              workflowId: workflow.id,
              workflowName: workflow.name,
              correlationId: `wf-${workflow.id}-hopcap-${ulid().slice(-8)}`,
              status: 'failed',
              triggerData: envelope,
              startedAt: firedAt,
              completedAt: new Date().toISOString(),
              error: {
                code: 'EVENT_HOP_LIMIT_EXCEEDED',
                message: `Event chain exceeded max hops (${cap}); refusing to dispatch workflow ${workflow.id}`,
              },
              triggeredBy: `system:event:${node.id}`,
            }, resolvedOrgId);
          } catch (recordErr) {
            eventLog.error(`Could not record hop-limit rejection for ${workflow.id}`, {
              error: recordErr instanceof Error ? recordErr.message : String(recordErr),
            });
          }
          return;
        }

        try {
          await executionService.executeAsync(workflow, envelope, {
            // FND_01M55X6TRMDS63SDZK3TDS63SD: an event-triggered run is a named system actor.
            actor: { kind: 'system', id: `event:${node.id}` },
            triggeredBy: `system:event:${node.id}`,
            orgId: resolvedOrgId,
            eventHopCount: hopCount,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          eventLog.error(`Execution failed for ${workflow.id}`, { error: msg });
          try {
            await deps.executionStore.create({
              workflowId: workflow.id,
              workflowName: workflow.name,
              correlationId: `wf-${workflow.id}-fail-${ulid().slice(-8)}`,
              status: 'failed',
              triggerData: envelope,
              startedAt: firedAt,
              completedAt: new Date().toISOString(),
              error: { code: 'EVENT_FIRE_ERROR', message: msg },
              triggeredBy: `system:event:${node.id}`,
            }, resolvedOrgId); // QF-MT WP5: forced by execution-store signature change; resolvedOrgId already resolved above.
          } catch (recordErr) {
            eventLog.error(`Could not record failure for ${workflow.id}`, {
              error: recordErr instanceof Error ? recordErr.message : String(recordErr),
            });
          }
        }
      }, { workflowId: workflow.id, orgId: workflowOrgIdForEvent });
      bootLog.info(`Event: ${workflow.id}:${node.id} — pattern: ${config.pattern}`);
      registeredAny = true;
    } else if (node.type === 'trigger:webhook') {
      const config = node.config as { path: string; method?: string };
      // QF-MT WP4: resolve orgId here too — the caller (server.ts /
      // workflows-lifecycle.ts) threads it into WebhookRegistry.register().
      webhooks.push({
        path: config.path,
        method: (config.method || 'POST').toUpperCase(),
        workflowId: workflow.id,
        nodeId: node.id,
        orgId: resolveWorkflowOrgId(stored, deps),
      });
      bootLog.info(`Webhook: ${workflow.id}:${node.id} — ${config.method || 'POST'} ${config.path}`);
      registeredAny = true;
    }
  }

  return { hasTriggers: registeredAny, webhooks };
}

/**
 * Activate a specific workflow — registers its triggers and sets active=true.
 *
 * QF-MT WP3: `scope` is the caller's resolved org scope (or SYSTEM_SCOPE),
 * used for the workflowStore get/setActive calls below — a cross-org
 * workflowId behaves identically to a missing one (404 at the route layer).
 */
export async function activateWorkflow(deps: BootstrapDeps & { workflowId: string; scope: WorkflowOrgScope }): Promise<{
  success: boolean;
  triggersRegistered: number;
  webhooks: WebhookEntry[];
  error?: string;
}> {
  const { workflowId, workflowStore, scheduleExecutor, eventBus, scope } = deps;

  const stored = await workflowStore.get(workflowId, scope);
  if (!stored) {
    return { success: false, triggersRegistered: 0, webhooks: [], error: `Workflow ${workflowId} not found` };
  }

  // Set active flag
  if (!stored.active) {
    await workflowStore.setActive(workflowId, scope, true);
  }

  // Build execution service for trigger callbacks
  const executionService = new ExecutionService({
    store: deps.envelopeStore,
    executors: deps.executors,
    executionStore: deps.executionStore,
    eventBus,
    observationStore: deps.observationStore,
    executionHistoryStore: deps.executionHistoryStore,
    skillLibraryStore: deps.skillLibraryStore,
    evidenceStore: deps.evidenceStore,
    orgId: deps.orgId,
    // R3.crit-2: same gates as bootstrap path
    budgetEvaluator: deps.budgetEvaluator,
    budgetScopeResolver: deps.budgetScopeResolver,
    policyEvaluator: deps.policyEvaluator,
    // REPLAY-ONLY .A-1a: same wiring as the bootstrap path above.
    replayOnlyResolver: deps.replayOnlyResolver,
    approvalEngine: deps.approvalEngine,
    lineageLlmClient: deps.lineageLlmClient,  // MEM-DECAY MD.3
  });

  const triggerResult = registerWorkflowTriggers(stored, scheduleExecutor, eventBus, executionService, deps);

  return {
    success: true,
    triggersRegistered: triggerResult.webhooks.length +
      stored.definition.nodes.filter(n =>
        n.type === 'trigger:schedule' || n.type === 'trigger:event'
      ).length,
    webhooks: triggerResult.webhooks,
  };
}

/**
 * Deactivate a specific workflow — unregisters its triggers and sets active=false.
 *
 * R5.high-2: also cancels any pending approvals tied to this workflow so inbox
 * items don't become dead links to a deactivated/non-resumable execution.
 */
export async function deactivateWorkflow(deps: {
  workflowId: string;
  /** QF-MT WP3: caller's resolved org scope (or SYSTEM_SCOPE) for the
   * workflowStore get/setActive calls below. */
  scope: WorkflowOrgScope;
  workflowStore: WorkflowStore;
  scheduleExecutor: ScheduleExecutor;
  eventBus: EventBus;
  /** Optional — when provided, pending approvals for this workflow are cancelled. */
  approvalStore?: ApprovalStore;
  approvalEngine?: ApprovalEngine;
  envelopeStore?: EnvelopeStore;
}): Promise<{
  success: boolean;
  error?: string;
  approvalsCancelled?: number;
}> {
  const { workflowId, scope, workflowStore, scheduleExecutor, eventBus } = deps;

  const stored = await workflowStore.get(workflowId, scope);
  if (!stored) {
    return { success: false, error: `Workflow ${workflowId} not found` };
  }

  // Unregister all triggers
  scheduleExecutor.unregisterWorkflow(workflowId);
  eventBus.unsubscribeWorkflow(workflowId);

  // Set inactive flag
  if (stored.active) {
    await workflowStore.setActive(workflowId, scope, false);
  }

  // R5.high-2: Cancel pending approvals tied to this workflow.
  // Prevents inbox items from becoming dead links after deactivation.
  let approvalsCancelled = 0;
  if (deps.approvalStore && deps.approvalEngine) {
    try {
      // QF-MT WP6: approval store scope is now required (no silent
      // SYSTEM_SCOPE default) — `scope` here is the caller's already-resolved
      // org scope (same value threaded into workflowStore.get/setActive
      // above), so this also narrows the cancellation sweep to the correct
      // org rather than reaching for SYSTEM_SCOPE out of convenience.
      const pending = await deps.approvalStore.list({ workflowId, status: 'pending' }, scope);
      for (const approval of pending) {
        await deps.approvalEngine.cancel(approval.id, scope);
        approvalsCancelled++;

        // Emit audit envelope per cancellation.
        if (deps.envelopeStore) {
          try {
            const { envelopes, Intents } = await import('../core/envelope.js');
            await deps.envelopeStore.append(
              envelopes.event(
                'quox.approval.cancelled_workflow_deactivated',
                workflowId,
                { approvalId: approval.id, workflowId, executionId: approval.executionId }
              ),
              scope // QF-MT WP5: forced by envelope-store signature change; scope already resolved above.
            );
          } catch { /* best-effort audit */ }
        }
      }
      if (approvalsCancelled > 0) {
        deactivateLog.info(`Cancelled ${approvalsCancelled} pending approvals for workflow ${workflowId}`);
      }
    } catch (err) {
      // Non-fatal: log but don't block deactivation
      deactivateLog.warn(`Error cancelling approvals for ${workflowId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { success: true, approvalsCancelled };
}
