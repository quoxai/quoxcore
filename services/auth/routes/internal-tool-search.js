/**
 * AGENT-OVERHAUL — internal (service-to-service) tool catalog search for the
 * Quartermaster agent's search_catalog tool
 * (services/collector/lib/agentTools.js).
 *
 * The user-facing POST /api/tools/search (routes/tool-search.js) requires
 * requireAuth (browser JWT) and sits behind the global CSRF double-submit
 * gate. Agent tool calls run server-to-server with no browser session, so
 * they can never carry a CSRF cookie/header pair — search_catalog 403'd
 * with "Missing CSRF token header".
 *
 * This internal route is service-key gated (X-Service-Key) and CSRF-exempt
 * (mounted under /api/internal/, already exempt in middleware/csrf.js) —
 * identical auth mechanism to routes/internal-backups.js. The underlying
 * catalog (lib/toolCatalogIndex.js) is a static, non-org-scoped index (the
 * same 3198-entry library every org sees), so there is no cross-org data to
 * leak here; org_id is still required and threaded through for parity with
 * the other internal routes and for audit/rate-limiting hooks, never used
 * to widen access.
 *
 *   POST /api/internal/tools/search { org_id, query, limit?, filters? }
 */

import { Router } from 'express';
import { safeCompare } from '../utils/crypto.js';
import { searchCatalog } from '../lib/toolCatalogIndex.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying internal tool-search request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.post('/tools/search', (req, res) => {
  const start = Date.now();
  const { org_id, query, limit, filters } = req.body || {};

  if (!org_id) {
    return res.status(400).json({ error: 'org_id_required', message: 'org_id must be supplied by the caller' });
  }
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'query_required', message: 'query must be a non-empty string' });
  }

  const parsedLimit = limit !== undefined ? Number(limit) : 20;
  if (limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return res.status(400).json({ error: 'invalid_limit', message: 'limit must be a positive number (1-50)' });
  }
  if (filters !== undefined && (typeof filters !== 'object' || Array.isArray(filters))) {
    return res.status(400).json({ error: 'invalid_filters', message: 'filters must be an object' });
  }

  try {
    const result = searchCatalog(query.trim(), { limit: parsedLimit, filters: filters || {} });
    return res.json({
      matches: result.matches,
      total_in_catalog: result.total_in_catalog,
      query_time_ms: Date.now() - start,
    });
  } catch (err) {
    console.error('[internal-tool-search] search failed:', err.message);
    return res.status(500).json({ error: 'search_failed', message: 'Internal search error' });
  }
});

export default router;
