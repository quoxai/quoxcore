/**
 * Policy API Routes
 *
 * CRUD endpoints for policy definitions and testing.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  PolicyStore,
  PolicyDefinitionSchema,
  PolicyDefinition,
} from '../../policy/types.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { envelopes, Intents } from '../../core/envelope.js';
import { SYSTEM_SCOPE } from '../middleware/org-scope.js';

const app = new Hono<{
  Variables: {
    correlationId: string;
    policyStore: PolicyStore;
    envelopeStore: EnvelopeStore;
  };
}>();

// ============================================================================
// Create Policy
// ============================================================================

const CreatePolicySchema = PolicyDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
});

app.post('/', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');

  try {
    const body = await c.req.json();

    // R5.high-1: org_id required on create so every policy is tenant-scoped.
    const org_id: string | undefined = typeof body?.org_id === 'string' ? body.org_id : undefined;
    if (!org_id) {
      return c.json({
        success: false,
        error: { code: 'ORG_ID_REQUIRED', message: 'org_id is required in the request body', requestId },
      }, 400);
    }

    const policy = CreatePolicySchema.parse(body);
    // Stamp the orgId onto the policy object so the store can filter by tenant.
    policy.orgId = org_id;

    const saved = await store.save(policy);
    if (!saved) {
      // Id already exists under a different org — never reassign ownership.
      // 403 matches this file's existing cross-tenant convention (see PUT).
      return c.json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Policy belongs to a different organisation', requestId },
      }, 403);
    }

    // AEE audit envelope
    try {
      const es = c.get('envelopeStore');
      if (es) await es.append(envelopes.event(Intents.POLICY.CREATED, requestId, { policyId: saved.id, name: saved.name }), org_id);
    } catch { /* fire-and-forget */ }

    return c.json({
      success: true,
      data: saved,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    }, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid policy definition',
          details: error.issues.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          requestId,
        },
      }, 400);
    }
    throw error;
  }
});

// ============================================================================
// List Policies
// ============================================================================

app.get('/', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');

  const org_id = c.req.query('org_id');
  if (!org_id) {
    return c.json({
      success: false,
      error: { code: 'ORG_ID_REQUIRED', message: 'org_id query parameter is required', requestId },
    }, 400);
  }

  const enabled = c.req.query('enabled');
  const workflowId = c.req.query('workflowId');
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const options = {
    enabled: enabled !== undefined ? enabled === 'true' : undefined,
    workflowId,
    limit: Math.min(limit, 1000),
    offset,
  };

  const allPolicies = await store.list(org_id, options);
  // Filter to the caller's org — cross-tenant isolation at the route layer.
  const policies = allPolicies.filter(p => !p.orgId || p.orgId === org_id);
  const total = policies.length;

  return c.json({
    success: true,
    data: policies,
    pagination: {
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: false,
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Policy
// ============================================================================

app.get('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');
  const id = c.req.param('id');

  const org_id = c.req.query('org_id');
  if (!org_id) {
    return c.json({
      success: false,
      error: { code: 'ORG_ID_REQUIRED', message: 'org_id query parameter is required', requestId },
    }, 400);
  }

  const policy = await store.get(id, SYSTEM_SCOPE);

  if (!policy) {
    return c.json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Policy not found: ${id}`,
        requestId,
      },
    }, 404);
  }

  // Cross-tenant guard: reject if policy belongs to a different org.
  if (policy.orgId && policy.orgId !== org_id) {
    return c.json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Policy belongs to a different organisation', requestId },
    }, 403);
  }

  return c.json({
    success: true,
    data: policy,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Update Policy
// ============================================================================

const UpdatePolicySchema = PolicyDefinitionSchema.partial().omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // orgId is never accepted from the update body — ownership is decided once
  // at creation and re-derived from the existing row below, never from the
  // caller's PUT payload (preserves pre-formalization behaviour, where this
  // field didn't exist on the schema at all and was silently stripped).
  orgId: true,
});

app.put('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');
  const id = c.req.param('id');

  try {
    const body = await c.req.json();

    // Cross-tenant guard: org_id must be in the request body.
    const org_id: string | undefined = typeof body?.org_id === 'string' ? body.org_id : undefined;
    if (!org_id) {
      return c.json({
        success: false,
        error: { code: 'ORG_ID_REQUIRED', message: 'org_id is required in the request body', requestId },
      }, 400);
    }

    const updates = UpdatePolicySchema.parse(body);

    const existing = await store.get(id, SYSTEM_SCOPE);
    if (!existing) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Policy not found: ${id}`,
          requestId,
        },
      }, 404);
    }

    // Reject if the policy belongs to a different org.
    if (existing.orgId && existing.orgId !== org_id) {
      return c.json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Policy belongs to a different organisation', requestId },
      }, 403);
    }

    const updated = await store.update(id, updates);

    // AEE audit envelope
    try {
      const es = c.get('envelopeStore');
      if (es) await es.append(envelopes.event(Intents.POLICY.UPDATED, requestId, { policyId: id, fields: Object.keys(updates) }), org_id);
    } catch { /* fire-and-forget */ }

    return c.json({
      success: true,
      data: updated,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid policy update',
          details: error.issues.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          requestId,
        },
      }, 400);
    }
    throw error;
  }
});

// ============================================================================
// Delete Policy
// ============================================================================

app.delete('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');
  const id = c.req.param('id');

  // Cross-tenant guard: require org_id in the request body.
  let org_id: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    org_id = typeof body?.org_id === 'string' ? body.org_id : undefined;
  } catch { /* fall through */ }
  if (!org_id) {
    return c.json({
      success: false,
      error: { code: 'ORG_ID_REQUIRED', message: 'org_id is required in the request body', requestId },
    }, 400);
  }

  const existing = await store.get(id, SYSTEM_SCOPE);
  if (existing && existing.orgId && existing.orgId !== org_id) {
    return c.json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Policy belongs to a different organisation', requestId },
    }, 403);
  }

  const deleted = await store.delete(id);

  if (!deleted) {
    return c.json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Policy not found: ${id}`,
        requestId,
      },
    }, 404);
  }

  // AEE audit envelope
  try {
    const es = c.get('envelopeStore');
    if (es) await es.append(envelopes.event(Intents.POLICY.DELETED, requestId, { policyId: id }), org_id);
  } catch { /* fire-and-forget */ }

  return c.json({
    success: true,
    data: { deleted: true, id },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Test Policy
// ============================================================================

const TestPolicySchema = z.object({
  input: z.unknown(),
  variables: z.record(z.string(), z.unknown()).optional(),
  workflowId: z.string().optional(),
});

app.post('/:id/test', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');
  const id = c.req.param('id');

  try {
    const body = await c.req.json();

    // R5.high-1: org_id required to prevent cross-tenant policy testing by id-guessing.
    const org_id: string | undefined = typeof body?.org_id === 'string' ? body.org_id : undefined;
    if (!org_id) {
      return c.json({
        success: false,
        error: { code: 'ORG_ID_REQUIRED', message: 'org_id is required in the request body', requestId },
      }, 400);
    }

    const testData = TestPolicySchema.parse(body);

    const policy = await store.get(id, SYSTEM_SCOPE);
    if (!policy) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Policy not found: ${id}`,
          requestId,
        },
      }, 404);
    }

    // Cross-tenant guard: reject if policy belongs to a different org.
    if (policy.orgId && policy.orgId !== org_id) {
      return c.json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Policy belongs to a different organisation', requestId },
      }, 403);
    }

    const evaluator = new PolicyEvaluator(store);
    const result = await evaluator.testPolicy(policy, testData);

    return c.json({
      success: true,
      data: result,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid test data',
          details: error.issues.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          requestId,
        },
      }, 400);
    }
    throw error;
  }
});

// ============================================================================
// Test Policy Without Saving (inline policy definition)
// ============================================================================

const TestInlinePolicySchema = z.object({
  policy: PolicyDefinitionSchema,
  input: z.unknown(),
  variables: z.record(z.string(), z.unknown()).optional(),
  workflowId: z.string().optional(),
});

app.post('/test', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('policyStore');

  try {
    const body = await c.req.json();

    // R5.high-1: org_id required so inline tests are scoped to the caller's tenant.
    const org_id: string | undefined = typeof body?.org_id === 'string' ? body.org_id : undefined;
    if (!org_id) {
      return c.json({
        success: false,
        error: { code: 'ORG_ID_REQUIRED', message: 'org_id is required in the request body', requestId },
      }, 400);
    }

    const testData = TestInlinePolicySchema.parse(body);

    const evaluator = new PolicyEvaluator(store);
    const result = await evaluator.testPolicy(testData.policy, {
      input: testData.input,
      variables: testData.variables,
      workflowId: testData.workflowId,
    });

    return c.json({
      success: true,
      data: result,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid test data',
          details: error.issues.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          requestId,
        },
      }, 400);
    }
    throw error;
  }
});

export { app as policyRoutes };
