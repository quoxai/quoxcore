/**
 * DEVSUITE 5.2 (2026-08-19): reusable licence gate for a plugin's data plane.
 *
 * WHY THIS EXISTS. The dev-suite plugins shipped with no server-side
 * entitlement check at all: 3 of 3 dev-servers routes, 12 of 12 slots routes
 * and 3 of 3 build routes served any authenticated org regardless of what it
 * had paid for. Paid plugins were being given away.
 *
 * The dashboard-side check is NOT a boundary. `isPluginLicensed` in the
 * frontend hides a sidebar item; it does nothing to stop anyone calling the
 * API directly, and the licence question has to be answered by the server or
 * it is not answered at all.
 *
 * The reference implementation is the QLarity proxy in server.js: resolve the
 * org, 401 with no org context, 403 when unlicensed, and FAIL CLOSED if the
 * entitlement lookup itself throws.
 *
 * That last part is the one worth defending. An entitlement check that opens
 * the gate when it errors is worse than no check, because it reads as
 * enforcement in review and evaporates under exactly the conditions an
 * attacker would enjoy: auth service down, network partition, malformed
 * response. Fail closed, always.
 *
 * Mount AFTER the authentication middleware so req already carries whatever
 * the org resolver needs (req.user.org_id for a user, or req.service plus an
 * org_id in the query/body for a service-to-service call such as quoxagent
 * posting a build receipt).
 */

/**
 * @param {object} deps
 * @param {(orgId: string, pluginId: string) => Promise<boolean>} deps.isPluginLicensed
 * @param {(req: object) => string|null} deps.resolveOrgId
 * @param {(orgId: string, pluginId: string) => Promise<{licensed: boolean, unavailable: boolean}>} [deps.licenseVerdict]
 *   when given, used instead of isPluginLicensed so "could not check" (auth
 *   unreachable, no usable cache) is a 503, not a false "not licensed" 403.
 * @returns {(pluginId: string, label: string) => Function} express middleware factory
 */
function createRequireLicence({ isPluginLicensed, resolveOrgId, licenseVerdict = null }) {
  if (typeof isPluginLicensed !== 'function') throw new TypeError('isPluginLicensed is required');
  if (typeof resolveOrgId !== 'function') throw new TypeError('resolveOrgId is required');

  return function requireLicence(pluginId, label) {
    if (!pluginId) throw new TypeError('pluginId is required');
    const name = label || pluginId;

    return async function licenceGate(req, res, next) {
      let orgId = null;
      try {
        orgId = resolveOrgId(req);
      } catch {
        orgId = null; // a resolver that throws is a missing org, never a pass
      }
      if (!orgId) {
        return res.status(401).json({ error: `Organisation context required for ${name}` });
      }

      // Fail closed either way, but keep the two closed states distinct
      // (2026-08-23 incident): during a collector redeploy the boot-window
      // lookup failure surfaced as "not licensed", a lie that clients
      // rightly treat as a permanent refusal. "We couldn't check" is a 503
      // the caller may retry; "you're not entitled" is the only 403.
      let licensed = false;
      try {
        if (licenseVerdict) {
          // The real lookup never throws: it returns unavailable instead.
          const v = await licenseVerdict(orgId, pluginId);
          if (v && v.unavailable) throw new Error('licence check unavailable');
          licensed = !!(v && v.licensed);
        } else {
          licensed = await isPluginLicensed(orgId, pluginId);
        }
      } catch {
        return res
          .status(503)
          .set('Retry-After', '5')
          .json({ error: `${name} licence check unavailable, retry shortly` });
      }

      if (!licensed) {
        return res.status(403).json({ error: `${name} is not licensed for this organisation` });
      }
      return next();
    };
  };
}

module.exports = { createRequireLicence };
