/**
 * Free fleet allowance for the bastion-fleet surface.
 *
 * Owner ruling 2026-09-01: "Core is FREE. First 1-2 boxes FREE (+ the
 * controller). Charging starts at 3+ servers." The plain
 * requirePluginEntitlement('bastion-fleet') gate had no free allowance, so a
 * fresh public install got 402 LICENSE_REQUIRED on `quox fleet hosts` before
 * adding even one host.
 *
 * This wraps that gate: licensed orgs and service-key calls behave exactly as
 * before; an UNLICENSED org is allowed through while its managed host count
 * (controller excluded) is within FREE_FLEET_HOSTS. Adding a host (POST) is
 * allowed only while count < FREE_FLEET_HOSTS. Beyond that the usual 402
 * LICENSE_REQUIRED is returned, with a message naming the band. A failing host
 * lookup fails closed (503), never open.
 */
'use strict';

const FREE_FLEET_HOSTS = 2;
const FLEET_BAND_MESSAGE =
  '3 or more hosts needs a fleet licence: quox license (the first ' + FREE_FLEET_HOSTS +
  ' managed hosts, plus the controller, are free)';

function isController(h) {
  return !!h && (h.is_controller === true || h.controller === true || h.role === 'controller');
}

function countManagedHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).filter((h) => !isController(h)).length;
}

/**
 * @param {object} deps
 * @param {Function} deps.isPluginLicensed (orgId, pluginId) => Promise<boolean>
 * @param {Function} [deps.licenseVerdict] (orgId, pluginId) => Promise<{licensed, unavailable}>
 * @param {Function} deps.listHosts () => Promise<Array|null> (null = bastion not configured)
 */
function createFleetAllowanceGate({ isPluginLicensed, licenseVerdict, listHosts }) {
  if (typeof isPluginLicensed !== 'function') throw new TypeError('isPluginLicensed is required');
  if (typeof listHosts !== 'function') throw new TypeError('listHosts is required');

  return function fleetAllowanceGate(pluginId) {
    return async function gate(req, res, next) {
      if (!req.user) return next(); // pure service-key call, same carve-out as the entitlement gate
      const orgId = req.user.org_id;
      if (!orgId) {
        return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId, reason: 'no_org_context' });
      }
      try {
        if (typeof licenseVerdict === 'function') {
          const v = await licenseVerdict(orgId, pluginId);
          if (v && v.unavailable) {
            return res.status(503).json({ error: 'LICENSE_CHECK_UNAVAILABLE', plugin: pluginId, retryable: true });
          }
          if (v && v.licensed) return next();
        } else if (await isPluginLicensed(orgId, pluginId)) {
          return next();
        }
      } catch (_) {
        // fall through to the allowance check; the host count still bounds it
      }
      let count;
      try {
        const hosts = await listHosts();
        count = hosts == null ? 0 : countManagedHosts(hosts);
      } catch (_) {
        return res.status(503).json({ error: 'LICENSE_CHECK_UNAVAILABLE', plugin: pluginId, retryable: true });
      }
      const adding = String(req.method || 'GET').toUpperCase() === 'POST' && /\/hosts\/?$/.test(req.path || '/hosts');
      const projected = adding ? count + 1 : count;
      if (projected <= FREE_FLEET_HOSTS) return next();
      return res.status(402).json({
        error: 'LICENSE_REQUIRED',
        plugin: pluginId,
        message: FLEET_BAND_MESSAGE,
        freeHosts: FREE_FLEET_HOSTS,
        managedHosts: count,
      });
    };
  };
}

module.exports = { createFleetAllowanceGate, FREE_FLEET_HOSTS, FLEET_BAND_MESSAGE, countManagedHosts };
