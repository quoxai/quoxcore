/**
 * Execution Routes
 *
 * Workflow execution and execution tracking.
 */

import { Hono } from 'hono';
import { AppEnv } from '../types.js';
import { z } from 'zod';
import { validateBody, validateQuery, validateParams, IdParamSchema, PaginationQuerySchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes } from '../middleware/error-handler.js';
import { WorkflowStore } from '../stores/workflow-store.js';
import { resolveOrgScope, SYSTEM_SCOPE, OrgScope } from '../middleware/org-scope.js';
import { ExecutionStore, ExecutionOrgScope } from '../stores/execution-store.js';
import { ExecutionService } from '../services/execution-service.js';
import { EnvelopeStore } from '../../store/envelope-store.js';

/**
 * QF-MT WP5: translate the resolved caller OrgScope (org-scope.ts) into the
 * `string | SYSTEM_SCOPE` shape every store method expects. Shared by both
 * routers below.
 */
function toStoreScope(scope: OrgScope): ExecutionOrgScope {
  return scope.kind === 'system' ? SYSTEM_SCOPE : scope.orgId;
}

// AEE-FULL Gap 4: cancel route schema
const CancelExecutionSchema = z.object({
  reason: z.string().optional(),
});

// Request schemas
const ExecuteWorkflowSchema = z.object({
  triggerData: z.unknown().optional(),
  async: z.boolean().optional().default(false),
  // P8.F HITL-ORGID-PLUMB: orgId must be a non-null string when present.
  // z.string() already rejects null at the type level, returning 400.
  orgId: z.string().optional(),
});

const ListExecutionsQuerySchema = PaginationQuerySchema.extend({
  // Accept both camelCase (workflowId) and snake_case (workflow_id) forms.
  workflowId: z.string().optional(),
  workflow_id: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'paused', 'cancelled']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
}).transform(data => ({
  ...data,
  // Normalise: snake_case wins if camelCase is absent
  workflowId: data.workflowId ?? data.workflow_id,
}));

const ResumeExecutionSchema = z.object({
  approved: z.boolean(),
  approver: z.string(),
  reason: z.string().optional(),
  requestChanges: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
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

export function createExecutionRoutes(deps: {
  workflowStore: WorkflowStore;
  executionStore: ExecutionStore;
  executionService: ExecutionService;
  envelopeStore: EnvelopeStore;
}) {
  const app = new Hono<AppEnv>();

  // GET /api/executions - List executions
  app.get('/', validateQuery(ListExecutionsQuerySchema), async c => {
    const storeScope = toStoreScope(resolveOrgScope(c));
    const query = c.get('validatedQuery') as z.infer<typeof ListExecutionsQuerySchema>;
    const executions = await deps.executionStore.list(storeScope, query);
    const total = await deps.executionStore.count(storeScope, query);
    return paginated(c, executions, { total, limit: query.limit, offset: query.offset });
  });

  // GET /api/executions/:id - Get execution by ID or correlation ID
  app.get('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));

    // Try to find by execution ID first
    let execution = await deps.executionStore.get(id, storeScope);

    // If not found, try correlation ID
    if (!execution) {
      execution = await deps.executionStore.getByCorrelation(id, storeScope);
    }

    if (!execution) {
      throw new NotFoundError(ErrorCodes.EXECUTION_NOT_FOUND, `Execution ${id} not found`);
    }

    return success(c, execution);
  });

  // GET /api/executions/:id/envelopes - Get all envelopes for execution
  app.get('/:id/envelopes', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));

    // Get execution to find correlation ID (org-scoped — cross-org id falls
    // through to the raw-correlationId path below, which is itself
    // org-scoped by envelopeStore.query() so no leak occurs either way).
    let correlationId = id;
    const execution = await deps.executionStore.get(id, storeScope);
    if (execution) {
      correlationId = execution.correlationId;
    }

    const envelopes = await deps.envelopeStore.query({ corr: correlationId }, storeScope);

    return success(c, {
      executionId: execution?.id || id,
      correlationId,
      envelopes,
      count: envelopes.length,
    });
  });

  // POST /api/executions/:id/cancel - Cancel a running execution
  // SD-2: cancelled_by is hardcoded to 'user' regardless of body content.
  // System/timeout paths bypass HTTP entirely.
  app.post('/:id/cancel', validateParams(IdParamSchema), validateBody(CancelExecutionSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const { reason } = c.get('validatedBody') as z.infer<typeof CancelExecutionSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));

    // QF-MT WP5: ownership check BEFORE delegating to the service — a
    // cross-org execution id must 404 here, not reach cancel() at all.
    const owned = await deps.executionStore.get(id, storeScope);
    if (!owned) {
      throw new NotFoundError(ErrorCodes.EXECUTION_NOT_FOUND, `Execution ${id} not found`);
    }

    // LAUNCH-SPINE: attribute the cancellation to the authenticated caller.
    // Taken from the verified auth context, never from the request body — the
    // body is caller-controlled and would make actor_id forgeable.
    const actorId = c.get('user')?.user_id;
    const result = await deps.executionService.cancel(id, reason ?? '', 'user', actorId);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        throw new NotFoundError(ErrorCodes.EXECUTION_NOT_FOUND, `Execution ${id} not found`);
      }
      if (result.reason === 'already_terminal') {
        return c.json({
          success: false,
          error: { code: 'ALREADY_TERMINAL', current_status: result.currentStatus },
        }, 409);
      }
    } else {
      return success(c, result.execution);
    }
  });

  // POST /api/executions/:id/resume - Resume a paused execution
  app.post('/:id/resume', validateParams(IdParamSchema), validateBody(ResumeExecutionSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const decision = c.get('validatedBody') as z.infer<typeof ResumeExecutionSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));

    // QF-MT WP5: ownership check — cross-org execution id 404s here, before
    // ever reaching the service or the workflow lookup below.
    const execution = await deps.executionStore.get(id, storeScope);
    if (!execution) {
      throw new NotFoundError(ErrorCodes.EXECUTION_NOT_FOUND, `Execution ${id} not found`);
    }

    if (execution.status !== 'paused') {
      return c.json({
        success: false,
        error: {
          code: 'NOT_PAUSED',
          message: `Execution ${id} is not paused (status: ${execution.status})`,
        },
      }, 400);
    }

    // SEC-FIX (mirrors approvals.ts SEC-FIX-1): bind body decision.approver to
    // the authenticated JWT identity. Without this, any authenticated caller
    // could resume a paused execution and attribute the approval to any
    // human they named — a witnessed false-approval record.
    // Service-auth callers (type='service') bypass — trusted internal.
    // JWT-auth callers (type='access') must have user_id matching approver.
    // No-auth mode (authEnabled=false) leaves c.get('user') undefined — skip.
    const authUser = c.get('user');
    if (authUser && authUser.type === 'access' && authUser.user_id !== decision.approver) {
      return c.json({
        success: false,
        error: {
          code: 'APPROVER_IDENTITY_MISMATCH',
          message: `Authenticated identity (${authUser.user_id}) does not match claimed approver (${decision.approver}). Approver must match JWT subject.`,
        },
      }, 403);
    }

    // Get the workflow to resume. QF-MT WP5: replaces the WP3 SYSTEM_SCOPE
    // stopgap with the caller's resolved scope now that this route resolves one.
    const workflow = await deps.workflowStore.get(execution.workflowId, storeScope);
    if (!workflow) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${execution.workflowId} not found`);
    }

    const result = await deps.executionService.resume(id, workflow.definition, decision);
    return success(c, result, result.success ? 200 : 500);
  });

  return app;
}

export function createWorkflowExecuteRoute(deps: {
  workflowStore: WorkflowStore;
  executionService: ExecutionService;
}) {
  const app = new Hono<AppEnv>();

  // POST /api/workflows/:id/execute - Execute workflow
  app.post('/:id/execute', validateParams(IdParamSchema), validateBody(ExecuteWorkflowSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const { triggerData, async: isAsync, orgId: bodyOrgId } = c.get('validatedBody') as z.infer<typeof ExecuteWorkflowSchema>;

    // QF-MT WP5: kill the spoofable body orgId — resolved caller scope wins.
    // Back-compat (plan §9 risk 6): the body field is still accepted for one
    // cycle, but a JWT caller supplying a mismatched value gets a loud 400
    // rather than being silently overridden. Service/dev callers with no JWT
    // org fall back to the body value (system scope has no better source).
    const scope = resolveOrgScope(c);
    const storeScope = toStoreScope(scope);
    const user = c.get('user') as { type?: string } | undefined;
    if (bodyOrgId && user?.type === 'access' && scope.kind === 'org' && bodyOrgId !== scope.orgId) {
      return c.json({
        success: false,
        error: {
          code: 'ORG_MISMATCH',
          message: 'Body orgId does not match the authenticated org — omit it, the JWT org is authoritative',
          requestId: c.get('correlationId'),
        },
      }, 400);
    }
    const resolvedOrgId = scope.kind === 'org' ? scope.orgId : bodyOrgId;

    // QF-MT WP5: replaces the WP3 SYSTEM_SCOPE stopgap with the resolved scope.
    const workflow = await deps.workflowStore.get(id, storeScope);
    if (!workflow) {
      throw new NotFoundError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`);
    }

    // Get correlation ID from request
    const correlationId = c.get('correlationId') as string;

    if (isAsync) {
      // Fire and forget - return immediately with execution ID
      const executionId = await deps.executionService.executeAsync(workflow.definition, triggerData, {
        correlationId,
        orgId: resolvedOrgId,
      });

      return success(
        c,
        {
          executionId,
          status: 'running',
          message: 'Workflow execution started',
        },
        202
      );
    }

    // Synchronous execution
    const result = await deps.executionService.execute(workflow.definition, triggerData, {
      correlationId,
      orgId: resolvedOrgId,
    });

    return success(c, result, result.success ? 200 : 500);
  });

  return app;
}
