/**
 * Workflow Lifecycle Routes
 *
 * Activate/deactivate workflows, which registers/unregisters triggers.
 *
 * Routes:
 *   POST /api/workflows/:id/activate   — Register triggers, set active=true
 *   POST /api/workflows/:id/deactivate — Unregister triggers, set active=false
 */

import { Hono } from 'hono';
import { AppEnv } from '../types.js';
import { validateParams, IdParamSchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes } from '../middleware/error-handler.js';
import { requireOrgScope } from '../middleware/org-scope.js';
import { WorkflowStore } from '../stores/workflow-store.js';
import { ExecutionStore } from '../stores/execution-store.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { ScheduleExecutor } from '../../executors/schedule.executor.js';
import { EventBus } from '../../events/event-bus.js';
import { activateWorkflow, deactivateWorkflow } from '../../runtime/trigger-bootstrap.js';
import { WebhookRegistry } from './webhook-triggers.js';
import { z } from 'zod';
import { envelopes, Intents } from '../../core/envelope.js';
import { BudgetEvaluator } from '../../budget/budget-evaluator.js';
import { BudgetScopeContext } from '../../pipeline/control-pipeline.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import { ApprovalEngine } from '../../approval/index.js';
import type { ApprovalStore } from '../../approval/types.js';
import type { ReplayOnlyResolveParams } from '../../store/replay-only-flags-store.js';

interface LifecycleRoutesConfig {
  workflowStore: WorkflowStore;
  executionStore: ExecutionStore;
  envelopeStore: EnvelopeStore;
  executors: ExecutorRegistry;
  scheduleExecutor: ScheduleExecutor;
  eventBus: EventBus;
  webhookRegistry: WebhookRegistry;
  // R5.high-2: budget + policy evaluators must flow into activateWorkflow so
  // schedule/event/webhook triggers spawned after activation are gated.
  budgetEvaluator?: BudgetEvaluator;
  budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  policyEvaluator?: PolicyEvaluator;
  // REPLAY-ONLY .A-1a: must flow into activateWorkflow so schedule/event/
  // webhook triggers spawned after activation resolve context.effectiveReplayOnly.
  replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  approvalEngine?: ApprovalEngine;
  /** R5.high-2: when provided, pending approvals are cancelled on deactivate. */
  approvalStore?: ApprovalStore;
}

export function createWorkflowLifecycleRoutes(config: LifecycleRoutesConfig) {
  const app = new Hono<AppEnv>();

  // POST /:id/activate — Register triggers and set active=true
  app.post('/:id/activate', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;

    // QF-MT WP3: org comes from the resolved caller scope (JWT org_id /
    // service X-Org-Id / dev fallback) — body org_id is no longer trusted
    // as the ownership check. Kept for back-compat: a JWT caller supplying a
    // mismatched body org_id gets a loud 400 (looks like a client bug worth
    // surfacing) rather than being silently ignored; service/dev callers'
    // body org_id is ignored (resolved scope wins).
    const orgId = requireOrgScope(c);
    const user = c.get('user') as { type?: string } | undefined;
    let bodyOrgId: string | undefined;
    try {
      const body = await c.req.json().catch(() => ({}));
      bodyOrgId = typeof body?.org_id === 'string' ? body.org_id : undefined;
    } catch { /* fall through — no body is fine for auth-disabled flows */ }

    if (bodyOrgId && user?.type === 'access' && bodyOrgId !== orgId) {
      return c.json({
        success: false,
        error: { code: 'ORG_MISMATCH', message: 'Body org_id does not match the authenticated org — omit it, the JWT org is authoritative', requestId: c.get('correlationId') },
      }, 400);
    }

    // Cross-org workflowId now resolves to null inside activateWorkflow
    // (store-level org check) — surfaces as the existing 404 below, not a 403.
    // This hides row existence for cross-org callers, matching the plan's
    // by-id access rule.
    const result = await activateWorkflow({
      workflowId: id,
      scope: orgId,
      workflowStore: config.workflowStore,
      executionStore: config.executionStore,
      envelopeStore: config.envelopeStore,
      scheduleExecutor: config.scheduleExecutor,
      eventBus: config.eventBus,
      executors: config.executors,
      // R5.high-2: evaluators must reach trigger callbacks so policy + budget
      // gates fire for schedule/event/webhook-triggered executions too.
      budgetEvaluator: config.budgetEvaluator,
      budgetScopeResolver: config.budgetScopeResolver,
      policyEvaluator: config.policyEvaluator,
      // REPLAY-ONLY .A-1a: same wiring for activate-triggered runs.
      replayOnlyResolver: config.replayOnlyResolver,
      approvalEngine: config.approvalEngine,
    });

    if (!result.success) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, result.error || `Workflow ${id} not found`);
    }

    // Register webhooks. QF-MT WP4: wh.orgId (owning workflow's org) is
    // threaded into the registry so cross-org path collisions are rejected
    // and GET /api/triggers/webhooks can filter by caller scope.
    for (const wh of result.webhooks) {
      config.webhookRegistry.register(wh.path, wh.workflowId, wh.nodeId, wh.orgId, wh.method);
    }

    // AEE audit envelope
    try {
      await config.envelopeStore.append(envelopes.event(Intents.LIFECYCLE.ACTIVATED, c.get('correlationId'), { workflowId: id, triggersRegistered: result.triggersRegistered }), orgId);
    } catch { /* fire-and-forget */ }

    return c.json({
      success: true,
      data: {
        workflowId: id,
        active: true,
        triggersRegistered: result.triggersRegistered,
        webhooks: result.webhooks.map(w => ({ path: w.path, method: w.method })),
      },
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    });
  });

  // POST /:id/deactivate — Unregister triggers and set active=false
  app.post('/:id/deactivate', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    // QF-MT WP3: previously had no ownership check at all — now resolved
    // scope gates the store-level get/setActive (cross-org → 404 below).
    const orgId = requireOrgScope(c);

    const result = await deactivateWorkflow({
      workflowId: id,
      scope: orgId,
      workflowStore: config.workflowStore,
      scheduleExecutor: config.scheduleExecutor,
      eventBus: config.eventBus,
      // R5.high-2: cancel pending approvals on deactivate to avoid inbox dead links.
      approvalStore: config.approvalStore,
      approvalEngine: config.approvalEngine,
      envelopeStore: config.envelopeStore,
    });

    if (!result.success) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, result.error || `Workflow ${id} not found`);
    }

    // Unregister webhooks for this workflow
    config.webhookRegistry.unregisterWorkflow(id);

    // AEE audit envelope
    try {
      await config.envelopeStore.append(envelopes.event(Intents.LIFECYCLE.DEACTIVATED, c.get('correlationId'), { workflowId: id }), orgId);
    } catch { /* fire-and-forget */ }

    return c.json({
      success: true,
      data: {
        workflowId: id,
        active: false,
      },
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    });
  });

  return app;
}
