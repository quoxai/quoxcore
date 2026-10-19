'use strict';

/**
 * agentFetchAllowlistRoutes.js — admin surface for the agent fetch allowlist
 * (quox#1171). Reads: any authenticated org member. Writes: human org admin
 * only (requireHumanAdmin refuses agent tokens, agent-operated sessions and
 * service keys). The org comes from the authenticated caller's token and
 * nowhere else: a body or query org is ignored, so a caller cannot write to
 * or read another org's list.
 */

const net = require('net');
const { isPrivateIp, alwaysDeniedIpReason, interfaceCidrs, isSingleLabelHost } = require('./agentFetchEgressPolicy');

/**
 * HYPERION NO-GO fix (2026-10-16): a tenant org admin may NOT allowlist a private range (RFC1918,
 * CGNAT, ULA); only an INSTANCE admin may, and their entries are recorded allow_private. Nobody may
 * allowlist an always-denied target (the collector's own networks, Docker bridge ranges, loopback,
 * metadata) or a single-label host (a container/service name). Hostnames are judged again at fetch
 * time on every resolved address (lib/allowlistedFetchTool.js), so a later DNS change cannot reach
 * a private or internal address through a tenant's entry.
 */
function prefixHost(prefix) {
  try { return new URL(String(prefix).trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

function registerAgentFetchAllowlistRoutes(app, { auth, requireHumanAdmin, store, audit = () => {}, checkInstanceAdmin = async () => 'no', networkInterfaces }) {
  const orgOf = (req) => (req.user && req.user.org_id) || null;
  const actorOf = (req) => `human.${(req.user && (req.user.id || req.user.sub)) || 'unknown'}`;
  const emit = (e) => { try { audit(e); } catch (err) { console.error('[fetch-allowlist] audit failed:', err.message); } };

  app.get('/api/v1/fetch-allowlist', auth(), (req, res) => {
    const orgId = orgOf(req);
    if (!orgId) return res.status(401).json({ error: 'Organisation context required' });
    try {
      res.json({ prefixes: store.listPrefixes({ orgId }), policy: 'default-deny' });
    } catch (err) {
      console.error('[fetch-allowlist] list failed:', err.message);
      res.status(500).json({ error: 'list failed' });
    }
  });

  app.post('/api/v1/fetch-allowlist', auth(), async (req, res) => {
    if (!requireHumanAdmin(req, res, 'Changing the agent fetch allowlist requires a human org admin')) return;
    const orgId = orgOf(req);
    if (!orgId) return res.status(401).json({ error: 'Organisation context required' });
    const actor = actorOf(req);
    const { url_prefix: prefix, note } = req.body || {};
    const host = prefixHost(prefix);
    if (host && isSingleLabelHost(host)) {
      return res.status(400).json({ error: 'always_denied', message: `${host} is a single-label name (a container or service name); it can never be allowlisted.` });
    }
    const literalIp = host && net.isIP(host) ? host : null;
    if (literalIp) {
      const why = alwaysDeniedIpReason(literalIp, interfaceCidrs(networkInterfaces || undefined));
      if (why) return res.status(400).json({ error: 'always_denied', message: `${why}; it can never be allowlisted.` });
    }
    let instance = 'no';
    try { instance = await checkInstanceAdmin(req); } catch { instance = 'unavailable'; }
    if (literalIp && isPrivateIp(literalIp) && instance !== 'yes') {
      if (instance === 'unavailable') return res.status(503).json({ error: 'instance_admin_check_unavailable', message: 'Could not confirm instance admin; nothing changed, try again.' });
      return res.status(403).json({ error: 'instance_admin_required', message: `${literalIp} is a private address; only an instance admin can allowlist a private range.` });
    }
    try {
      const result = store.addPrefix({ orgId, prefix, addedBy: actor, note, allowPrivate: instance === 'yes' });
      if (!result.ok) return res.status(400).json({ error: 'bad_prefix', message: result.reason });
      emit({
        type: 'event', from: actor, to: 'audit.system', intent: 'agent.fetch.allowlist.added',
        corr: `FETCH_ALLOWLIST_${orgId}`, payload: { org_id: orgId, url_prefix: result.entry.url_prefix, allow_private: result.entry.allow_private },
      });
      res.status(201).json({ entry: result.entry, prefixes: store.listPrefixes({ orgId }) });
    } catch (err) {
      console.error('[fetch-allowlist] add failed:', err.message);
      res.status(500).json({ error: 'add failed' });
    }
  });

  app.delete('/api/v1/fetch-allowlist', auth(), (req, res) => {
    if (!requireHumanAdmin(req, res, 'Changing the agent fetch allowlist requires a human org admin')) return;
    const orgId = orgOf(req);
    if (!orgId) return res.status(401).json({ error: 'Organisation context required' });
    const actor = actorOf(req);
    const prefix = req.query.url_prefix || (req.body || {}).url_prefix;
    try {
      const result = store.removePrefix({ orgId, prefix });
      emit({
        type: 'event', from: actor, to: 'audit.system', intent: 'agent.fetch.allowlist.removed',
        corr: `FETCH_ALLOWLIST_${orgId}`, payload: { org_id: orgId, url_prefix: result.prefix, removed: result.removed },
      });
      res.json({ removed: result.removed, prefixes: store.listPrefixes({ orgId }) });
    } catch (err) {
      console.error('[fetch-allowlist] remove failed:', err.message);
      res.status(500).json({ error: 'remove failed' });
    }
  });
}

module.exports = { registerAgentFetchAllowlistRoutes };
