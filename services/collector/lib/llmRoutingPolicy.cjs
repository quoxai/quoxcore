const path = require('path')
const { pathToFileURL } = require('url')

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
const POLICY_CACHE_TTL_MS = 30000

let policyCache = new Map()
let routingModulesPromise = null

function resetPolicyCache() {
  policyCache = new Map()
}

function invalidatePolicyCache(orgId = null) {
  if (!orgId) {
    resetPolicyCache()
    return
  }
  policyCache.delete(orgId)
}

// Resolves a path relative to this file to an absolute file:// URL.
//
// Vitest note: dynamic import() with a *relative* specifier here can throw a
// spurious "Cannot find module" under `vitest run --root services/collector`
// once two or more of these modules (which share transitive deps, e.g.
// resolve.js and modelCatalog.js both reach shared/llm-routing/contract.js)
// are imported together — vite-node's SSR loader resolves the relative
// specifier against the wrong base URL in that case. Plain Node's import()
// resolves the same relative specifiers correctly (verified). Using an
// absolute file:// URL sidesteps relative-specifier base-URL resolution
// entirely, avoiding the vite-node bug without changing runtime behavior.
function toModuleUrl(relPath) {
  return pathToFileURL(path.join(__dirname, relPath)).href
}

// Import helper: tries repo layout first (../../../), then container layout (../)
// Repo:      services/collector/lib/ → ../../.. → repo root → shared/, src/
// Container: /app/lib/              → ..       → /app       → shared/, src/
async function importWithFallback(repoPath, containerPath) {
  try {
    return await import(toModuleUrl(repoPath))
  } catch {
    return await import(toModuleUrl(containerPath))
  }
}

async function loadRoutingModules() {
  if (!routingModulesPromise) {
    routingModulesPromise = Promise.all([
      importWithFallback('../../../shared/llm-routing/resolve.js', '../shared/llm-routing/resolve.js'),
      importWithFallback('../../../shared/llm-routing/seedPolicy.js', '../shared/llm-routing/seedPolicy.js'),
      importWithFallback('../../../shared/llm-routing/validate.js', '../shared/llm-routing/validate.js'),
      importWithFallback('../../../src/config/modelCatalog.js', '../src/config/modelCatalog.js'),
      importWithFallback('../../../src/services/llmCapabilityPolicy.js', '../src/services/llmCapabilityPolicy.js'),
    ]).then(([resolveModule, seedModule, validateModule, modelCatalogModule, capabilityModule]) => ({
      ...resolveModule,
      ...seedModule,
      ...validateModule,
      ...modelCatalogModule,
      ...capabilityModule,
    }))
  }
  return routingModulesPromise
}

async function fetchOrgPolicy(orgId, userAccessToken) {
  const cacheKey = orgId || 'default'
  const cached = policyCache.get(cacheKey)
  if (cached && (Date.now() - cached.timestamp) < POLICY_CACHE_TTL_MS) {
    return cached.value
  }

  const modules = await loadRoutingModules()

  if (!orgId) {
    const seed = { source: 'seed', policy: modules.getSeedLlmRoutingPolicy(), record: null }
    policyCache.set(cacheKey, { value: seed, timestamp: Date.now() })
    return seed
  }

  // Use JWT if available, otherwise use service key via internal endpoint
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
  let policyUrl, headers

  if (userAccessToken) {
    policyUrl = `${AUTH_BASE_URL}/api/orgs/${orgId}/llm-routing-policy`
    headers = { Authorization: `Bearer ${userAccessToken}` }
  } else if (serviceKey) {
    policyUrl = `${AUTH_BASE_URL}/api/internal/orgs/${orgId}/llm-routing-policy`
    headers = { 'X-Service-Key': serviceKey }
  } else {
    const seed = { source: 'seed', policy: modules.getSeedLlmRoutingPolicy(), record: null }
    policyCache.set(cacheKey, { value: seed, timestamp: Date.now() })
    return seed
  }

  try {
    const response = await fetch(policyUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) {
      const data = await response.json()
      policyCache.set(cacheKey, { value: data, timestamp: Date.now() })
      return data
    }
    if (cached) {
      console.warn(`[CollectorPolicy] Policy fetch returned ${response.status}; preserving last known policy for ${cacheKey}`)
      return cached.value
    }
  } catch (error) {
    console.warn('[CollectorPolicy] Failed to fetch org policy:', error.message)
    if (cached) {
      return cached.value
    }
  }

  const seed = { source: 'seed', policy: modules.getSeedLlmRoutingPolicy(), record: null }
  policyCache.set(cacheKey, { value: seed, timestamp: Date.now() })
  return seed
}

function hasProviderAuth(provider, { providerKeys = {}, anthropicApiKey = '', cliOAuthToken = '', vaultCredential = null, localSource = null, allowOAuth = true } = {}) {
  if (vaultCredential?.provider === provider && vaultCredential?.key) return true
  if (provider === 'anthropic') {
    if (allowOAuth === false) return !!anthropicApiKey
    return !!(anthropicApiKey || cliOAuthToken)
  }
  if (provider === 'openai') return !!providerKeys.openai_api_key
  if (provider === 'perplexity') return !!providerKeys.perplexity_api_key
  if (provider === 'gemini') return !!providerKeys.gemini_api_key
  if (provider === 'local') return !!localSource
  return true
}

function getSystemDefaultFallback(policyContext, plan) {
  const provider = policyContext?.systemDefault?.provider || null
  const model = policyContext?.systemDefault?.model || null
  if (!provider || !model) return null
  if (provider === plan?.provider && model === plan?.model) return null
  return { provider, model }
}

async function resolveCollectorPolicyPlan({
  orgId,
  userAccessToken,
  selectedAgent,
  capabilityOverride = null,
  requestedProvider,
  requestedModel,
  requestedCredentialId,
  credentialMeta = null,
  policyOverride = null,
  personalPreferenceOverride = null,
  assistantRecommendation = null,
  specialistLock = null,
  isChief = false,
  anthropicApiKey = '',
  cliOAuthToken = '',
  providerKeys = {},
  localSource = null,
}) {
  const modules = await loadRoutingModules()
  let policyPayload = null

  if (policyOverride) {
    const validation = modules.validateLlmRoutingPolicy(policyOverride, {
      modelCatalog: modules.MODEL_CATALOG,
    })
    if (!validation.valid) {
      const error = new Error('Invalid policy override')
      error.validationErrors = validation.errors
      throw error
    }
    policyPayload = { source: 'override', policy: policyOverride, record: null }
  } else {
    policyPayload = await fetchOrgPolicy(orgId, userAccessToken)
  }

  const policyContext = modules.getCapabilityPolicyContext({
    assistantId: selectedAgent,
    isChief,
    capabilityOverride,
  }, policyPayload.policy)

  // LLM-CHOICE Phase 1: capability-level credential_constraints.allow_oauth
  // beats the org policy root's enforcement.allow_oauth_credentials, which
  // beats the system default of true (OAuth/CLI allowed).
  const allowOAuth = policyContext.capabilityCredentialConstraints?.allowOAuth
    ?? policyContext.policyEnforcement?.allow_oauth_credentials
    ?? true

  let plan = modules.resolveExecutionPlan({
    userSelection: {
      provider: requestedProvider,
      model: requestedModel,
      credentialId: requestedCredentialId,
    },
    credentialMeta,
    capability: policyContext.capability,
    capabilityLabel: policyContext.capabilityLabel,
    policyLabel: policyContext.policyLabel,
    policyEnabled: policyContext.policyEnabled,
    policyEnforcement: policyContext.policyEnforcement,
    capabilityAllowUserOverride: policyContext.allowUserOverride,
    personalPreference: personalPreferenceOverride,
    policyDefault: policyContext.policyDefault,
    assistantRecommendation,
    specialistLock,
    systemDefault: policyContext.systemDefault,
  })

  const fallbackChain = []
  const allowHiddenFallbacks = plan.source === 'policy_default'
    && policyContext.policyEnabled !== false
    && policyContext.policyEnforcement?.block_hidden_fallbacks !== false

  if (!requestedCredentialId && allowHiddenFallbacks && Array.isArray(policyContext.policyFallbacks)) {
    let selectedFallback = null
    let selectedFallbackSource = null
    if (!hasProviderAuth(plan.provider, { providerKeys, anthropicApiKey, cliOAuthToken, localSource, allowOAuth })) {
      for (const fallback of policyContext.policyFallbacks) {
        fallbackChain.push({ provider: fallback.provider, model: fallback.model })
        if (hasProviderAuth(fallback.provider, { providerKeys, anthropicApiKey, cliOAuthToken, localSource, allowOAuth })) {
          selectedFallback = fallback
          selectedFallbackSource = 'policy_fallback'
          break
        }
      }
      if (!selectedFallback) {
        const systemFallback = getSystemDefaultFallback(policyContext, plan)
        if (systemFallback) {
          fallbackChain.push(systemFallback)
          if (hasProviderAuth(systemFallback.provider, { providerKeys, anthropicApiKey, cliOAuthToken, localSource, allowOAuth })) {
            selectedFallback = systemFallback
            selectedFallbackSource = 'system_default'
          }
        }
      }
    }

    if (selectedFallback) {
      plan = {
        ...plan,
        provider: selectedFallback.provider,
        model: selectedFallback.model,
        source: selectedFallbackSource === 'system_default' ? 'system_default' : plan.source,
        fallbackChain,
        reasons: [
          ...plan.reasons,
          selectedFallbackSource === 'system_default'
            ? `Policy default was unavailable; fell back to system default ${selectedFallback.provider}/${selectedFallback.model}.`
            : `Policy fallback selected ${selectedFallback.provider}/${selectedFallback.model}.`,
        ],
      }
    } else if (!hasProviderAuth(plan.provider, { providerKeys, anthropicApiKey, cliOAuthToken, localSource, allowOAuth })) {
      plan = {
        ...plan,
        fallbackChain,
        reasons: [...plan.reasons, `No declared policy fallback was available for ${plan.provider}/${plan.model}.`],
      }
    } else {
      plan = {
        ...plan,
        fallbackChain,
      }
    }
  }

  // LLM-CHOICE Phase 1: surface the resolved credential constraint so
  // downstream dispatch (server.js fast path, stackModeDispatch) knows
  // whether the OAuth/CLI path is permitted for this plan.
  plan = {
    ...plan,
    credentialConstraints: { allowOAuth },
  }

  return {
    plan,
    policyPayload,
    policyContext,
  }
}

module.exports = {
  resolveCollectorPolicyPlan,
  hasProviderAuth,
  resetPolicyCache,
  invalidatePolicyCache,
}
