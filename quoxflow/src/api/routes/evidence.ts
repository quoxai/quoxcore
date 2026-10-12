/**
 * Evidence API Routes
 *
 * Endpoints for retrieving and managing evidence records.
 *
 * QF-MT WP5: every endpoint resolves the caller's org scope and passes it to
 * the (now org-scoped) EvidenceStore reads/writes. Cross-org by-id access
 * 404s (never a thrown 403) — matches the plan's "hide existence" rule.
 * `/:id/content` (raw byte stream) and `DELETE /:id` are scoped the same way.
 */

import { Hono } from 'hono';
import { EvidenceType } from '../../evidence/index.js';
import { envelopes, Intents } from '../../core/envelope.js';
import { AppEnv } from '../types.js';
import { resolveOrgScope, SYSTEM_SCOPE, OrgScope } from '../middleware/org-scope.js';

/** QF-MT WP5: see the identical helper in executions.ts/envelopes.ts. */
function toStoreScope(scope: OrgScope): string | typeof SYSTEM_SCOPE {
  return scope.kind === 'system' ? SYSTEM_SCOPE : scope.orgId;
}

const app = new Hono<AppEnv>();

// ============================================================================
// List Evidence
// ============================================================================

app.get('/', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const storeScope = toStoreScope(resolveOrgScope(c));

  const corr = c.req.query('corr');
  const envelopeId = c.req.query('envelopeId');
  const workflowId = c.req.query('workflowId');
  const executionId = c.req.query('executionId');
  const type = c.req.query('type') as EvidenceType | undefined;
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const options = {
    correlationId: corr,
    envelopeId,
    workflowId,
    executionId,
    type,
    limit: Math.min(limit, 1000),
    offset,
  };

  const [records, total] = await Promise.all([
    store.list(options, storeScope),
    store.count({
      correlationId: corr,
      envelopeId,
      workflowId,
      executionId,
      type,
    }, storeScope),
  ]);

  return c.json({
    success: true,
    data: records,
    pagination: {
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + records.length < total,
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Evidence by ID
// ============================================================================

app.get('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const id = c.req.param('id');
  const storeScope = toStoreScope(resolveOrgScope(c));

  const record = await store.get(id, storeScope);

  if (!record) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Evidence not found: ${id}`,
          requestId,
        },
      },
      404
    );
  }

  return c.json({
    success: true,
    data: record,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Evidence Content
// ============================================================================

app.get('/:id/content', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const id = c.req.param('id');
  const storeScope = toStoreScope(resolveOrgScope(c));

  const record = await store.get(id, storeScope);

  if (!record) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Evidence not found: ${id}`,
          requestId,
        },
      },
      404
    );
  }

  const content = await store.getContent(id, storeScope);

  if (!content) {
    return c.json(
      {
        success: false,
        error: {
          code: 'CONTENT_NOT_FOUND',
          message: `Evidence content not found: ${id}`,
          requestId,
        },
      },
      404
    );
  }

  // Set content type and disposition headers
  c.header('Content-Type', record.contentType);
  c.header('Content-Length', String(content.length));
  c.header('X-Evidence-Hash', record.hash);
  c.header('Content-Disposition', `inline; filename="${id}"`);

  return c.body(new Uint8Array(content));
});

// ============================================================================
// Get Evidence by Envelope ID
// ============================================================================

app.get('/envelope/:envelopeId', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const envelopeId = c.req.param('envelopeId');
  const storeScope = toStoreScope(resolveOrgScope(c));

  const records = await store.getByEnvelopeId(envelopeId, storeScope);

  return c.json({
    success: true,
    data: records,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Get Evidence by Correlation ID
// ============================================================================

app.get('/correlation/:correlationId', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const correlationId = c.req.param('correlationId');
  const storeScope = toStoreScope(resolveOrgScope(c));

  const records = await store.getByCorrelationId(correlationId, storeScope);

  return c.json({
    success: true,
    data: records,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Delete Evidence
// ============================================================================

app.delete('/:id', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');
  const id = c.req.param('id');
  const scope = resolveOrgScope(c);
  const storeScope = toStoreScope(scope);

  const deleted = await store.delete(id, storeScope);

  if (!deleted) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Evidence not found: ${id}`,
          requestId,
        },
      },
      404
    );
  }

  // AEE audit envelope
  try {
    const es = c.get('envelopeStore');
    if (es) await es.append(envelopes.event(Intents.EVIDENCE.DELETED, requestId, { evidenceId: id }), storeScope);
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
// Delete Expired Evidence (Admin Endpoint)
// ============================================================================

app.post('/admin/cleanup', async (c) => {
  const requestId = c.get('correlationId');
  const store = c.get('evidenceStore');

  // Deliberately cross-org — a maintenance sweep over expired rows in every
  // tenant, not a tenant-data read (mirrors deleteExpired()'s own docstring).
  const deletedCount = await store.deleteExpired();

  // AEE audit envelope
  try {
    const es = c.get('envelopeStore');
    if (es) await es.append(envelopes.event(Intents.EVIDENCE.CLEANED, requestId, { deletedCount }));
  } catch { /* fire-and-forget */ }

  return c.json({
    success: true,
    data: { deletedCount },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

export { app as evidenceRoutes };
