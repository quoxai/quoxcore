/**
 * QSKL-13 — /api/session-search route
 *
 * GET /api/session-search?query=<text>&limit=<n>
 *
 * Executes FTS search over the envelopes table via sessionSearchHandler.
 * org_id is resolved from (in priority order):
 *   1. JWT context (c.get('user').org_id) when auth is enabled
 *   2. X-Org-ID header (internal service callers with INTERNAL_SERVICE_KEY)
 *
 * The ?orgId query param fallback has been removed — it was a multi-tenant
 * leak vector (any caller could pass any org).
 *
 * Returns the sessionSearchHandler result directly.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { sessionSearchHandler } from '../../agentic/session-search-actions.js';
import type { SessionSearchStore } from '../../agentic/session-search-actions.js';
import { ApiError, ErrorCodes } from '../middleware/error-handler.js';

export interface SessionSearchRouteConfig {
  searchStore: SessionSearchStore;
}

export function createSessionSearchRoutes(config: SessionSearchRouteConfig) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rawQuery = c.req.query('query') ?? '';
    const rawLimit = c.req.query('limit');

    // org_id: JWT is the primary source. X-Org-ID header is the secondary source
    // for internal service callers (collector → quoxflow, validated by X-Service-Key).
    // The ?orgId query param fallback is intentionally absent — it allowed any
    // unauthenticated caller to cross org boundaries.
    // Empty org (no JWT, no header) → 401. No 'default' fallback.
    const jwtUser = (c.get as any)('user') as { org_id?: string } | undefined;
    const jwtOrgId = jwtUser?.org_id;
    const headerOrgId = c.req.header('X-Org-ID');

    // Resolve org — must come from JWT or X-Org-ID header. Never from query params.
    let orgId: string;
    if (jwtOrgId && jwtOrgId !== 'default' && jwtOrgId.length > 0) {
      orgId = jwtOrgId;
    } else if (headerOrgId && headerOrgId.length > 0) {
      orgId = headerOrgId;
    } else {
      // No valid org source available — reject.
      throw new ApiError(ErrorCodes.INTERNAL_ERROR, 'Authentication required — org_id missing', 401);
    }

    const result = await sessionSearchHandler({
      orgId,
      params: {
        query: rawQuery,
        ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
      },
      searchStore: config.searchStore,
    });

    return c.json(result);
  });

  return app;
}
