/**
 * Qortex embed-seam fix — provider-key merge semantics.
 *
 * getProviderKeys(orgId) in server.js (~line 609) resolves provider API
 * keys two ways: the QuoxVault resolver (org-scoped, preferred) and a
 * legacy fallback endpoint (auth /api/setup/internal/provider-keys,
 * instance-wide). The bug: when the vault resolver returned a PARTIAL set
 * (e.g. only anthropic), the function returned early with just those keys
 * and never consulted the legacy fallback, so a provider whose key only
 * ever lived in the legacy store (e.g. gemini_api_key on this instance)
 * was silently dropped — embedText() then found no gemini key and
 * returned null for every embed call.
 *
 * mergeProviderKeys() is the pure merge step, extracted so the semantics
 * are unit-testable without mocking fetch/resolveCredentials: vault wins
 * per-provider; any provider slot the vault didn't resolve is filled from
 * the legacy result. A vault key is never overwritten by a legacy key.
 * Unknown fields on either input (fields outside PROVIDER_KEY_FIELDS) are
 * dropped rather than merged through.
 */

const PROVIDER_KEY_FIELDS = [
  'anthropic_api_key',
  'openai_api_key',
  'perplexity_api_key',
  'gemini_api_key',
  'brave_api_key',
  'tavily_api_key',
];

/**
 * @param {object} [vaultKeys] - keys resolved via QuoxVault (may be partial or empty)
 * @param {object} [legacyKeys] - keys from the legacy provider-keys endpoint (may be partial or empty)
 * @returns {object} merged provider keys, vault taking precedence per field
 */
function mergeProviderKeys(vaultKeys = {}, legacyKeys = {}) {
  const merged = {};
  for (const field of PROVIDER_KEY_FIELDS) {
    if (vaultKeys && vaultKeys[field]) {
      merged[field] = vaultKeys[field];
    } else if (legacyKeys && legacyKeys[field]) {
      merged[field] = legacyKeys[field];
    }
  }
  return merged;
}

module.exports = { mergeProviderKeys, PROVIDER_KEY_FIELDS };
