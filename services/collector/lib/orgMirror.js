'use strict';
/**
 * The one per-org Mirror in this collector process. server.js configures it with the live readers
 * (lib/mirrorReaders.js); GET /api/v1/mind/mirror, the [SELF-KNOWLEDGE] injection and the
 * execution_intelligence mirror_index action all read it, so CommanderQ, /mirror and the dashboard
 * Mirror tab see the same org-scoped object.
 */
const { buildMirror, createMirrorCache, mirrorSummary } = require('./mirrorBuilder.js');

const TTL_MS = 30000;
let _cache = null;

function configure(deps, { ttlMs = TTL_MS, now } = {}) {
  _cache = createMirrorCache({ build: (orgId) => buildMirror({ orgId, deps, now: now ? now() : Date.now() }), ttlMs, ...(now ? { now } : {}) });
  return _cache;
}

function isConfigured() { return !!_cache; }

/** -> { mirror, age_ms, fresh, refreshed_at, refresh_ms }. Throws when not configured or no org. */
async function get(orgId) {
  if (!_cache) throw Object.assign(new Error('the Mirror builder is not configured in this process'), { code: 'MIRROR_NOT_CONFIGURED' });
  return _cache.get(orgId);
}

/**
 * The compact block for a turn. Uses the cached build when there is one (a stale one refreshes in the
 * background); otherwise waits up to waitMs for a first build, so a turn is never held long. '' = none.
 */
async function summaryFor(orgId, { waitMs = 2500 } = {}) {
  if (!_cache || !orgId) return '';
  const hit = _cache.peek(orgId);
  if (hit) return mirrorSummary(hit.mirror);
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve(null), waitMs); if (t.unref) t.unref(); });
  try {
    const r = await Promise.race([_cache.get(orgId), timeout]);
    return r ? mirrorSummary(r.mirror) : '';
  } finally { clearTimeout(t); }
}

module.exports = { configure, isConfigured, get, summaryFor, mirrorSummary, TTL_MS };
