/**
 * Approval API Routes
 *
 * Endpoints for managing approval requests.
 */

import { Hono, Context } from 'hono';
import { z } from 'zod';
import { ApprovalEngine, ApprovalOrgScope } from '../../approval/index.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { envelopes, Intents } from '../../core/envelope.js';
import { AppEnv } from '../types.js';
import { resolveOrgScope, SYSTEM_SCOPE } from '../middleware/org-scope.js';

// Use AppEnv so c.get('user') resolves to AuthUser. SEC-FIX-1 introduced
// the user lookup but the inline Variables type here didn't carry it,
// causing tsc to fail in the production Docker build (vitest's
// esbuild-loose tolerated it; the strict tsc step in the image did not).
const app = new Hono<AppEnv>();

/**
 * QF-MT WP6: resolve the caller's org scope for the approval store/engine
 * (which use the plain `string | SystemScope` shape, distinct from
 * org-scope.ts's `{kind:'org'|'system'}` discriminated union used elsewhere).
 * SYSTEM_SCOPE is intentionally reachable here (unlike `requireOrgScope`
 * used by workflows.ts) — service callers without X-Org-Id legitimately need
 * cross-org visibility for internal tooling (see plan §6, "SYSTEM_SCOPE
 * sees all").
 */
function toApprovalScope(c: Context<AppEnv>): ApprovalOrgScope {
  const scope = resolveOrgScope(c);
  return scope.kind === 'system' ? SYSTEM_SCOPE : scope.orgId;
}

// ============================================================================
// Create Approval Request
// ============================================================================

const CreateApprovalSchema = z.object({
  correlationId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowName: z.string().optional(),
  executionId: z.string().min(1),
  nodeId: z.string().optional(),
  trigger: z.object({
    policyId: z.string(),
    ruleId: z.string(),
    condition: z.string(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  approvers: z.array(z.string()).min(1),
  timeoutMs: z.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

app.post('/', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const scope = resolveOrgScope(c);

  try {
    const body = await c.req.json();
    const validated = CreateApprovalSchema.parse(body);

    // QF-MT WP6: resolved caller scope wins over any client-supplied
    // metadata.orgId — prevents spoofing another org via the free-form
    // metadata field. System-scope callers (service key, no X-Org-Id) don't
    // stamp an org — the approval falls to the legacy/system-visible bucket.
    const metadata = scope.kind === 'org'
      ? { ...validated.metadata, orgId: scope.orgId }
      : validated.metadata;

    const approval = await engine.createApproval({ ...validated, metadata });

    return c.json(
      {
        success: true,
        data: approval,
        meta: {
          requestId,
          timestamp: new Date().toISOString(),
        },
      },
      201
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            requestId,
          },
        },
        400
      );
    }

    throw error;
  }
});

// ============================================================================
// List Approvals
// ============================================================================

app.get('/', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const scope = toApprovalScope(c);

  const status = c.req.query('status') as
    | 'pending'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'cancelled'
    | undefined;
  const workflowId = c.req.query('workflowId');
  const approver = c.req.query('approver');
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const options = {
    status,
    workflowId,
    approver,
    limit: Math.min(limit, 1000),
    offset,
  };

  const [approvals, total] = await Promise.all([
    engine.list(options, scope),
    engine.count({ status, workflowId, approver }, scope),
  ]);

  return c.json({
    success: true,
    data: approvals,
    pagination: {
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + approvals.length < total,
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Approval Stats
// ============================================================================

app.get('/stats', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const scope = toApprovalScope(c);

  const stats = await engine.getStats(scope);

  return c.json({
    success: true,
    data: stats,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Pending Approvals for Approver
// ============================================================================

app.get('/pending/:approver', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const approver = c.req.param('approver');
  const scope = toApprovalScope(c);

  const approvals = await engine.getPendingForApprover(approver, scope);

  return c.json({
    success: true,
    data: approvals,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Approval by ID
// ============================================================================

app.get('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const id = c.req.param('id');
  const scope = toApprovalScope(c);

  const approval = await engine.get(id, scope);

  if (!approval) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Approval not found: ${id}`,
          requestId,
        },
      },
      404
    );
  }

  return c.json({
    success: true,
    data: approval,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Approval by Correlation ID
// ============================================================================

app.get('/correlation/:correlationId', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const correlationId = c.req.param('correlationId');
  const scope = toApprovalScope(c);

  const approval = await engine.getByCorrelationId(correlationId, scope);

  if (!approval) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Approval not found for correlation ID: ${correlationId}`,
          requestId,
        },
      },
      404
    );
  }

  return c.json({
    success: true,
    data: approval,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Approve
// ============================================================================

const ApproveSchema = z.object({
  approver: z.string().min(1),
  comment: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

app.post('/:id/approve', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const id = c.req.param('id');
  const scope = toApprovalScope(c);

  try {
    const body = await c.req.json();
    const { approver, comment, metadata } = ApproveSchema.parse(body);

    // SEC-FIX-1: Bind body approver to authenticated JWT identity.
    // Service-auth callers (type='service') bypass — trusted internal.
    // JWT-auth callers (type='access') must have user_id matching approver.
    // No-auth mode (authEnabled=false) leaves c.get('user') undefined — skip.
    const authUser = c.get('user');
    if (authUser && authUser.type === 'access' && authUser.user_id !== approver) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDENTITY_MISMATCH',
            message: `Authenticated identity (${authUser.user_id}) does not match claimed approver (${approver}). Approver must match JWT subject.`,
            requestId,
          },
        },
        403
      );
    }

    // Check if approval exists. QF-MT WP6: org-scoped — a cross-org id
    // returns null here exactly like a missing one, hiding row existence.
    // This is IN ADDITION to the SEC-FIX-1 approver-identity check above —
    // an org-b caller impersonating an authorized approver still can't reach
    // org-a's approval.
    const existing = await engine.get(id, scope);
    if (!existing) {
      return c.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Approval not found: ${id}`,
            requestId,
          },
        },
        404
      );
    }

    // Check authorization
    if (!engine.isAuthorizedApprover(existing, approver)) {
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: `Approver ${approver} is not authorized to approve this request`,
            requestId,
          },
        },
        403
      );
    }

    // Scope threaded through again here for defense-in-depth at the store
    // layer (the get() check above already gates the common path).
    const approval = await engine.approve(id, approver, comment, metadata, scope);

    return c.json({
      success: true,
      data: approval,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            requestId,
          },
        },
        400
      );
    }

    if (error instanceof Error && error.message.includes('not pending')) {
      return c.json(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message: error.message,
            requestId,
          },
        },
        409
      );
    }

    throw error;
  }
});

// ============================================================================
// Deny
// ============================================================================

const DenySchema = z.object({
  approver: z.string().min(1),
  comment: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

app.post('/:id/deny', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const id = c.req.param('id');
  const scope = toApprovalScope(c);

  try {
    const body = await c.req.json();
    const { approver, comment, metadata } = DenySchema.parse(body);

    // SEC-FIX-1: Bind body approver to authenticated JWT identity.
    // See approve endpoint above for rationale.
    const authUser = c.get('user');
    if (authUser && authUser.type === 'access' && authUser.user_id !== approver) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDENTITY_MISMATCH',
            message: `Authenticated identity (${authUser.user_id}) does not match claimed approver (${approver}). Approver must match JWT subject.`,
            requestId,
          },
        },
        403
      );
    }

    // Check if approval exists. QF-MT WP6: org-scoped (see approve above).
    const existing = await engine.get(id, scope);
    if (!existing) {
      return c.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Approval not found: ${id}`,
            requestId,
          },
        },
        404
      );
    }

    // Check authorization
    if (!engine.isAuthorizedApprover(existing, approver)) {
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: `Approver ${approver} is not authorized to deny this request`,
            requestId,
          },
        },
        403
      );
    }

    const approval = await engine.deny(id, approver, comment, metadata, scope);

    return c.json({
      success: true,
      data: approval,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            requestId,
          },
        },
        400
      );
    }

    if (error instanceof Error && error.message.includes('not pending')) {
      return c.json(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message: error.message,
            requestId,
          },
        },
        409
      );
    }

    throw error;
  }
});

// ============================================================================
// Cancel
// ============================================================================

app.post('/:id/cancel', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');
  const id = c.req.param('id');
  const scope = toApprovalScope(c);

  try {
    // QF-MT WP6: org-scoped — cross-org id returns null (hides existence).
    const existing = await engine.get(id, scope);
    if (!existing) {
      return c.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Approval not found: ${id}`,
            requestId,
          },
        },
        404
      );
    }

    const approval = await engine.cancel(id, scope);

    return c.json({
      success: true,
      data: approval,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not pending')) {
      return c.json(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message: error.message,
            requestId,
          },
        },
        409
      );
    }

    throw error;
  }
});

// ============================================================================
// Process Expired (Admin Endpoint)
// ============================================================================

app.post('/admin/expire', async (c) => {
  const requestId = c.get('correlationId');
  const engine = c.get('approvalEngine');

  const expiredCount = await engine.processExpired();

  // AEE audit envelope
  try {
    const es = c.get('envelopeStore');
    if (es) await es.append(envelopes.event(Intents.APPROVAL.BATCH_EXPIRED, requestId, { expiredCount }));
  } catch { /* fire-and-forget */ }

  return c.json({
    success: true,
    data: { expiredCount },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

export { app as approvalRoutes };
