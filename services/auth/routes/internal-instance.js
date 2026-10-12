/**
 * QUOXPERTICUS P0b (DEC-1, DEC-4) — internal instance-property read endpoint
 *
 * GET /api/internal/instance/disposable-test
 *
 * Answers "is this whole instance a throwaway sandbox, and if so is the
 * test-approver lease still live?" for the collector's approval gate. Both
 * disposable_test and test_approver_lease_until are SERVER-SIDE instance
 * properties, never client-supplied claims, so the gate reads them from here
 * rather than trusting anything in the request it is deciding on. The lease
 * (DEC-4) is what keeps the relaxation leased/expiring rather than latched;
 * this endpoint returns the raw expiry string and leaves the expiry
 * evaluation to the collector.
 *
 * P1 adds quoxperticus_mode: the per-instance resident-agent operating level
 * (OFF|OBSERVE|PARTIAL|FULL), already CAPPED here (a stored FULL resolves to
 * PARTIAL unless the instance is disposable_test), so every consumer of this
 * endpoint sees the mode it is actually allowed to honor, never a raw FULL it
 * would have to remember to cap itself.
 *
 * Read-only. All three fields are human-admin-writable only (PATCH
 * /admin/config/:key behind requireInstanceAdmin — no service/agent path), so a
 * resident agent cannot flip its own sandbox status, extend its own lease, or
 * raise its own mode. Fail-safe: an absent or unreadable row reads as
 * false/null/OFF, so the relaxation is never granted by accident.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used by
 * services/auth/routes/internal-orgs.js. Fails CLOSED when INTERNAL_SERVICE_KEY
 * is not configured.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { isDisposableTestInstance, getTestApproverLeaseUntil, getQuoxperticusMode, getQuoxperticusOrgId } from '../lib/quoxperticusInstance.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying instance/disposable-test request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.get('/instance/disposable-test', (req, res) => {
  const db = req.db || getDb();
  return res.json({
    disposable_test: isDisposableTestInstance(db),
    test_approver_lease_until: getTestApproverLeaseUntil(db),
    quoxperticus_mode: getQuoxperticusMode(db),
    quoxperticus_org_id: getQuoxperticusOrgId(db),
    // CROSS-ORG LEAK FIX (2026-08-15): the org QuoxPlan is served to, until
    // per-org roadmaps land. Read from instance_config; null = unconfigured
    // and every consumer fails closed.
    quoxplan_owner_org_id: (db.prepare("SELECT value FROM instance_config WHERE key = 'quoxplan.owner_org_id'").get() || {}).value || null,
    // quox#642 — instance-operator-org fallback: lets fleet hosts that
    // heartbeat WITHOUT an org_id still route their skill-pack-install HITL
    // approval to a human, mirroring quoxplan_owner_org_id exactly. Read from
    // instance_config; null = unconfigured and the collector defers instead
    // of guessing an org.
    fleet_operator_org_id: (db.prepare("SELECT value FROM instance_config WHERE key = 'fleet.operator_org_id'").get() || {}).value || null,
  });
});

export default router;
