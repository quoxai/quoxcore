// Org-scoped provider API key resolution (QuoxVault-first, legacy fallback).
//
// This is the SINGLE implementation of getProviderKeys()'s cache + legacy-
// fallback + merge orchestration. server.js's own getProviderKeys() is a
// thin delegate to this module (see server.js), passing its local
// resolveCredentials as an injected dependency rather than this module
// keeping a second copy of the vault fetch + circuit breaker — that stays
// the single implementation in server.js, used unchanged by getClaudeKeys()
// and the Wazuh credential lookup too, so there is exactly one place in the
// process that talks to /api/setup/internal/resolve.
//
// conversationRecall.js is wired to this SAME getProviderKeys via
// conversationRecall.configure({ getProviderKeys }) at server boot, rather
// than resolving its own credentials, so capture/recall and the rest of the
// chat stack always see identical org-scoped keys from one code path.

const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');
const { mergeProviderKeys, PROVIDER_KEY_FIELDS } = require('./providerKeysMerge.js');

const CACHE_TTL_MS = 30 * 1000;
// A resolve round that yields nothing (auth down, rate-limited, no keys) must
// still be cached, briefly: with no negative TTL every caller re-fired BOTH
// auth endpoints on every call, and under a 429 the fleet of callers became a
// self-sustaining hammer that kept auth rate-limited (2026-09-21 incident).
const FAILURE_TTL_MS = 10 * 1000;
// A round where the credential service itself did not answer (timeout, open
// breaker, non-2xx) is NOT a confirmed empty: park it only briefly so the
// next caller retries soon, and mark it so callers never say "key not
// configured" for what was really a slow/unreachable credential service.
const UNAVAILABLE_TTL_MS = 3 * 1000;

// Non-enumerable marker so existing shape checks (toEqual({}), Object.keys)
// are unaffected; read it with isVaultUnavailable().
function markUnavailable(keys) {
  const copy = { ...(keys || {}) };
  Object.defineProperty(copy, 'vault_unavailable', { value: true, enumerable: false });
  return copy;
}

function isVaultUnavailable(keys) {
  return !!(keys && keys.vault_unavailable === true);
}

function credentialUnavailableResult(providerLabel) {
  return {
    success: false,
    error_code: 'credential_service_unavailable',
    error: `The credential service did not answer in time, so the ${providerLabel} key could not be read. Nothing is wrong with the key; try again.`,
  };
}

const _providerKeysCache = new Map();
let _testOverrides = null;

function _defaultAuthBaseUrl() {
  return `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
}

function resolveDeps(deps) {
  const base = {
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    buildInternalServiceHeaders,
    authBaseUrl: _defaultAuthBaseUrl(),
    // Vault credential resolver — MUST be injected by the caller. This
    // module intentionally has no vault-fetch implementation of its own;
    // server.js passes its resolveCredentials (with its circuit breaker) in,
    // so that orchestration is never duplicated.
    resolveCredentials: null,
  };
  return { ...base, ..._testOverrides, ...deps };
}

async function getProviderKeys(orgId, depsOverride) {
  const deps = resolveDeps(depsOverride);
  const now = Date.now();
  const cacheKey = orgId || 'default';
  const cached = _providerKeysCache.get(cacheKey);
  if (cached && (now - cached.checkedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  // Try QuoxVault resolver first
  const vaultKeys = {};
  const hasResolver = typeof deps.resolveCredentials === 'function';
  const resolved = hasResolver
    ? await deps.resolveCredentials(orgId, ['anthropic', 'openai', 'perplexity', 'gemini', 'brave', 'tavily'])
    : null;
  // The injected resolver returns null only when the call failed (timeout,
  // open breaker, non-2xx); a 2xx answer is always an object.
  let unavailable = hasResolver && !resolved;
  if (resolved?.providers) {
    for (const [provider, data] of Object.entries(resolved.providers)) {
      if (data?.key) {
        vaultKeys[`${provider}_api_key`] = data.key;
      }
    }
    if (Object.keys(vaultKeys).length === 0) {
      console.warn('[Provider Keys] Vault resolver returned empty — falling back to legacy');
    }
  }

  // Legacy fallback: direct endpoint. Always consulted (not just when the
  // vault resolved nothing) — a PARTIAL vault result must still be filled
  // in per-provider from the legacy set, never returned early on its own.
  // mergeProviderKeys() below keeps the vault value whenever both sources
  // resolve the same provider.
  let legacyKeys = {};
  const missingSomeProvider = PROVIDER_KEY_FIELDS.some((field) => !vaultKeys[field]);
  if (missingSomeProvider) {
    try {
      const resp = await deps.fetchImpl(`${deps.authBaseUrl}/api/setup/internal/provider-keys`, {
        headers: deps.buildInternalServiceHeaders(),
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        legacyKeys = await resp.json();
      } else {
        unavailable = true;
      }
    } catch (err) {
      unavailable = true;
      console.error('[Provider Keys] Legacy fallback failed:', err.message);
    }
  }

  const result = mergeProviderKeys(vaultKeys, legacyKeys);
  if (unavailable) {
    // Do not cache as a confirmed empty. Serve (and briefly park) what we
    // have, flagged, so a key-missing outcome reads as "service unavailable".
    const base = Object.keys(result).length > 0 ? result : (cached?.value || {});
    const flagged = markUnavailable(base);
    _providerKeysCache.set(cacheKey, {
      value: flagged,
      checkedAt: now - CACHE_TTL_MS + UNAVAILABLE_TTL_MS,
    });
    return flagged;
  }
  if (Object.keys(result).length > 0) {
    _providerKeysCache.set(cacheKey, { value: result, checkedAt: now });
    return result;
  }
  // Empty round: keep serving the last good value, but park a short negative
  // entry so the next N callers don't re-hammer auth while it recovers.
  const fallback = cached?.value ? { ...cached.value } : {};
  _providerKeysCache.set(cacheKey, {
    value: fallback,
    checkedAt: now - CACHE_TTL_MS + FAILURE_TTL_MS,
  });
  return fallback;
}

function clearCache() {
  _providerKeysCache.clear();
}

// Drop one org's entry (including a parked negative entry) so a caller that
// just saw an empty round can force a real re-resolve.
function invalidate(orgId) {
  _providerKeysCache.delete(orgId || 'default');
}

// Test-only hooks: inject deps and reset module-level state between cases.
const _testHooks = {
  setDeps(overrides) {
    _testOverrides = overrides || null;
  },
  reset() {
    _testOverrides = null;
    _providerKeysCache.clear();
  },
};

module.exports = {
  getProviderKeys,
  isVaultUnavailable,
  credentialUnavailableResult,
  clearCache,
  invalidate,
  PROVIDER_KEY_FIELDS,
  _testOverrides: _testHooks,
};
