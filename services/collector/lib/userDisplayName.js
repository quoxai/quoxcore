/**
 * HITL-CONTEXT: resolve a user id to a display name for approval cards.
 * Asks the auth service (org-scoped, service-key) and caches both hits and
 * misses briefly so a burst of approvals costs one lookup. Best effort: any
 * failure returns null and the card falls back to the id (never blocks).
 */
const HIT_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map();

function clearCache() { cache.clear(); }

async function resolveUserDisplayName(orgId, userId, {
  fetchImpl = globalThis.fetch,
  authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101',
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  now = Date.now(),
} = {}) {
  if (!orgId || !userId || !serviceKey || typeof fetchImpl !== 'function') return null;
  const key = `${orgId}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.name;
  let name = null;
  let ttl = MISS_TTL_MS;
  try {
    const url = `${authUrl}/api/internal/identity/display-name?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`;
    const resp = await fetchImpl(url, { headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const body = await resp.json();
      if (body && typeof body.display_name === 'string' && body.display_name.trim()) {
        name = body.display_name.trim().slice(0, 80);
        ttl = HIT_TTL_MS;
      }
    }
  } catch { /* best effort */ }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { name, expires: now + ttl });
  return name;
}

module.exports = { resolveUserDisplayName, clearCache };
