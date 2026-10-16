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
import { requireCallerOrg } from '../middleware/org-scope.js';

export interface SessionSearchRouteConfig {
  searchStore: SessionSearchStore;
}

export function createSessionSearchRoutes(config: SessionSearchRouteConfig) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rawQuery = c.req.query('query') ?? '';
    const rawLimit = c.req.query('limit');

    // Engagement 2026-10-16: the org is the caller's (requireCallerOrg). A user token searches only its JWT org (no
    // org claim is 401: it can never pick one with X-Org-ID); a service caller searches its X-Org-Id. The ?orgId
    // query param stays unread. Only with no auth context (dev/test) is the X-Org-ID header taken as the org.
    const hasUser = (c.get as any)('user') !== undefined;
    const who = requireCallerOrg(c as any, hasUser ? undefined : c.req.header('X-Org-ID'));
    if (!('orgId' in who)) {
      throw new ApiError(ErrorCodes.INTERNAL_ERROR, who.status === 400 ? 'Authentication required — org_id missing' : who.message, who.status === 400 ? 401 : who.status);
    }
    const orgId = who.orgId;

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
