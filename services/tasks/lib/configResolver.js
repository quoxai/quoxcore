/**
 * configResolver.js: SETEC S3 batch 1.
 *
 * Instance-scope settings resolution for the tasks service. A port of
 * services/auth/lib/configResolver.js (same HTTP seam to collector's
 * settings API, same 30s cache, same fail-safe contract: any failure
 * resolves to null, never throws, so every call site keeps its own
 * env-derived default). tasks owns no org_platform_settings table, so it
 * asks collector for the already-resolved value.
 *
 * getInstanceNumber(key, fallback) is the helper the read sites use: a
 * positive finite resolved value wins, anything else returns `fallback`
 * (the caller's env-or-code default, byte-identical to pre-promotion).
 */
const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS_DEFAULT = 5000;
const DEFAULT_CACHE_TTL_MS = 30000;

const _cache = new Map(); // `${scope}::${key}` -> { at, result }
let _cacheTtlMs = DEFAULT_CACHE_TTL_MS;

function _cacheGet(cacheKey, ttlMs) {
  if (ttlMs <= 0) return undefined;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at <= ttlMs) return hit.result;
  return undefined;
}

function _cacheSet(cacheKey, ttlMs, result) {
  if (ttlMs <= 0) return;
  _cache.set(cacheKey, { at: Date.now(), result });
}

/**
 * Shared fetch-and-parse for both getSetting/getInstanceSetting below.
 * Never throws, any failure resolves to `null`.
 */
async function _fetchFlag(url, headers, key, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;

  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      console.error(`[Tasks configResolver] ${key} settings fetch HTTP ${res.status}, falling back to env`);
      return null;
    }
    const data = await res.json();
    const entry = Array.isArray(data?.flags) ? data.flags.find((f) => f && f.key === key) : null;
    if (!entry || typeof entry.value !== 'string') return null;
    return { value: entry.value, on: !!entry.on, source: entry.source || 'env' };
  } catch (err) {
    console.error(`[Tasks configResolver] ${key} settings fetch failed, falling back to env, ${err.message}`);
    return null;
  }
}

/**
 * Org-scoped resolution, GET /api/v1/platform/settings/flags.
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
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT;
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT;
  if (!serviceKey || !orgId) return null;

  const ttlMs = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : _cacheTtlMs;
  const cacheKey = `org:${orgId}::${key}`;
  const cached = _cacheGet(cacheKey, ttlMs);
  if (cached !== undefined) return cached;

  const result = await _fetchFlag(
    `${collectorUrl}/api/v1/platform/settings/flags`,
    { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId },
    key,
    deps
  );
  _cacheSet(cacheKey, ttlMs, result);
  return result;
}

/**
 * Instance-wide (non-org) resolution, GET
 * /api/v1/platform/settings/instance/flags (VAULT-INTEG P17 collector
 * route; service-key only, no X-Org-Id).
 *
 * @param {string} key - a platformCapabilities.CAPABILITIES key
 * @param {object} [deps] - same shape as getSetting()
 * @returns {Promise<{value:string, on:boolean, source:string}|null>}
 */
export async function getInstanceSetting(key, deps = {}) {
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT;
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT;
  if (!serviceKey) return null;

  const ttlMs = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : _cacheTtlMs;
  const cacheKey = `instance::${key}`;
  const cached = _cacheGet(cacheKey, ttlMs);
  if (cached !== undefined) return cached;

  const result = await _fetchFlag(
    `${collectorUrl}/api/v1/platform/settings/instance/flags`,
    { 'X-Service-Key': serviceKey },
    key,
    deps
  );
  _cacheSet(cacheKey, ttlMs, result);
  return result;
}

/** Test-only: clears every cached resolution. */
export function _resetForTest() {
  _cache.clear();
  _cacheTtlMs = DEFAULT_CACHE_TTL_MS;
}

/**
 * Test-only: overrides the module-default cache TTL used when a call site
 * doesn't pass deps.cacheTtlMs explicitly.
 */
export function _setCacheTtlMsForTest(ms) {
  _cacheTtlMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CACHE_TTL_MS;
  _cache.clear();
}

/**
 * Resolve an instance-scope numeric setting. Only a STORED override
 * (source 'setting') is honoured: collector's env/default view is not this
 * service's env, so an env-sourced value must never shadow the local
 * fallback. Returns `fallback` unless a stored finite number > 0 resolves.
 * Never throws.
 */
export async function getInstanceNumber(key, fallback, deps = {}) {
  try {
    const r = await getInstanceSetting(key, deps);
    if (!r || r.source !== 'setting') return fallback;
    const n = Number(r.value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * setInterval whose period follows a stored instance setting. Starts at
 * `fallbackMs` (the caller's env-or-code default, byte-identical to the old
 * behaviour with no stored setting), and after every tick re-resolves the
 * setting (30s cached, fail-safe) and re-arms the interval if the stored
 * value changed. So a settings change applies within one tick plus the
 * cache TTL, no restart. Returns { stop(), currentMs() }.
 */
export function startAdaptiveInterval(key, fallbackMs, fn, { unref = false, deps = {} } = {}) {
  let ms = fallbackMs;
  let handle = null;
  let stopped = false;
  const arm = () => {
    handle = setInterval(tick, ms);
    if (unref && typeof handle.unref === 'function') handle.unref();
  };
  const tick = () => {
    fn();
    getInstanceNumber(key, fallbackMs, deps).then((n) => {
      if (stopped || n === ms) return;
      console.log(`[configResolver] ${key} interval ${ms}ms -> ${n}ms`);
      clearInterval(handle);
      ms = n;
      arm();
    }).catch(() => {});
  };
  arm();
  return {
    stop() { stopped = true; clearInterval(handle); },
    currentMs() { return ms; },
  };
}

export default { getSetting, getInstanceSetting, getInstanceNumber, startAdaptiveInterval, _resetForTest, _setCacheTtlMsForTest };
