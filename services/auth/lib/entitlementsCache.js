/**
 * lib/entitlementsCache.js — the entitlement resolver's cache generation.
 *
 * Split out of lib/entitlements.js for one reason: this module imports
 * NOTHING. entitlements.js pulls in db/index.js (which opens the service
 * database and reads MASTER_ENCRYPTION_KEY at import), so anything that merely
 * wants to invalidate the cache — a test fixture, a tool — used to have to drag
 * the whole service up with it. Importing this file has no side effects at all.
 *
 * lib/entitlements.js re-exports clearEntitlementsCache(), so every existing
 * caller keeps importing it from there.
 */

let _generation = 0;

/** The current cache generation. A cached entry from an older one is stale. */
export function cacheGeneration() {
    return _generation;
}

/**
 * Test/admin: invalidate every cached entitlement resolution, so a
 * just-activated/deactivated lease is reflected immediately rather than up to
 * CACHE_TTL_MS later.
 */
export function clearEntitlementsCache() {
    _generation++;
}

export default { cacheGeneration, clearEntitlementsCache };
