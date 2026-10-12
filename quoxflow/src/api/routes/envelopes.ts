/**
 * Envelope Routes
 *
 * Audit trail queries and causality chain traversal.
 */

import { Hono } from 'hono';
import { AppEnv } from '../types.js';
import { z } from 'zod';
import { validateQuery, validateParams, PaginationQuerySchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes } from '../middleware/error-handler.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { resolveOrgScope, SYSTEM_SCOPE } from '../middleware/org-scope.js';
import type { OrgScope } from '../middleware/org-scope.js';

/** QF-MT WP5: see the identical helper in executions.ts. */
function toStoreScope(scope: OrgScope): string | typeof SYSTEM_SCOPE {
  return scope.kind === 'system' ? SYSTEM_SCOPE : scope.orgId;
}

// Request schemas
const QueryEnvelopesSchema = PaginationQuerySchema.extend({
  corr: z.string().optional(),
  // execution_id is an alias for corr — Sentinel and external callers may use
  // either form. The envelope store filters by the corr field, which holds the
  // correlationId of the execution that produced the envelope.
  execution_id: z.string().optional(),
  intent: z.string().optional(),
  type: z.enum(['task', 'result', 'event', 'error', 'stream']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
}).transform(data => ({
  ...data,
  limit: Math.min(data.limit, 1000), // Cap at 1000 for envelopes
  // Normalise: execution_id is treated as corr if corr not supplied
  corr: data.corr ?? data.execution_id,
}));

const EnvelopeIdSchema = z.object({
  id: z.string().length(26), // ULID length
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

export function createEnvelopeRoutes(deps: { envelopeStore: EnvelopeStore }) {
  const app = new Hono<AppEnv>();

  // GET /api/envelopes - Query envelopes
  app.get('/', validateQuery(QueryEnvelopesSchema), async c => {
    const storeScope = toStoreScope(resolveOrgScope(c));
    const query = c.get('validatedQuery') as z.infer<typeof QueryEnvelopesSchema>;

    const envelopes = await deps.envelopeStore.query({
      corr: query.corr,
      intent: query.intent,
      type: query.type,
      since: query.since,
      until: query.until,
      limit: query.limit,
      offset: query.offset,
    }, storeScope);

    const total = await deps.envelopeStore.count({
      corr: query.corr,
      intent: query.intent,
      type: query.type,
      since: query.since,
      until: query.until,
    }, storeScope);

    return paginated(c, envelopes, { total, limit: query.limit, offset: query.offset });
  });

  // GET /api/envelopes/:id - Get single envelope
  app.get('/:id', validateParams(EnvelopeIdSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof EnvelopeIdSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));
    const envelope = await deps.envelopeStore.get(id, storeScope);

    if (!envelope) {
      throw new NotFoundError(ErrorCodes.ENVELOPE_NOT_FOUND, `Envelope ${id} not found`);
    }

    return success(c, envelope);
  });

  // GET /api/envelopes/:id/chain - Get causality chain
  app.get('/:id/chain', validateParams(EnvelopeIdSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof EnvelopeIdSchema>;
    const storeScope = toStoreScope(resolveOrgScope(c));

    // Verify envelope exists AND belongs to the caller (org-scoped get) —
    // cross-org start id 404s here, before the chain is ever traversed.
    const envelope = await deps.envelopeStore.get(id, storeScope);
    if (!envelope) {
      throw new NotFoundError(ErrorCodes.ENVELOPE_NOT_FOUND, `Envelope ${id} not found`);
    }

    // QF-MT WP5: chain traversal itself additionally omits any element that
    // turns out to be cross-org (defense-in-depth — see
    // EnvelopeStore.getCausalityChain()'s docstring for the omit-vs-404 choice).
    const chain = await deps.envelopeStore.getCausalityChain(id, storeScope);

    return success(c, {
      startId: id,
      rootId: chain[0]?.id,
      envelopes: chain,
      depth: chain.length,
    });
  });

  return app;
}
