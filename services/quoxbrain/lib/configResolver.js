// configResolver.js — VAULT-INTEG P17.
//
// quoxbrain is a separate process/service from the collector — it never
// opens collector's voltDb (org_platform_settings, where a stored setting
// override actually lives), so it cannot resolve one directly the way
// services/collector/lib/configResolver.js does. This module fetches the
// ALREADY-resolved, precedence-applied value from collector's own settings
// API instead, over the exact service-to-service HTTP convention
// dreamScheduler.js's fetchDreamEnabledOverride() established for
// QUOXDREAM_ENABLED (quox#524) — X-Service-Key, and (for org-scoped keys)
// X-Org-Id — generalised here past that one flag to any registered key:
//
//   getSetting(orgId, key)   -> GET /api/v1/platform/settings/flags
//                               (X-Service-Key + X-Org-Id; org-scoped knobs)
//   getInstanceSetting(key)  -> GET /api/v1/platform/settings/instance/flags
//                               (X-Service-Key only; the VAULT-INTEG P17
//                               instance-scope route, service.js's
//                               requireInstanceServiceKey — no org concept
//                               for a whole-process knob like a scheduler's
//                               tick cadence)
//
// FAIL-SAFE CONTRACT (mirrors fetchDreamEnabledOverride exactly, just
// generalised): a missing service key, a missing orgId (getSetting only), a
// network error, a timeout, a non-2xx response, or the requested key being
// absent from the response all resolve to `null` — never throw — so every
// call site keeps its OWN env-derived default/fallback, identical in shape
// to dreamScheduler.js's `on = resolved ?? envEnabled` pattern. This module
// never invents a fallback value of its own; it only ever hands back what
// collector's registry actually resolved, or null.
//
// SHORT TTL CACHE (documented; default ON here, unlike collector's own
// configResolver.js which defaults its cache OFF). Several read sites this
// rewires are per-request hot paths — contextAssembler.js's hybrid-retrieval
// gate runs on every /brain/search and /brain/context call — so resolving
// fresh over HTTP on every single call would add a network round trip to
// every query. DEFAULT_CACHE_TTL_MS (30s) bounds staleness to "a stored
// override takes effect within 30s" while keeping the common case (no
// override stored, or one that rarely changes) cheap. No new env var backs
// this TTL — this module rewires EXISTING reads, per VAULT-INTEG P17 scope,
// it does not add one — override it per-call via `deps.cacheTtlMs`, or
// `_setCacheTtlMsForTest()` in tests.

const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || ''
// BRAIN2-AUDIT 2026-10-05: 500ms (was 5s). A slow settings fetch used to stall
// the first request after each cache expiry for up to 5s; the caller keeps its
// env fallback on null, so a short timeout is safe.
const FETCH_TIMEOUT_MS_DEFAULT = 500
const DEFAULT_CACHE_TTL_MS = 30000

const _cache = new Map() // `${scope}::${key}` -> { at, result }
const _inflight = new Set() // cache keys with a background refresh running
let _cacheTtlMs = DEFAULT_CACHE_TTL_MS

function _cacheGet(cacheKey, ttlMs) {
  if (ttlMs <= 0) return undefined
  const hit = _cache.get(cacheKey)
  if (hit && Date.now() - hit.at <= ttlMs) return hit.result
  return undefined
}

// Stale-while-revalidate read: returns the entry (fresh or stale) plus whether
// it is stale. Undefined only when nothing was ever fetched for this key.
function _cacheGetSwr(cacheKey, ttlMs) {
  if (ttlMs <= 0) return undefined
  const hit = _cache.get(cacheKey)
  if (!hit) return undefined
  return { result: hit.result, stale: Date.now() - hit.at > ttlMs }
}

function _refreshInBackground(cacheKey, ttlMs, doFetch) {
  if (_inflight.has(cacheKey)) return
  _inflight.add(cacheKey)
  doFetch()
    .then((result) => _cacheSet(cacheKey, ttlMs, result))
    .catch(() => {})
    .finally(() => _inflight.delete(cacheKey))
}

function _cacheSet(cacheKey, ttlMs, result) {
  if (ttlMs <= 0) return
  _cache.set(cacheKey, { at: Date.now(), result })
}

/**
 * Shared fetch-and-parse for both getSetting/getInstanceSetting below.
 * Never throws — any failure resolves to `null`.
 *
 * @param {string} url
 * @param {object} headers
 * @param {string} key
 * @param {object} deps
 * @returns {Promise<{value:string, on:boolean, source:string}|null>}
 */
async function _fetchFlag(url, headers, key, deps) {
  return (await _fetchFlagStatus(url, headers, key, deps)).entry
}

/**
 * Same fetch as _fetchFlag but keeps "the collector answered, no override
 * stored" ({ok:true, entry:null}) distinct from "the lookup failed"
 * ({ok:false, entry:null}). Privacy-RESTRICTING settings need that
 * difference: an unanswered lookup must never be read as "no restriction".
 * Never throws.
 *
 * @returns {Promise<{ok:boolean, entry:{value:string,on:boolean,source:string}|null}>}
 */
async function _fetchFlagStatus(url, headers, key, deps) {
  const fetchImpl = deps.fetchImpl || fetch
  const timeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT

  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      console.error(`[QuoxBrain configResolver] ${key} settings fetch HTTP ${res.status} — falling back to env`)
      return { ok: false, entry: null }
    }
    const data = await res.json()
    const entry = Array.isArray(data?.flags) ? data.flags.find((f) => f && f.key === key) : null
    if (!entry || typeof entry.value !== 'string') return { ok: true, entry: null }
    // BRAIN2-AUDIT L1 (2026-09-12): the collector answers for every
    // registered key, resolving unset ones from ITS OWN env/defaults
    // (source 'env', see collector lib/platformCapabilities.js
    // resolveEffectiveCapability) — and the collector carries none of the
    // QUOXBRAIN_*/QUOXDREAM_* vars this service's knobs are backed by.
    // Trusting that answer inverted this container's env truth: hybrid
    // retrieval ran FTS-only platform-wide while the brain's env said
    // enabled, and the next restart would have silently disabled QuoxDream
    // and the embedding backfill. Only a STORED override (source
    // 'setting') is an answer; a collector-default is this contract's
    // "no override stored" case: null, caller keeps its own env read.
    if (entry.source !== 'setting') return { ok: true, entry: null }
    return { ok: true, entry: { value: entry.value, on: !!entry.on, source: entry.source } }
  } catch (err) {
    console.error(`[QuoxBrain configResolver] ${key} settings fetch failed, falling back to env — ${err.message}`)
    return { ok: false, entry: null }
  }
}

/**
 * Org-scoped resolution — GET /api/v1/platform/settings/flags.
 *
 * @param {string} orgId
 * @param {string} key - a platformCapabilities.CAPABILITIES key
 * @param {object} [deps]
 * @param {function} [deps.fetchImpl] - injectable for tests
 * @param {string} [deps.collectorUrl] - override (tests)
 * @param {string} [deps.serviceKey] - override (tests)
 * @param {number} [deps.fetchTimeoutMs] - override (tests)
 * @param {number} [deps.cacheTtlMs] - override the resolution cache TTL for this call
 * @returns {Promise<{value:string, on:boolean, source:string}|null>}
 */
export async function getSetting(orgId, key, deps = {}) {
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT
  if (!serviceKey || !orgId) return null

  const ttlMs = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : _cacheTtlMs
  const cacheKey = `org:${orgId}::${key}`
  const doFetch = () => _fetchFlag(
    `${collectorUrl}/api/v1/platform/settings/flags`,
    { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId },
    key,
    deps
  )
  const cached = _cacheGetSwr(cacheKey, ttlMs)
  if (cached) {
    if (cached.stale) _refreshInBackground(cacheKey, ttlMs, doFetch)
    return cached.result
  }

  const result = await doFetch()
  _cacheSet(cacheKey, ttlMs, result)
  return result
}

/**
 * Like getSetting, but tells "answered, nothing stored" apart from "lookup
 * failed" (BRAIN2-W2 2: privacy fail-closed). A failed lookup is never cached
 * over a previous good answer, so a stale-but-answered value is served as the
 * in-memory last-known-good while the collector is down.
 *
 * @returns {Promise<{ok:boolean, result:{value:string,on:boolean,source:string}|null}>}
 */
export async function getSettingStatus(orgId, key, deps = {}) {
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT
  if (!serviceKey || !orgId) return { ok: false, result: null }

  const ttlMs = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : _cacheTtlMs
  const cacheKey = `status:org:${orgId}::${key}`
  const doFetch = async () => {
    const r = await _fetchFlagStatus(
      `${collectorUrl}/api/v1/platform/settings/flags`,
      { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId },
      key,
      deps
    )
    return { ok: r.ok, result: r.entry }
  }
  const cached = _cacheGetSwr(cacheKey, ttlMs)
  if (cached) {
    if (cached.stale) {
      if (!_inflight.has(cacheKey)) {
        _inflight.add(cacheKey)
        doFetch()
          .then((r) => { if (r.ok) _cacheSet(cacheKey, ttlMs, r) })
          .catch(() => {})
          .finally(() => _inflight.delete(cacheKey))
      }
    }
    return cached.result
  }

  const r = await doFetch()
  if (r.ok) _cacheSet(cacheKey, ttlMs, r)
  return r
}

/**
 * Instance-wide (non-org) resolution — GET
 * /api/v1/platform/settings/instance/flags (VAULT-INTEG P17 collector
 * route; service-key only, no X-Org-Id).
 *
 * @param {string} key - a platformCapabilities.CAPABILITIES key
 * @param {object} [deps] - same shape as getSetting()
 * @returns {Promise<{value:string, on:boolean, source:string}|null>}
 */
export async function getInstanceSetting(key, deps = {}) {
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT
  if (!serviceKey) return null

  const ttlMs = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : _cacheTtlMs
  const cacheKey = `instance::${key}`
  const doFetch = () => _fetchFlag(
    `${collectorUrl}/api/v1/platform/settings/instance/flags`,
    { 'X-Service-Key': serviceKey },
    key,
    deps
  )
  const cached = _cacheGetSwr(cacheKey, ttlMs)
  if (cached) {
    if (cached.stale) _refreshInBackground(cacheKey, ttlMs, doFetch)
    return cached.result
  }

  const result = await doFetch()
  _cacheSet(cacheKey, ttlMs, result)
  return result
}

/**
 * Test-only: clears every cached resolution.
 */
export function _resetForTest() {
  _cache.clear()
  _inflight.clear()
  _cacheTtlMs = DEFAULT_CACHE_TTL_MS
}

/**
 * Test-only: overrides the module-default cache TTL used when a call site
 * doesn't pass deps.cacheTtlMs explicitly.
 */
export function _setCacheTtlMsForTest(ms) {
  _cacheTtlMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CACHE_TTL_MS
  _cache.clear()
}

export default { getSetting, getSettingStatus, getInstanceSetting, _resetForTest, _setCacheTtlMsForTest }
