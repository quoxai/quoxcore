/**
 * lib/repobrainRegistry.js — QUOX-REPOBRAIN Phase 1 (D1/D2 of
 * docs/STREAM_QUOX_REPOBRAIN_PHASE1_DESIGN.md).
 *
 * Collector-side client for the auth service's per-org RepoBrain connection
 * resolver. Mirrors lib/licenseGate.js's cache/stale-grace shape exactly:
 * 30s fresh TTL, 10min stale grace, per-process Map, fail closed past grace.
 *
 * Auth source of truth:
 *   POST ${AUTH_INTERNAL_URL}/api/setup/internal/repobrain-resolve
 *   Body: { org_id, connection_id? }
 *   Response: { connection_id, label, base_url, shared_secret } (org has a
 *   connection) or { connections: 0 } (zero-config signal, org has none).
 *   Auth header: x-service-key: INTERNAL_SERVICE_KEY.
 *
 * Zero-config fallback: an org with no registered connection resolves to
 * the bundled REPOBRAIN_URL with no shared-secret header, byte-identical to
 * Phase 0 behaviour. That answer is cached under the same TTL so an
 * unconfigured org costs one auth call per 30s, not one per query.
 *
 * Fail-closed on resolver outage: a live auth fetch failure serves the
 * stale cached answer within the 10min grace. Past grace, or with no prior
 * successful resolution at all, this throws — the caller (the nucleus
 * proxy) must turn that into a 502 for that org, never silently reroute to
 * the bundled default. Guessing bundled on error would leak a
 * connection-holding org's queries toward the shared index and return the
 * wrong backend's answers.
 */

const CACHE_TTL_MS = 30_000;
const STALE_GRACE_MS = 10 * 60_000; // 10 minutes past the fresh TTL

const cache = new Map(); // key -> { backend, expiresAt, staleUntil }

function getAuthUrl() {
  // Same canonical-var preference as licenseGate.js: AUTH_SERVICE_URL is the
  // var the rest of quoxchat.js already uses; AUTH_INTERNAL_URL is accepted
  // as a fallback so a compose that only sets one can't leave this resolver
  // pointed at the wrong host while other auth calls succeed.
  return process.env.AUTH_SERVICE_URL || process.env.AUTH_INTERNAL_URL || 'http://auth:3101';
}

function getBundledUrl() {
  return process.env.REPOBRAIN_URL || 'http://repobrain:3105';
}

function cacheKey(orgId, connectionId) {
  return `${orgId}:${connectionId || 'default'}`;
}

/** Fresh (within TTL) cache read. */
function readCache(orgId, connectionId) {
  const entry = cache.get(cacheKey(orgId, connectionId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

/**
 * Stale-but-in-grace cache read — only consulted when a live auth fetch
 * just failed. Garbage-collects the entry once it's past the grace window.
 */
function readStaleCache(orgId, connectionId) {
  const key = cacheKey(orgId, connectionId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.staleUntil) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(orgId, connectionId, backend) {
  const now = Date.now();
  cache.set(cacheKey(orgId, connectionId), {
    backend,
    expiresAt: now + CACHE_TTL_MS,
    staleUntil: now + CACHE_TTL_MS + STALE_GRACE_MS,
  });
}

async function fetchFromAuth(orgId, connectionId) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  const res = await fetch(`${getAuthUrl()}/api/setup/internal/repobrain-resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
      'x-internal-call': '1',
    },
    body: JSON.stringify({ org_id: orgId, connection_id: connectionId || undefined }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  return res.json();
}

/**
 * Resolves { source, connectionId, label, baseUrl, sharedSecret } for the
 * given org (and optional explicit connection id, from the caller's
 * X-RepoBrain-Connection header). Never guesses the bundled default on a
 * resolver error — throws instead, so the caller can fail closed with 502.
 */
async function resolveRepoBrainBackend(orgId, connectionId = null) {
  if (!orgId) {
    throw new Error('resolveRepoBrainBackend: orgId is required');
  }

  const cached = readCache(orgId, connectionId);
  if (cached) return cached.backend;

  try {
    const result = await fetchFromAuth(orgId, connectionId);

    let backend;
    if (result && result.connections === 0) {
      // Zero-config: org has no connection rows. Fall through to the
      // bundled instance, no shared-secret header.
      backend = { source: 'bundled', connectionId: null, label: null, baseUrl: getBundledUrl(), sharedSecret: null };
    } else if (result && result.base_url) {
      backend = {
        source: 'org',
        connectionId: result.connection_id || null,
        label: result.label || null,
        baseUrl: result.base_url,
        sharedSecret: result.shared_secret || null,
      };
    } else {
      throw new Error('repobrain-resolve returned an unrecognised response shape');
    }

    writeCache(orgId, connectionId, backend);
    return backend;
  } catch (err) {
    const stale = readStaleCache(orgId, connectionId);
    if (stale) {
      console.warn(`[collector repobrainRegistry] auth unreachable, serving STALE cache (grace) for ${cacheKey(orgId, connectionId)}: ${err.message}`);
      return stale.backend;
    }
    console.warn(`[collector repobrainRegistry] auth unreachable, no stale cache in grace — failing CLOSED for ${cacheKey(orgId, connectionId)}: ${err.message}`);
    throw err;
  }
}

/**
 * Test/admin: clear the cache. Not exposed via HTTP.
 */
function clearRepoBrainRegistryCache() {
  cache.clear();
}

module.exports = {
  resolveRepoBrainBackend,
  clearRepoBrainRegistryCache,
};
