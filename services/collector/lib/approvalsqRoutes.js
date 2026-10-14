/**
 * ApprovalsQ collector routes (QVOICE-OUTBOUND #521 P1).
 *
 *   GET  /api/v1/approvalsq/escalations              user bearer, org-scoped
 *   POST /api/v1/approvalsq/escalations/:id/outcome  SERVICE KEY only (bridge callback)
 *
 * Neither route touches an approval item. The outcome route only records what
 * a phone call reported; the human already decided (or did not) on the call.
 * Auth is the collector default-deny gate plus the per-route middleware passed
 * in as `auth`; nothing here is allowlisted as public.
 */

'use strict';

function registerApprovalsqRoutes(app, { getStore, auth }) {
  app.get('/api/v1/approvalsq/escalations', auth(), (req, res) => {
    const store = getStore();
    if (!store) return res.status(503).json({ error: 'Escalation ledger not available' });
    // Org comes from the verified caller, never from a client-supplied value.
    // A service caller (no user) must name the org explicitly.
    const orgId = (req.user && (req.user.org_id || req.user.orgId)) ||
      (req.service === true && typeof req.query.org_id === 'string' ? req.query.org_id : null);
    if (!orgId) return res.status(400).json({ error: 'org_required' });
    return res.json({ escalations: store.listRecent(orgId, req.query.limit) });
  });

  app.post('/api/v1/approvalsq/escalations/:id/outcome', auth(), (req, res) => {
    if (req.service !== true) return res.status(403).json({ error: 'service_key_required' });
    const store = getStore();
    if (!store) return res.status(503).json({ error: 'Escalation ledger not available' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = store.recordOutcome(req.params.id, {
      outcome: body.outcome,
      decision: body.decision,
      call_sid: body.call_sid,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, escalation: result.escalation });
  });
}

module.exports = { registerApprovalsqRoutes };
