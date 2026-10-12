/**
 * Workflow Routes
 *
 * CRUD operations for workflow management.
 */

import { Hono } from 'hono';
import { AppEnv } from '../types.js';
import { z } from 'zod';
import { WorkflowSchema, Workflow } from '../../core/workflow.js';
import { validateBody, validateQuery, validateParams, IdParamSchema, PaginationQuerySchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes } from '../middleware/error-handler.js';
import { requireOrgScope } from '../middleware/org-scope.js';
import { WorkflowStore } from '../stores/workflow-store.js';
import { ExecutionStore } from '../stores/execution-store.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { ScheduleExecutor } from '../../executors/schedule.executor.js';
import { EventBus } from '../../events/event-bus.js';
import { WorkflowService } from '../services/workflow-service.js';
import { activateWorkflow } from '../../runtime/trigger-bootstrap.js';
import { envelopes, Intents } from '../../core/envelope.js';
import { BudgetEvaluator } from '../../budget/budget-evaluator.js';
import { BudgetScopeContext } from '../../pipeline/control-pipeline.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import type { ApprovalEngine } from '../../approval/index.js';
import type { ReplayOnlyResolveParams } from '../../store/replay-only-flags-store.js';

// Request schemas
const ListWorkflowsQuerySchema = PaginationQuerySchema.extend({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => (v === undefined ? undefined : v === 'true')),
});

const ImportN8nSchema = z.object({
  workflow: z.unknown(),
  options: z
    .object({
      generateIds: z.boolean().optional(),
      includePositions: z.boolean().optional(),
    })
    .optional(),
});

const ImportObjectiveSchema = z.object({
  template: z.object({
    title: z.string(),
    description: z.string().optional(),
    max_tokens: z.number().optional(),
    max_tool_calls: z.number().optional(),
    max_duration_ms: z.number().optional(),
    team_id: z.string().nullable().optional(),
    checkpoint_after_each_task: z.boolean().optional(),
    require_approval_before_start: z.boolean().optional(),
    tasks: z.array(z.object({
      title: z.string(),
      agent_id: z.string(),
      prompt: z.string(),
      sequence_num: z.number(),
      depends_on_indices: z.array(z.number()),
      output_schema: z.string().nullable().optional(),
    })).min(1, 'Must contain at least one task'),
    variables: z.array(z.object({
      name: z.string(),
      type: z.string(),
      defaultValue: z.string(),
      label: z.string(),
    })).optional(),
  }),
  schedule: z.object({
    cron: z.string(),
    timezone: z.string().optional(),
  }).optional(),
  options: z.object({
    activate: z.boolean().optional(),
    includeApprovalGate: z.boolean().optional(),
  }).optional(),
});

// Response helpers
function success<T>(c: { json: (data: unknown, status?: number) => Response; get: (key: string) => unknown }, data: T, status = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

function paginated<T>(
  c: { json: (data: unknown, status?: number) => Response; get: (key: string) => unknown },
  data: T[],
  pagination: { total: number; limit: number; offset: number }
) {
  return c.json({
    success: true,
    data,
    pagination: {
      ...pagination,
      hasMore: pagination.offset + data.length < pagination.total,
    },
    meta: {
      requestId: c.get('correlationId'),
      timestamp: new Date().toISOString(),
    },
  });
}

export function createWorkflowRoutes(deps: {
  workflowStore: WorkflowStore;
  workflowService: WorkflowService;
  // Optional trigger deps — when provided, triggers auto-register on workflow creation
  executionStore?: ExecutionStore;
  envelopeStore?: EnvelopeStore;
  executors?: ExecutorRegistry;
  scheduleExecutor?: ScheduleExecutor;
  eventBus?: EventBus;
  // R5.high-2: evaluators must flow into auto-activate so triggered executions are gated.
  budgetEvaluator?: BudgetEvaluator;
  budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  policyEvaluator?: PolicyEvaluator;
  // REPLAY-ONLY .A-1a: must flow into auto-activate so triggered executions
  // resolve context.effectiveReplayOnly.
  replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  approvalEngine?: ApprovalEngine;
}) {
  const app = new Hono<AppEnv>();

  // POST /api/workflows - Create workflow
  app.post('/', validateBody(WorkflowSchema), async c => {
    const orgId = requireOrgScope(c);
    const workflow = c.get('validatedBody') as Workflow;
    const stored = await deps.workflowStore.save(workflow, { orgId });

    // QF-MT WP3: null means this id already exists under a different org —
    // the write is rejected (never reassigns ownership). 404 hides row
    // existence, matching the by-id read/update/delete convention.
    if (!stored) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${workflow.id} not found`);
    }

    // Auto-register triggers if workflow has trigger nodes and deps are available
    const hasTriggers = stored.definition.nodes.some(n => n.type.startsWith('trigger:'));
    if (hasTriggers && deps.scheduleExecutor && deps.eventBus && deps.executionStore && deps.envelopeStore && deps.executors) {
      try {
        const result = await activateWorkflow({
          workflowId: stored.id,
          scope: orgId,
          workflowStore: deps.workflowStore,
          executionStore: deps.executionStore,
          envelopeStore: deps.envelopeStore,
          scheduleExecutor: deps.scheduleExecutor,
          eventBus: deps.eventBus,
          executors: deps.executors,
          // R5.high-2: budget + policy evaluators must reach trigger callbacks.
          budgetEvaluator: deps.budgetEvaluator,
          budgetScopeResolver: deps.budgetScopeResolver,
          policyEvaluator: deps.policyEvaluator,
          // REPLAY-ONLY .A-1a: same wiring for auto-activated trigger callbacks.
          replayOnlyResolver: deps.replayOnlyResolver,
          approvalEngine: deps.approvalEngine,
        });
        console.log(`[Workflows] Auto-activated triggers for ${stored.id}: ${result.triggersRegistered} triggers`);
      } catch (err) {
        console.error(`[Workflows] Auto-activate failed for ${stored.id}:`, err instanceof Error ? err.message : err);
      }
    }

    return success(c, stored, 201);
  });

  // GET /api/workflows - List workflows
  app.get('/', validateQuery(ListWorkflowsQuerySchema), async c => {
    const orgId = requireOrgScope(c);
    const { limit, offset, active } = c.get('validatedQuery') as z.infer<typeof ListWorkflowsQuerySchema>;
    const workflows = await deps.workflowStore.list(orgId, { limit, offset, active });
    const total = await deps.workflowStore.count(orgId, { active });
    return paginated(c, workflows, { total, limit, offset });
  });

  // GET /api/workflows/count — QSKL-AP-1: per-agent workflow count
  // Mounted before /:id to prevent 'count' being captured as a workflow ID.
  app.get('/count', async c => {
    const orgId = requireOrgScope(c);
    const agentId = c.req.query('agentId');
    const activeRaw = c.req.query('active');
    const active = activeRaw === 'true' ? true : activeRaw === 'false' ? false : undefined;
    const count = await deps.workflowStore.count(orgId, { active, agentId });
    return success(c, { count });
  });

  // POST /api/workflows/import-n8n - Import n8n workflow
  // Note: This must come before /:id to avoid matching 'import-n8n' as an ID
  app.post('/import-n8n', validateBody(ImportN8nSchema), async c => {
    const orgId = requireOrgScope(c);
    const { workflow: n8nWorkflow, options } = c.get('validatedBody') as z.infer<typeof ImportN8nSchema>;

    const result = await deps.workflowService.importN8n(n8nWorkflow, options);

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: {
            code: ErrorCodes.IMPORT_ERROR,
            message: 'Failed to import n8n workflow',
            details: result.errors,
            requestId: c.get('correlationId'),
          },
          warnings: result.warnings,
          nodeMapping: result.nodeMapping,
        },
        400
      );
    }

    // Save the converted workflow
    const stored = await deps.workflowStore.save(result.workflow!, { orgId });

    // QF-MT WP3: see POST / above — cross-org id reuse rejected, 404 hides existence.
    if (!stored) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${result.workflow!.id} not found`);
    }

    return success(
      c,
      {
        workflow: stored,
        warnings: result.warnings,
        nodeMapping: result.nodeMapping,
      },
      201
    );
  });

  // POST /api/workflows/import-objective - Import objective template
  // Note: This must come before /:id to avoid matching as an ID
  app.post('/import-objective', validateBody(ImportObjectiveSchema), async c => {
    const orgId = requireOrgScope(c);
    const { template, schedule, options: importOptions } = c.get('validatedBody') as z.infer<typeof ImportObjectiveSchema>;

    const result = await deps.workflowService.importObjectiveTemplate(template, {
      schedule,
      includeApprovalGate: importOptions?.includeApprovalGate,
    });

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: {
            code: ErrorCodes.IMPORT_ERROR,
            message: 'Failed to convert objective template',
            requestId: c.get('correlationId'),
          },
          warnings: result.warnings,
          nodeMapping: result.nodeMapping,
        },
        400
      );
    }

    // Save the converted workflow
    const stored = await deps.workflowStore.save(result.workflow, { orgId });

    // QF-MT WP3: see POST / above — cross-org id reuse rejected, 404 hides existence.
    if (!stored) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${result.workflow.id} not found`);
    }

    // Optionally activate (register triggers)
    let activated = false;
    let triggersRegistered = 0;
    if (importOptions?.activate && deps.executionStore && deps.envelopeStore && deps.executors && deps.scheduleExecutor && deps.eventBus) {
      const activationResult = await activateWorkflow({
        workflowStore: deps.workflowStore,
        scope: orgId,
        executionStore: deps.executionStore,
        envelopeStore: deps.envelopeStore,
        executors: deps.executors,
        scheduleExecutor: deps.scheduleExecutor,
        eventBus: deps.eventBus,
        workflowId: stored.id,
        // R5.high-2: budget + policy evaluators must reach trigger callbacks.
        budgetEvaluator: deps.budgetEvaluator,
        budgetScopeResolver: deps.budgetScopeResolver,
        policyEvaluator: deps.policyEvaluator,
        // REPLAY-ONLY .A-1a: same wiring for import-activated trigger callbacks.
        replayOnlyResolver: deps.replayOnlyResolver,
        approvalEngine: deps.approvalEngine,
      });
      activated = activationResult.success;
      triggersRegistered = activationResult.triggersRegistered;
    }

    return success(
      c,
      {
        workflow: stored,
        warnings: result.warnings,
        nodeMapping: result.nodeMapping,
        activated,
        triggersRegistered,
      },
      201
    );
  });

  // GET /api/workflows/:id - Get workflow by ID
  app.get('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    const workflow = await deps.workflowStore.get(id, orgId);

    if (!workflow) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }

    return success(c, workflow);
  });

  // PUT /api/workflows/:id - Update workflow (metadata + definition)
  app.put('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    const existing = await deps.workflowStore.get(id, orgId);

    if (!existing) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }

    const body = await c.req.json();
    const updates: Partial<Workflow> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.notes !== undefined) updates.notes = body.notes;

    // Definition updates: WEAVER's wb_emit and the dashboard's "Save" both
    // need this. Accept the full definition shape OR top-level
    // nodes/edges/variables/metadata so callers don't have to wrap. The
    // store's update() merges, so we hand it the canonical Workflow keys.
    if (body.definition !== undefined && body.definition !== null) {
      const def = body.definition as Partial<Workflow>;
      if (def.nodes !== undefined) updates.nodes = def.nodes;
      if (def.edges !== undefined) updates.edges = def.edges;
      if (def.variables !== undefined) updates.variables = def.variables;
      if (def.metadata !== undefined) {
        updates.metadata = { ...(existing.metadata || {}), ...def.metadata };
      }
    }
    if (body.nodes !== undefined) updates.nodes = body.nodes;
    if (body.edges !== undefined) updates.edges = body.edges;
    if (body.variables !== undefined) updates.variables = body.variables;

    const mergedMeta = { ...(existing.metadata || {}), ...(body.metadata || {}) };
    if (body.tags !== undefined) mergedMeta.tags = body.tags;
    if (body.metadata !== undefined || body.tags !== undefined) {
      updates.metadata = updates.metadata
        ? { ...updates.metadata, ...mergedMeta }
        : mergedMeta;
    }

    const updated = await deps.workflowStore.update(id, orgId, updates);
    if (!updated) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }
    return success(c, updated);
  });

  // POST /api/workflows/:id/validate - Validate workflow
  app.post('/:id/validate', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    const workflow = await deps.workflowStore.get(id, orgId);

    if (!workflow) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }

    const validation = await deps.workflowService.validate(workflow.definition);
    return success(c, validation);
  });

  // DELETE /api/workflows/:id - Delete workflow
  app.delete('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    const deleted = await deps.workflowStore.delete(id, orgId);

    if (!deleted) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }

    // AEE audit envelope
    try {
      if (deps.envelopeStore) await deps.envelopeStore.append(envelopes.event(Intents.LIFECYCLE.DELETED, c.get('correlationId'), { workflowId: id }), orgId);
    } catch { /* fire-and-forget */ }

    return success(c, { deleted: true });
  });

  return app;
}
