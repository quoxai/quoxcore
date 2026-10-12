/**
 * VAULT-P6.I — internal WARD audit-content reconciliation endpoint
 *
 * GET /api/internal/ward/reconcile[?org_id=...]
 *
 * Closes FINDING P6-T4 (services/auth/tests/vault-adversarial.test.js,
 * docs/VAULT_THREAT_MODEL.md §6): verifyChain() alone cannot detect an
 * attacker rewriting audit_events content directly in auth.db. This route
 * exposes lib/wardAdapter.js's reconcileAuditChain() so it can be called
 * on-demand (or wired into a future cron) without a code deploy.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used
 * by routes/internal-orgs.js. Fails CLOSED when INTERNAL_SERVICE_KEY is not
 * configured.
 */

import { Router } from 'express';
import { reconcileAuditChain } from '../lib/wardAdapter.js';
import { safeCompare } from '../utils/crypto.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying ward/reconcile request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.get('/ward/reconcile', async (req, res) => {
  const orgId = req.query.org_id || null;

  try {
    const result = await reconcileAuditChain(orgId);
    const tampered = result.results.filter((r) => r.status === 'CONTENT_TAMPERED');
    const missing = result.results.filter((r) => r.status === 'MISSING');
    return res.json({
      ok: true,
      chain_id: result.chain_id,
      checked: result.checked,
      tampered_count: tampered.length,
      missing_count: missing.length,
      results: result.results,
    });
  } catch (err) {
    console.error('[VAULT-P6.I] ward/reconcile failed:', err.message);
    return res.status(500).json({ error: 'reconcile_failed', message: err.message });
  }
});

export default router;
