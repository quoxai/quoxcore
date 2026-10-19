/**
 * Mirror Index — The Cognitive Index for QuoxMind
 *
 * Stream MR Phase MR-1.
 *
 * Single cached index of everything the system knows about itself.
 * Consumed by: agent system prompts, execution_intelligence tool,
 * frontend widgets, smart router, agent delegator, decomposer.
 *
 * Design: index, not encyclopedia. Compact injection tells agents what
 * exists. Full index available via tool call for depth on demand.
 *
 * Cache: 30s TTL, refreshed lazily on access (no background timer). Stale
 * data preferred over no data.
 */

import { fetchServerMirror, indexFromServer } from './serverMirror.js'

// QMH-5/1 — implants are required to surface a multi-axis status so the UI
// can stop rendering "DOWN" for every non-healthy state. The four honest
// non-healthy states are license-required, service-unreachable, collecting
// (insufficient data), and a real failure.
//
// Tier → required plugin map. Implants with tier 'pro' or 'complete' need
// the matching QuoxMind plugin licensed; otherwise they render as
// `license_required` rather than `down`. Free-tier implants never use this
// fallback (a free implant that refuses to compute is a real bug).
const TIER_REQUIRED_PLUGIN = {
  pro: 'quoxmind-pro',
  complete: 'quoxmind-complete',
}

/**
 * Derive a multi-axis implant status from fetcher output.
 *
 * Inputs:
 *   data           the fetcher result (or null when the fetcher itself returned nothing)
 *   isLocked       client-side license check (plugin not installed)
 *   requiredPlugin from cognitiveImplants tier config (e.g. 'quoxmind-pro')
 *
 * Output:
 *   { status, healthScore, statusReason }
 *
 * Status enum (kept stable for system-prompt injection):
 *   healthy            score >= 80 with real data
 *   degraded           50 <= score < 80
 *   down               real failure: score < 50 with real data
 *   license_required   license missing — UI shows "🔒 Premium feature"
 *   unreachable        backend service down — UI shows "⚠ Service unreachable: <name>"
 *   collecting         endpoint reachable but score is null — UI shows "◐ Collecting"
 *   offline            no data and no failureReason (legacy fallback)
 */
export function deriveImplantStatus(data, { isLocked = false, requiredPlugin = null } = {}) {
  // 1. License gate — server sentinel OR client-side license check both win
  //    over numeric health, so we never label a license-blocked implant
  //    "DOWN" or "degraded".
  const serverLicense = data?.failureReason?.code === 'LICENSE_REQUIRED'
  const clientLicense = isLocked && requiredPlugin
  if (serverLicense || clientLicense) {
    return {
      status: 'license_required',
      healthScore: null,
      statusReason: {
        code: 'LICENSE_REQUIRED',
        requiredPlugin: data?.failureReason?.requiredPlugin || requiredPlugin || null,
      },
    }
  }

  // 2. No data at all → offline (the fetcher returned null entirely)
  if (!data) {
    return { status: 'offline', healthScore: 0, statusReason: { code: 'NO_DATA' } }
  }

  // 3. Service unreachable — explicit sentinel from the fetcher OR the
  //    legacy `fallback: true` boolean used by every fetcher's catch block.
  const unreachable =
    data.failureReason?.code === 'SERVICE_UNREACHABLE' || data.fallback === true
  if (unreachable) {
    return {
      status: 'unreachable',
      healthScore: null,
      statusReason: {
        code: 'SERVICE_UNREACHABLE',
        service: data.failureReason?.service || null,
        message: data.failureReason?.message || null,
      },
    }
  }

  // 4. Collecting — the endpoint is reachable but does not yet have enough
  //    signal to compute a health score. Surfaces as "◐ Collecting" not "DOWN".
  const score = data.healthScore ?? null
  if (score === null) {
    return {
      status: 'collecting',
      healthScore: null,
      statusReason: {
        code: 'COLLECTING',
        message: data.primaryMetric?.label || 'Collecting',
      },
    }
  }

  // 5. Real numeric thresholds. score < 50 with real data is the only path
  //    that legitimately maps to "DOWN".
  if (score >= 80) return { status: 'healthy',  healthScore: Math.round(score), statusReason: null }
  if (score >= 50) return { status: 'degraded', healthScore: Math.round(score), statusReason: null }
  return { status: 'down', healthScore: Math.round(score), statusReason: { code: 'LOW_HEALTH' } }
}

/**
 * Map tier → required plugin, used by buildIndex to decide whether a
 * locked implant is `license_required` (tier > free) versus a true bug.
 */
export function requiredPluginForTier(tier) {
  return TIER_REQUIRED_PLUGIN[tier] || null
}

// ── Cache ──────────────────────────────────────────────────────────

let _cache = null
let _cacheTimestamp = 0
const CACHE_TTL = 30000  // 30 seconds

// ── Core: Build the index (server-side Mirror, org-scoped) ────────

async function buildIndex() {
  return indexFromServer(await fetchServerMirror())
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Refresh the mirror cache. Invoked lazily by getIndex() whenever the
 * cached copy is older than CACHE_TTL. Can also be called directly to
 * force an immediate refresh.
 */
export async function refreshMirror() {
  try {
    _cache = await buildIndex()
    _cacheTimestamp = Date.now()
  } catch (err) {
    console.error('[Mirror] Refresh failed:', err.message)
    // Keep stale cache — better than nothing
  }
}

/**
 * Get the cached index, refreshing if stale.
 */
async function getIndex() {
  if (!_cache || (Date.now() - _cacheTimestamp) > CACHE_TTL) {
    await refreshMirror()
  }
  return _cache || { timestamp: new Date().toISOString(), implants: {}, agents: { count: null, active: null, roster: [] }, capabilities: {}, memory: { total: null }, core: { health: null }, codebase: { status: 'unknown' }, implantSummary: { total: 0, healthy: 0 }, summary: '' }
}

/**
 * Get the full Mirror index as JSON.
 * Used by: execution_intelligence tool, COREY context, detailed queries.
 */
export async function getFullIndex() {
  return getIndex()
}

/**
 * Get a compact injection string for system prompts (~150-200 tokens).
 * Used by: quoxContext.js → collector system prompt injection.
 */
export async function getCompactInjection() {
  try {
    const idx = await getIndex()
    return idx?.summary || ''
  } catch {
    return ''
  }
}

/**
 * Get cache age in milliseconds.
 */
export function getMirrorAge() {
  return _cacheTimestamp > 0 ? Date.now() - _cacheTimestamp : Infinity
}
