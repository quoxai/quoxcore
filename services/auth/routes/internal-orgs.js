/**
 * TRUST-GATE-1.23 — internal live-org enumeration endpoint
 *
 * GET /api/internal/orgs/list
 *
 * Returns the id of every live (non-deleted) org. Added specifically so the
 * collector's memoryConsolidationScheduler can enumerate real tenants instead
 * of hardcoding orgIds=['default'] — before this endpoint existed, only that
 * one hardcoded org ever received server-side memory consolidation.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used
 * by services/auth/routes/internal-tool-definitions.js. Fails CLOSED when
 * INTERNAL_SERVICE_KEY is not configured.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying orgs/list request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.get('/orgs/list', (req, res) => {
  const db = req.db || getDb();

  let rows;
  try {
    rows = db.prepare('SELECT id FROM orgs WHERE deleted_at IS NULL ORDER BY id').all();
  } catch (err) {
    console.error('[internal-orgs] DB query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }

  const orgIds = rows.map(r => r.id);
  return res.json({ ok: true, count: orgIds.length, orgIds });
});

/**
 * GET /api/internal/orgs/:orgId/plan
 * Service-key gated. Returns the org's plan so downstream services can derive
 * entitlement tiers from it (first consumer: the memory service's quota tier
 * sync, quox#571 part 2 — enterprise orgs were silently living under free
 * memory limits because nothing ever carried the plan across).
 */
router.get('/orgs/:orgId/plan', (req, res) => {
  const db = req.db || getDb();
  let row;
  try {
    row = db.prepare('SELECT id, plan, plan_expires_at FROM orgs WHERE id = ? AND deleted_at IS NULL')
      .get(req.params.orgId);
  } catch (err) {
    console.error('[internal-orgs] plan query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
  if (!row) return res.status(404).json({ error: 'org_not_found' });
  return res.json({ ok: true, org_id: row.id, plan: row.plan || 'free', plan_expires_at: row.plan_expires_at || null });
});

export default router;
