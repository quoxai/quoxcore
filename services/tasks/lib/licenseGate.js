// Stream QMH (QuoxMind Honest) — server-side license-as-behaviour helper.
//
// QMH-1 built the interface; QMH-4a flipped the default mode to 'enforce' and
// added an env-gated rollout list. LICENSE-ENFORCE LE-3e flips the rollout
// default to WILDCARD (every org enforced unless explicitly narrowed) and
// flips the 'enforce'-mode auth-unreachable fallback from fail-OPEN to
// fail-CLOSED, with a bounded stale-cache grace window so a brief auth blip
// doesn't instantly kill a customer's premium access.
//
// Modes (env LICENSE_GATE_MODE, default 'enforce'):
//   'disabled'    — all checks return licensed=true. Useful for local dev or
//                   to fully disable the gate during an incident.
//   'enforce'     — default. Behaviour depends on rollout list:
//                     - org NOT in rollout → licensed=true (preserves uptime
//                       for orgs an operator explicitly excludes)
//                     - org IN rollout    → check auth; on auth-unreachable,
//                       serve a stale cached value within the grace window,
//                       else fail CLOSED.
//                   Any unknown mode value is treated as 'enforce'.
//   'fail-closed' — check via auth for every org, treat unreachable auth as
//                   NOT licensed (no stale-cache grace). Ignores rollout list.
//
// Rollout list (env LICENSE_GATE_ROLLOUT):
//   ''  / unset  — LE-3e: WILDCARD (every org enforced — this is now the
//                  default deploy posture, not an opt-in)
//   '*'          — every org enforced (same as unset)
//   'a, b, c'    — comma-separated org IDs (whitespace tolerated); only
//                  these orgs go through auth, everyone else licensed=true
//
// Auth source of truth:
//   GET ${AUTH_INTERNAL_URL}/api/setup/internal/has-plugin?org=<orgId>&plugin=<pluginId>
//   Response: { licensed: boolean, tier: 'tier_a' | 'tier_b' | 'tier_c' | null }
//   Auth header: x-service-key: INTERNAL_SERVICE_KEY (required — without it
//   the internal-service-only endpoint 403s; x-internal-call kept for
//   back-compat with any other internal-request logging that reads it).
//
// Cache: 30s fresh TTL + 10min stale grace, keyed by `${orgId}:${pluginId}`.
// Per-process, not Redis.

const VALID_MODES = new Set(['disabled', 'enforce', 'fail-closed'])
const CACHE_TTL_MS = 30_000
const STALE_GRACE_MS = 10 * 60_000 // 10 minutes past the fresh TTL

const cache = new Map() // key -> { licensed, tier, expiresAt, staleUntil }

function getMode() {
  const raw = process.env.LICENSE_GATE_MODE
  if (raw && VALID_MODES.has(raw)) return raw
  return 'enforce'
}

function getAuthUrl() {
  return process.env.AUTH_INTERNAL_URL || 'http://auth:3101'
}

function getRolloutOrgs() {
  const raw = process.env.LICENSE_GATE_ROLLOUT
  // LE-3e: empty/unset now means WILDCARD (every org enforced), not "skip
  // everyone". An operator who wants the old narrow-rollout behaviour sets
  // an explicit comma-separated list.
  if (!raw || !raw.trim()) return { wildcard: true, orgs: new Set() }
  if (raw.trim() === '*') return { wildcard: true, orgs: new Set() }
  const orgs = new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  return { wildcard: false, orgs }
}

function isOrgInRollout(orgId) {
  const { wildcard, orgs } = getRolloutOrgs()
  if (wildcard) return true
  return orgs.has(orgId)
}

function cacheKey(orgId, pluginId) {
  return `${orgId}:${pluginId}`
}

/** Fresh (within TTL) cache read. Does not consult/mutate stale entries. */
function readCache(orgId, pluginId) {
  const entry = cache.get(cacheKey(orgId, pluginId))
  if (!entry) return null
  if (Date.now() > entry.expiresAt) return null
  return entry
}

/**
 * Stale-but-in-grace cache read — only consulted when a live auth fetch just
 * failed. Garbage-collects the entry once it's past the grace window too.
 */
function readStaleCache(orgId, pluginId) {
  const key = cacheKey(orgId, pluginId)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.staleUntil) {
    cache.delete(key)
    return null
  }
  return entry
}

function writeCache(orgId, pluginId, value) {
  const now = Date.now()
  cache.set(cacheKey(orgId, pluginId), {
    ...value,
    expiresAt: now + CACHE_TTL_MS,
    staleUntil: now + CACHE_TTL_MS + STALE_GRACE_MS,
  })
}

function fetchAuthHeaders() {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY
  return {
    // authorizeInternalServiceRequest() on the auth side reads x-service-key
    // (see services/auth/utils/internalServiceAuth.js) — without this header
    // the has-plugin internal-only endpoint 403s. x-internal-call is kept
    // for back-compat with anything else reading that header.
    ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
    'x-internal-call': '1',
  }
}

async function fetchFromAuth(orgId, pluginId) {
  const url = `${getAuthUrl()}/api/setup/internal/has-plugin?org=${encodeURIComponent(orgId)}&plugin=${encodeURIComponent(pluginId)}`
  const res = await fetch(url, {
    headers: fetchAuthHeaders(),
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) throw new Error(`auth ${res.status}`)
  return res.json()
}

/**
 * Returns { licensed: boolean, tier: string|null }.
 * Never throws on transport errors — uses MODE to decide fallback.
 */
export async function checkPluginLicense(orgId, pluginId) {
  if (!orgId || !pluginId) {
    throw new Error('checkPluginLicense: orgId and pluginId required')
  }

  const mode = getMode()

  if (mode === 'disabled') {
    return { licensed: true, tier: null, mode: 'disabled' }
  }

  // enforce mode: only orgs in the rollout list go through auth.
  // Orgs outside rollout preserve pre-QMH-4 behaviour (licensed=true).
  // LE-3e: rollout defaults to wildcard, so this only skips orgs an
  // operator has explicitly excluded via a narrow LICENSE_GATE_ROLLOUT list.
  if (mode === 'enforce' && !isOrgInRollout(orgId)) {
    return { licensed: true, tier: null, mode: 'enforce', rollout: 'skipped' }
  }

  const cached = readCache(orgId, pluginId)
  if (cached) return { licensed: cached.licensed, tier: cached.tier, cached: true }

  try {
    const result = await fetchFromAuth(orgId, pluginId)
    const value = { licensed: !!result.licensed, tier: result.tier || null }
    writeCache(orgId, pluginId, value)
    return value
  } catch (err) {
    // Auth unreachable. Behaviour depends on mode.
    if (mode === 'fail-closed') {
      return { licensed: false, tier: null, error: err.message, failClosed: true }
    }

    // 'enforce' — LE-3e: fail CLOSED by default. A brief auth blip is
    // absorbed by serving a stale (expired-but-in-grace) cached value if one
    // exists; beyond the grace window (or with no prior successful check),
    // deny.
    const stale = readStaleCache(orgId, pluginId)
    if (stale) {
      console.warn(`[licenseGate] auth unreachable, serving STALE cache (grace) for ${orgId}:${pluginId}: ${err.message}`)
      return { licensed: stale.licensed, tier: stale.tier, error: err.message, stale: true }
    }

    console.warn(`[licenseGate] auth unreachable, no stale cache in grace — failing CLOSED for ${orgId}:${pluginId}: ${err.message}`)
    return { licensed: false, tier: null, error: err.message, failClosed: true }
  }
}

/**
 * Returns true/false. Convenience wrapper around checkPluginLicense.
 */
export async function isPluginLicensed(orgId, pluginId) {
  const result = await checkPluginLicense(orgId, pluginId)
  return result.licensed
}

/**
 * Throws if not licensed. Returns the license object on success.
 * Error has { code: 'LICENSE_REQUIRED', orgId, pluginId } for callers to
 * catch and translate into HTTP 402 or appropriate response.
 */
export async function requirePluginLicense(orgId, pluginId) {
  const result = await checkPluginLicense(orgId, pluginId)
  if (!result.licensed) {
    const err = new Error(`License required: ${pluginId}`)
    err.code = 'LICENSE_REQUIRED'
    err.orgId = orgId
    err.pluginId = pluginId
    throw err
  }
  return result
}

/**
 * Run fn() if licensed, otherwise return fallback (default null).
 * Useful in cognition modules: `withPluginLicense(orgId, 'quoxmind-pro', () => runMandatoryDirectives(...))`.
 */
export async function withPluginLicense(orgId, pluginId, fn, fallback = null) {
  const licensed = await isPluginLicensed(orgId, pluginId)
  if (!licensed) return fallback
  return fn()
}

/**
 * Test/admin: clear the cache. Not exposed via HTTP.
 */
export function clearLicenseCache() {
  cache.clear()
}

/**
 * For diagnostics.
 */
export function getLicenseGateMode() {
  return getMode()
}
