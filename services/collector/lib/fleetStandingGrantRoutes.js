/**
 * Fleet standing grant routes (owner decision 2026-10-13).
 *
 *   GET  /api/v1/approvals/grants                     user bearer, org-scoped (?all=1 includes revoked/expired)
 *   POST /api/v1/approvals/grants                     HUMAN org admin only (never a service key or agent)
 *   POST /api/v1/approvals/grants/:id/revoke          HUMAN org admin only
 *   POST /api/internal/fleet-standing-grants/check    SERVICE KEY only (auth mint-standing callback)
 *
 * Org always comes from the verified caller (or, for the service callback, the
 * body the auth service sends), never from a client-chosen value on user routes.
 */

'use strict';

const fsg = require('./fleetStandingGrants.js');

function userOrg(req) {
  return (req.user && (req.user.org_id || req.user.orgId)) || null;
}

async function defaultResolveHost(h) { return require('./agentTools.js').resolveHostId(h); }

function registerFleetStandingGrantRoutes(app, { auth, requireHumanAdmin, resolveHost = defaultResolveHost }) {
  app.get('/api/v1/approvals/grants', auth(), (req, res) => {
    const orgId = userOrg(req) || (req.service === true && typeof req.query.org_id === 'string' ? req.query.org_id : null);
    if (!orgId) return res.status(400).json({ error: 'org_required' });
    try {
      return res.json({ grants: fsg.listGrants(orgId, { includeInactive: req.query.all === '1' || req.query.all === 'true' }) });
    } catch (e) { return res.status(503).json({ error: 'standing grant store unavailable' }); }
  });

  app.post('/api/v1/approvals/grants', auth(), (req, res) => {
    if (!requireHumanAdmin(req, res, 'Only a human org admin can create a standing grant')) return undefined;
    const orgId = userOrg(req);
    if (!orgId) return res.status(400).json({ error: 'org_required' });
    const v = fsg.validateGrant(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      return res.status(201).json({ grant: fsg.createGrant(orgId, v.ok, String(req.user.id || req.user.sub || 'unknown')) });
    } catch (e) { return res.status(503).json({ error: 'standing grant store unavailable' }); }
  });

  app.post('/api/v1/approvals/grants/:id/revoke', auth(), (req, res) => {
    if (!requireHumanAdmin(req, res, 'Only a human org admin can revoke a standing grant')) return undefined;
    const orgId = userOrg(req);
    if (!orgId) return res.status(400).json({ error: 'org_required' });
    const g = fsg.revokeGrant(orgId, String(req.params.id), String(req.user.id || req.user.sub || 'unknown'));
    if (!g) return res.status(404).json({ error: 'not_found' });
    return res.json({ grant: g });
  });

  app.post('/api/internal/fleet-standing-grants/check', auth(), async (req, res) => {
    if (req.service !== true) return res.status(403).json({ error: 'service_key_required' });
    const b = req.body || {};
    let resolvedHost = null;
    try { resolvedHost = typeof b.host === 'string' && b.host ? await resolveHost(b.host) : null; } catch { resolvedHost = null; }
    const out = fsg.checkGrant({ orgId: b.org_id, grantId: b.standing_grant_id, host: b.host, command: b.command, tool: b.tool || 'ssh_exec', targets: b.targets, resolvedHost });
    return res.json({ success: true, allowed: out.allowed === true, ...(out.reason ? { reason: out.reason } : {}) });
  });
}

module.exports = { registerFleetStandingGrantRoutes };
