/**
 * LICENSE-LAUNCH LL-6d — reusable entitlement gate for a collector-native
 * plugin route module.
 *
 * WHY THIS EXISTS. The LE-3f catch-all proxy (server.js
 * `app.all('/api/v1/plugins/:pluginId/*')`) gates every backend-shaped plugin
 * at once — but only plugins reached THROUGH that prefix. A handful of governed
 * products ship their own collector route module mounted elsewhere
 * (routes/github-proxy.js at /github, routes/quoxbox-proxy.js at /api/quoxbox,
 * routes/discord-pro.js at /api/discord-pro, routes/quoxlens.js at
 * /api/v1/lens). Those routers never cross the proxy gate, so LL-6c's coverage
 * guard flagged all four as ACKNOWLEDGED_UNGATED_FAMILIES. This is the gate that
 * closes them.
 *
 * It is the LE-3f proxy's own check lifted verbatim into middleware so the four
 * mount points can share it and it can be unit-tested away from server.js (a
 * single-file monolith with an unconditional listen() and no exports):
 *
 *   - Only USER-originated requests are gated. requireServiceOrUserAuth() sets
 *     req.user for a JWT/qmcp_* caller and req.service for a pure
 *     INTERNAL_SERVICE_KEY caller. A service-key call is internal-to-internal,
 *     already inside the trust boundary, and bypasses — same carve-out the
 *     plugin storage and backend-proxy gates make for req.service.
 *   - A user token with no org_id is DENIED (402 no_org_context), never waved
 *     through — the LE-AUDIT HIGH lesson from the LE-3f proxy.
 *   - The refusal is 402 { error: 'LICENSE_REQUIRED', plugin } — the same
 *     machine-readable body the proxy and storage gates return, not the prose
 *     403 the nucleus/qlarity proxies happen to use, so a client sees ONE
 *     licensing contract across every collector surface.
 *   - FAIL CLOSED: a lookup that throws is treated as unlicensed, never as a
 *     pass. An entitlement check that opens on error reads as enforcement and
 *     evaporates under exactly the conditions an attacker enjoys.
 *
 * Mount AFTER requireServiceOrUserAuth() so req already carries req.user /
 * req.service.
 *
 * PLUGIN-IMG #1012 (owner decision 2026-10-15): a LAPSED licence gets 14 days
 * read-only. Auth's has-plugin reports `read_only_until` for a lease that
 * lapsed inside the window; while now < read_only_until, GET/HEAD/OPTIONS
 * pass and writes get 402 LICENSE_LAPSED_READ_ONLY ("licence lapsed,
 * read-only until <date>"). After it, everything is 402 LICENSE_REQUIRED.
 * A missing or unparseable date is no grace (fail closed). Data is kept.
 */

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

'use strict';

/**
 * @param {object} deps
 * @param {(orgId: string, pluginId: string) => Promise<boolean>} deps.isPluginLicensed
 * @returns {(pluginId: string) => Function} express middleware factory
 */
function createRequirePluginEntitlement({ isPluginLicensed, licenseVerdict, now = Date.now }) {
  if (typeof isPluginLicensed !== 'function') throw new TypeError('isPluginLicensed is required');

  return function requirePluginEntitlement(pluginId) {
    if (!pluginId) throw new TypeError('pluginId is required');

    return async function pluginEntitlementGate(req, res, next) {
      // Pure service-key internal calls (req.service, no req.user) bypass —
      // identical to the LE-3f catch-all proxy.
      if (req.user) {
        if (!req.user.org_id) {
          return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId, reason: 'no_org_context' });
        }
        let licensed = false;
        let readOnlyUntil = null;
        try {
          if (typeof licenseVerdict === 'function') {
            // GRIPE-784: still fail closed, but an auth outage (no stale cache)
            // is "try again", not "you have no licence".
            const v = await licenseVerdict(req.user.org_id, pluginId);
            if (v && v.unavailable) {
              return res.status(503).json({ error: 'LICENSE_CHECK_UNAVAILABLE', plugin: pluginId, retryable: true });
            }
            licensed = !!(v && v.licensed);
            if (!licensed && v && typeof v.readOnlyUntil === 'string') readOnlyUntil = v.readOnlyUntil;
          } else {
            licensed = await isPluginLicensed(req.user.org_id, pluginId);
          }
        } catch (_) {
          licensed = false; // fail closed
          readOnlyUntil = null;
        }
        if (!licensed && readOnlyUntil) {
          const untilMs = Date.parse(readOnlyUntil);
          if (Number.isFinite(untilMs) && now() < untilMs) {
            const method = String(req.method || 'GET').toUpperCase();
            if (READ_ONLY_METHODS.has(method)) return next();
            const until = new Date(untilMs).toISOString();
            return res.status(402).json({
              error: 'LICENSE_LAPSED_READ_ONLY',
              plugin: pluginId,
              read_only_until: until,
              message: `licence lapsed, read-only until ${until.slice(0, 10)}`,
            });
          }
        }
        if (!licensed) {
          return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId });
        }
      }
      return next();
    };
  };
}

module.exports = { createRequirePluginEntitlement };
