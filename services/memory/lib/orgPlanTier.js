/**
 * Org plan -> memory tier sync (quox#571 part 2).
 *
 * memory_quotas.tier defaulted to 'free' and was NEVER derived from the org's
 * plan, so enterprise orgs silently lived under free limits (100% of 179 quota
 * rows were tier=free/source=default; the promote endpoint had zero callers).
 *
 * Design: the quota row stays the synchronous source of truth for the write
 * path (checkWriteAllowed never awaits a network call). getQuota() fires a
 * non-blocking sync that fetches the org's plan from auth (cached), and when
 * the derived tier differs, UPDATEs the row with tier_source='org_plan_sync'.
 * Eventually consistent within a call; zero latency added to writes.
 *
 * Explicit grants always win: rows whose tier_source is 'plugin',
 * 'admin_override' or 'trial' are never touched, in JS AND in the SQL guard.
 * Downgrades sync too (an org leaving enterprise returns to derived free),
 * but only over rows this module itself manages.
 */

const PLAN_TO_TIER = {
  enterprise: 'enterprise',
  team: 'premium',
  pro: 'premium',
  premium: 'premium',
  business: 'premium',
  free: 'free',
};

// Sources this module may overwrite. Anything else is an explicit grant.
const SYNCABLE_SOURCES = ['default', 'expired_trial', 'org_plan_sync'];

const SUCCESS_TTL_MS = 5 * 60 * 1000;
// Failed lookups are cached briefly too — an auth outage must not turn every
// getQuota into a fetch storm (same lesson as collector providerKeys,
// 2026-09-21 rate-limiter incident).
const FAILURE_TTL_MS = 60 * 1000;

const _planCache = new Map(); // orgId -> { tier: string|null, expires: number }

function defaultDeps() {
  return {
    fetchImpl: globalThis.fetch,
    authBaseUrl: process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101',
    serviceKey: process.env.INTERNAL_SERVICE_KEY || '',
    now: () => Date.now(),
  };
}

export function isSyncableSource(tierSource) {
  return tierSource == null || tierSource === '' || SYNCABLE_SOURCES.includes(tierSource);
}

export function planToTier(plan) {
  return PLAN_TO_TIER[String(plan || '').toLowerCase()] || null;
}

async function fetchDerivedTier(orgId, deps) {
  const now = deps.now();
  const cached = _planCache.get(orgId);
  if (cached && cached.expires > now) return cached.tier;

  if (!deps.serviceKey) {
    // Without a key we can never succeed; cache as failure so we don't log
    // per call, but say it once loudly.
    if (!cached) console.error('[MemoryTierSync] INTERNAL_SERVICE_KEY unset — org plan sync disabled');
    _planCache.set(orgId, { tier: null, expires: now + FAILURE_TTL_MS });
    return null;
  }

  try {
    const resp = await deps.fetchImpl(
      `${deps.authBaseUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/plan`,
      { headers: { 'x-service-key': deps.serviceKey }, signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) {
      _planCache.set(orgId, { tier: null, expires: now + FAILURE_TTL_MS });
      return null;
    }
    const data = await resp.json();
    const tier = planToTier(data?.plan);
    _planCache.set(orgId, { tier, expires: now + SUCCESS_TTL_MS });
    return tier;
  } catch (err) {
    console.warn(`[MemoryTierSync] plan lookup failed for org ${orgId}: ${err.message}`);
    _planCache.set(orgId, { tier: null, expires: now + FAILURE_TTL_MS });
    return null;
  }
}

/**
 * Fire-and-forget: bring row.tier in line with the org's plan.
 * Never throws; never blocks the caller; never touches explicit grants.
 * @returns {Promise<boolean>} true when a row update was applied (for tests)
 */
export async function syncQuotaTierFromOrgPlan(db, orgId, userId, row, depsOverride) {
  const deps = { ...defaultDeps(), ...(depsOverride || {}) };
  try {
    if (!row || !isSyncableSource(row.tier_source)) return false;

    const derived = await fetchDerivedTier(orgId, deps);
    if (!derived || derived === row.tier) return false;

    const result = db.prepare(`
      UPDATE memory_quotas
      SET tier = ?, tier_source = 'org_plan_sync', updated_at = datetime('now')
      WHERE org_id = ? AND user_id = ?
        AND (tier_source IN (${SYNCABLE_SOURCES.map(() => '?').join(',')}) OR tier_source IS NULL OR tier_source = '')
    `).run(derived, orgId, userId, ...SYNCABLE_SOURCES);
    if (result.changes > 0) {
      console.log(`[MemoryTierSync] org ${orgId} user ${userId}: tier ${row.tier} -> ${derived} (org plan)`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[MemoryTierSync] sync failed (non-fatal): ${err.message}`);
    return false;
  }
}

export function _resetPlanCacheForTests() {
  _planCache.clear();
}
