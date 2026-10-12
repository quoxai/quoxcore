'use strict';
/**
 * Short-TTL cache for status-probe reads (incident 2026-10-06).
 *
 * The dashboard status bar polls /aee/query?intent=aocl.&limit=1 and
 * /ward/stats + /ward/chains every ~10s per open client. Each call ran a
 * full synchronous SQLite scan, which pegged the collector event loop at
 * 100% CPU: /health timed out and queued builds stalled. Serving identical
 * probe reads from a small TTL cache bounds the cost to one scan per key per
 * TTL, regardless of how many clients poll. Errors are never cached.
 */
function createTtlCache({ ttlMs = 15000, max = 500, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { value, expiresAt }
  return {
    get(key, compute) {
      const t = now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > t) return hit.value;
      if (hit) entries.delete(key);
      const value = compute(); // throws propagate, nothing stored
      entries.set(key, { value, expiresAt: t + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },
    clear() { entries.clear(); },
  };
}

module.exports = { createTtlCache };
