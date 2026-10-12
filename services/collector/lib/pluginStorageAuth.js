/**
 * lib/pluginStorageAuth.js — LICENSE-LAUNCH LL-1b.
 *
 * Shared org-derivation + entitlement gate for the four plugin storage routes
 * (GET/PUT/DELETE /api/v1/plugins/:pluginId/storage/:key and
 * GET /api/v1/plugins/:pluginId/storage in server.js).
 *
 * Those routes are registered BEFORE the entitlement-gated backend proxy
 * (app.all('/api/v1/plugins/:pluginId/*'), LE-3f), so they match first and
 * never reached its gate. They also had no route-level auth at all and keyed
 * rows by a CLIENT-SUPPLIED org_id defaulting to 'default' — with the global
 * gate (utils/collectorAuthGate.js) in its default SHADOW mode that left
 * per-org plugin data readable and writable by anyone on the network, and even
 * under enforce any authenticated user of any org could name another org.
 *
 * Posture, mirroring resolveSlotOrgId() (server.js ~L807) for org derivation
 * and the LE-3f proxy block (server.js ~L24874) for entitlement:
 *   - req.user  → org is req.user.org_id ONLY; a client-supplied
 *     ?org_id / body org_id / x-org-id is IGNORED. No org_id on the token is
 *     402 no_org_context, not a wave-through.
 *   - req.service (pure INTERNAL_SERVICE_KEY caller, inside the trust
 *     boundary) → may name the org explicitly, and bypasses the entitlement
 *     check exactly as the proxy lets it. Naming no org is a 400.
 *   - Anything else → 401 (defence in depth behind requireServiceOrUserAuth()).
 * There is NO 'default' fallback on any path: resolveRequestOrgId's default
 * fallback is a flagged P0 and is deliberately not used here.
 *
 * Sets req.pluginStorageOrgId for the handlers.
 */

const { isPluginLicensed: defaultIsPluginLicensed } = require('./licenseGate.js');

/**
 * @param {{ isPluginLicensed?: (orgId: string, pluginId: string) => Promise<boolean> }} [deps]
 *   Entitlement resolver override (tests inject a stub; production uses the
 *   real auth-service-backed licenseGate client).
 */
function requirePluginStorageOrg(deps = {}) {
  const isLicensed = deps.isPluginLicensed || defaultIsPluginLicensed;

  return async (req, res, next) => {
    const pluginId = req.params?.pluginId;

    if (req.user) {
      if (!req.user.org_id) {
        return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId, reason: 'no_org_context' });
      }
      let licensed = false;
      try {
        licensed = await isLicensed(req.user.org_id, pluginId);
      } catch {
        licensed = false; // fail closed, same as licenseGate's own posture
      }
      if (!licensed) {
        return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId });
      }
      req.pluginStorageOrgId = req.user.org_id;
      return next();
    }

    if (req.service) {
      const named = req.query?.org_id || req.body?.org_id || req.headers?.['x-org-id'] || null;
      if (!named) {
        return res.status(400).json({ error: 'org_id required', plugin: pluginId });
      }
      req.pluginStorageOrgId = named;
      return next();
    }

    return res.status(401).json({ error: 'authentication_required' });
  };
}

module.exports = { requirePluginStorageOrg };
