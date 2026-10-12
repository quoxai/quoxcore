/**
 * tool-search.js — Catalog search route.
 *
 * POST /api/tools/search
 *   Body: { query: string, limit?: number, filters?: { subcategory?, executor_type?, source_list? } }
 *   Returns: { matches: Array<{ id, name, description, subcategory, category, reference, source_list, score }>,
 *               total_in_catalog: number, query_time_ms: number }
 *
 * Auth: requireAuth (user session).
 * Powers the Toolsmith `search_catalog` tool and the upcoming library sidebar.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchCatalog } from '../lib/toolCatalogIndex.js';

const router = Router();

// Short-circuits if req.user already populated (test injection).
// Mirrors the pattern in routes/powers.js.
function requireUserAuth(req, res, next) {
  if (req.user) return next();
  return requireAuth(req, res, next);
}

router.use(requireUserAuth);

router.post('/tools/search', (req, res) => {
  const start = Date.now();

  const { query, limit, filters } = req.body || {};

  // Validate query
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({
      error: 'query_required',
      message: 'query must be a non-empty string',
    });
  }

  // Validate limit
  const parsedLimit = limit !== undefined ? Number(limit) : 20;
  if (limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return res.status(400).json({
      error: 'invalid_limit',
      message: 'limit must be a positive number (1-50)',
    });
  }

  // Validate filters shape
  if (filters !== undefined && (typeof filters !== 'object' || Array.isArray(filters))) {
    return res.status(400).json({
      error: 'invalid_filters',
      message: 'filters must be an object',
    });
  }

  try {
    const result = searchCatalog(query.trim(), {
      limit: parsedLimit,
      filters: filters || {},
    });

    return res.json({
      matches:          result.matches,
      total_in_catalog: result.total_in_catalog,
      query_time_ms:    Date.now() - start,
    });
  } catch (err) {
    console.error('[tool-search] Search failed:', err.message);
    return res.status(500).json({
      error:   'search_failed',
      message: 'Internal search error',
    });
  }
});

export default router;
