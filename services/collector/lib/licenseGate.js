/**
 * lib/licenseGate.js — LICENSE-ENFORCE LE-3f (collector data-plane gate).
 *
 * Collector-side client for the auth service's entitlement resolver, mirrors
 * services/tasks/lib/licenseGate.js's cache/stale-grace shape (see that file
 * for the fuller rollout/mode doc — this collector client is intentionally
 * simpler: every check goes through auth, fail-closed past the stale grace).
 *
 * Auth source of truth:
 *   GET ${AUTH_INTERNAL_URL}/api/setup/internal/has-plugin?org=<orgId>&plugin=<pluginId>
 *   Response: { licensed: boolean, tier: 'tier_a' | 'tier_b' | 'tier_c' | null }
 *   Auth header: x-service-key: INTERNAL_SERVICE_KEY (required — the
 *   internal-service-only endpoint 403s without it, see
 *   services/auth/utils/internalServiceAuth.js).
 *
 * Cache: 30s fresh TTL + 10min stale grace, keyed by `${orgId}:${pluginId}`.
 * Per-process, not Redis. A quox.ai/auth blip is absorbed by the grace
 * window; beyond it (or with no prior successful check), fail CLOSED — this
 * gates real revenue-bearing data-plane traffic (proxyToPlugin, QuoxChat),
 * so silence must never be interpreted as "licensed".
 */

const CACHE_TTL_MS = 30_000;
const STALE_GRACE_MS = 10 * 60_000; // 10 minutes past the fresh TTL

const cache = new Map(); // key -> { licensed, tier, expiresAt, staleUntil }

function getAuthUrl() {
  // Prefer AUTH_SERVICE_URL — the var the rest of quoxchat.js already uses to
  // reach auth. Accept AUTH_INTERNAL_URL as a fallback so a compose that sets
  // only one of them can't leave this gate pointing at the wrong host and
  // failing closed while domainGuard succeeds. (Compose silently substitutes
  // empty ${VAR}; one canonical var removes the footgun.)
  return process.env.AUTH_SERVICE_URL || process.env.AUTH_INTERNAL_URL || 'http://auth:3101';
}

function cacheKey(orgId, pluginId) {
  return `${orgId}:${pluginId}`;
}

/** Fresh (within TTL) cache read. */
function readCache(orgId, pluginId) {
  const entry = cache.get(cacheKey(orgId, pluginId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

/**
 * Stale-but-in-grace cache read — only consulted when a live auth fetch just
 * failed. Garbage-collects the entry once it's past the grace window too.
 */
function readStaleCache(orgId, pluginId) {
  const key = cacheKey(orgId, pluginId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.staleUntil) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(orgId, pluginId, value) {
  const now = Date.now();
  cache.set(cacheKey(orgId, pluginId), {
    ...value,
    expiresAt: now + CACHE_TTL_MS,
    staleUntil: now + CACHE_TTL_MS + STALE_GRACE_MS,
  });
}

async function fetchFromAuth(orgId, pluginId) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  const url = `${getAuthUrl()}/api/setup/internal/has-plugin?org=${encodeURIComponent(orgId)}&plugin=${encodeURIComponent(pluginId)}`;
  const res = await fetch(url, {
    headers: {
      ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
      'x-internal-call': '1',
    },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  return res.json();
}

/**
 * Returns { licensed: boolean, tier: string|null, ... }.
 * Never throws on transport errors — serves stale cache within grace, else
 * fails closed.
 */
async function checkPluginLicense(orgId, pluginId) {
  if (!orgId || !pluginId) {
    throw new Error('checkPluginLicense: orgId and pluginId required');
  }

  const cached = readCache(orgId, pluginId);
  if (cached) return { licensed: cached.licensed, tier: cached.tier, cached: true };

  try {
    const result = await fetchFromAuth(orgId, pluginId);
    const value = { licensed: !!result.licensed, tier: result.tier || null };
    writeCache(orgId, pluginId, value);
    return value;
  } catch (err) {
    const stale = readStaleCache(orgId, pluginId);
    if (stale) {
      console.warn(`[collector licenseGate] auth unreachable, serving STALE cache (grace) for ${orgId}:${pluginId}: ${err.message}`);
      return { licensed: stale.licensed, tier: stale.tier, error: err.message, stale: true };
    }
    console.warn(`[collector licenseGate] auth unreachable, no stale cache in grace — failing CLOSED for ${orgId}:${pluginId}: ${err.message}`);
    return { licensed: false, tier: null, error: err.message, failClosed: true };
  }
}

// LICENSE-LAUNCH LL-6d C5 — shared test override seam. Both the agent-level
// gate (lib/agentTools.js) and the capability choke (lib/connectors/bridge.js)
// route their entitlement checks through isPluginLicensed here, so a single
// override drives every path a test exercises. Never consulted in production
// (stays null); set only via __setLicenseGateOverrideForTesting from tests.
let _testOverride = null;
function __setLicenseGateOverrideForTesting(fn) { _testOverride = fn; }

/**
 * Returns true/false. Convenience wrapper around checkPluginLicense.
 */
async function isPluginLicensed(orgId, pluginId) {
  if (_testOverride) return _testOverride(orgId, pluginId);
  const result = await checkPluginLicense(orgId, pluginId);
  return result.licensed;
}

/**
 * Test/admin: clear the cache. Not exposed via HTTP.
 */
function clearLicenseCache() {
  cache.clear();
}

/**
 * QUOXCHAT-BRUTALOOP ITER6: like isPluginLicensed, but keeps the difference
 * between "no licence" and "the check could not run" (auth unreachable, no
 * stale cache). Callers still fail CLOSED on both; they just must not tell
 * an operator "licence required" when the truth is "try again".
 */
async function licenseVerdict(orgId, pluginId) {
  if (_testOverride) return { licensed: !!(await _testOverride(orgId, pluginId)), unavailable: false };
  const r = await checkPluginLicense(orgId, pluginId);
  return { licensed: !!r.licensed, unavailable: !r.licensed && r.failClosed === true };
}

module.exports = {
  licenseVerdict,
  checkPluginLicense,
  isPluginLicensed,
  clearLicenseCache,
  __setLicenseGateOverrideForTesting,
};
