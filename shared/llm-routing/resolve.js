import { MODEL_CATALOG, getDefaultModel as getCatalogDefaultModel } from '../../src/config/modelCatalog.js'
import { DEFAULT_LLM_CONFIG } from '../../src/services/llmService.js'
import { DEFAULT_EXECUTION_POLICY_ENFORCEMENT, VERIFIED_PROVIDERS, PARITY_FALLBACK_PROVIDER } from './contract.js'

function getProviderIds() {
  return Object.keys(MODEL_CATALOG)
}

export function inferProviderFromModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return null

  for (const providerId of getProviderIds()) {
    const provider = MODEL_CATALOG[providerId]
    if (provider?.models?.some(model => model.id === modelId)) {
      return providerId
    }
  }

  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai'
  if (modelId.startsWith('claude-')) return 'anthropic'
  if (modelId.startsWith('gemini-')) return 'gemini'
  if (modelId.includes('sonar')) return 'perplexity'
  if (modelId.startsWith('grok-')) return 'xai'
  if (modelId.startsWith('deepseek-')) return 'deepseek'

  return null
}

export function getProviderDefaultModelId(providerId) {
  return getCatalogDefaultModel(providerId)?.id || null
}

function buildCandidate({ source, llm, credentialId = null, credentialLabel = null, locked = false, policyLabel = null, capabilityLabel = null }) {
  return {
    source,
    provider: llm?.provider || null,
    model: llm?.model || null,
    temperature: llm?.temperature,
    maxTokens: llm?.maxTokens,
    credentialId,
    credentialLabel,
    locked,
    policyLabel,
    capabilityLabel,
  }
}

function llmMatches(candidate, baseline) {
  if (!baseline) return false
  const providerMatches = !baseline.provider || candidate.provider === baseline.provider
  const modelMatches = !baseline.model || candidate.model === baseline.model
  return providerMatches && modelMatches
}

function hasLlmSelection(llm) {
  return !!(llm?.provider || llm?.model)
}

function normalizeEnforcement(enforcement = null) {
  return {
    ...DEFAULT_EXECUTION_POLICY_ENFORCEMENT,
    ...(enforcement || {}),
  }
}

function sanitizeUserSelection({
  userSelection,
  recommendedDefault,
  capabilityAllowUserOverride,
  policyEnforcement,
  reasons,
  coercions,
}) {
  const normalized = {
    provider: userSelection?.provider || null,
    model: userSelection?.model || null,
    credentialId: userSelection?.credentialId || null,
  }

  if (!hasLlmSelection(normalized)) {
    return normalized
  }

  if (!capabilityAllowUserOverride) {
    coercions.userOverrideBlocked = true
    reasons.push('Capability policy blocked manual user overrides.')
    return {
      provider: null,
      model: null,
      credentialId: normalized.credentialId,
    }
  }

  const recommendedProvider = recommendedDefault?.provider || null
  const recommendedModel = recommendedDefault?.model || null
  const selectionProvider = normalized.provider || inferProviderFromModelId(normalized.model)

  if (!policyEnforcement.allow_user_provider_override) {
    const providerDiffers = !!(selectionProvider && recommendedProvider && selectionProvider !== recommendedProvider)
    if (providerDiffers) {
      coercions.userOverrideBlocked = true
      reasons.push(`Policy blocked provider override away from ${recommendedProvider}.`)
      return {
        provider: recommendedProvider,
        model: recommendedModel,
        credentialId: normalized.credentialId,
      }
    }
  }

  if (!policyEnforcement.allow_user_model_override && normalized.model) {
    const providerForModelCheck = normalized.provider || selectionProvider || recommendedProvider
    const modelDiffers = !recommendedModel || normalized.model !== recommendedModel || providerForModelCheck !== recommendedProvider
    if (modelDiffers) {
      coercions.userOverrideBlocked = true
      reasons.push(`Policy blocked model override away from ${recommendedModel || 'the recommended default'}.`)
      return {
        provider: normalized.provider,
        model: normalized.provider && normalized.provider !== recommendedProvider ? null : recommendedModel,
        credentialId: normalized.credentialId,
      }
    }
  }

  return normalized
}

export function resolveExecutionPlan({
  userSelection = null,
  credentialMeta = null,
  personalPreference = null,
  policyDefault = null,
  assistantRecommendation = null,
  specialistLock = null,
  systemDefault = DEFAULT_LLM_CONFIG,
  capability = null,
  capabilityLabel = null,
  policyLabel = null,
  policyEnabled = true,
  policyEnforcement = null,
  capabilityAllowUserOverride = true,
} = {}) {
  const reasons = []
  const coercions = {
    providerByCredential: false,
    modelByCredential: false,
    providerInferredFromModel: false,
    modelDefaultedForProvider: false,
    invalidModelReplaced: false,
    userOverrideBlocked: false,
    credentialIgnoredByPolicy: false,
    policyDisabled: false,
  }
  const effectiveSystemDefault = hasLlmSelection(systemDefault) ? systemDefault : DEFAULT_LLM_CONFIG
  const enforcement = normalizeEnforcement(policyEnforcement)
  const effectivePolicyDefault = policyEnabled ? policyDefault : null
  const effectivePersonalPreference = policyEnabled ? personalPreference : null

  if (!policyEnabled && (hasLlmSelection(policyDefault) || hasLlmSelection(personalPreference))) {
    coercions.policyDisabled = true
    reasons.push('Execution policy is disabled; policy defaults and personal preferences were bypassed.')
  }

  const recommendedDefault = effectivePersonalPreference
    || effectivePolicyDefault
    || assistantRecommendation
    || effectiveSystemDefault

  const normalizedUserSelection = sanitizeUserSelection({
    userSelection,
    recommendedDefault,
    capabilityAllowUserOverride,
    policyEnforcement: enforcement,
    reasons,
    coercions,
  })

  const credentialProvider = credentialMeta?.provider || null
  const credentialLabel = credentialMeta?.label || null
  const credentialId = normalizedUserSelection.credentialId || credentialMeta?.id || null

  if (specialistLock?.provider && specialistLock?.model) {
    const plan = buildCandidate({
      source: 'specialist_lock',
      llm: specialistLock,
      credentialId,
      credentialLabel,
      locked: true,
      policyLabel,
      capabilityLabel,
    })

    reasons.push(`Specialist lock selected ${plan.provider}/${plan.model}.`)

    return {
      capability,
      ...plan,
      selectionMode: 'locked',
      credentialProvider,
      fallbackChain: [],
      coercions,
      reasons,
    }
  }

  let candidate = null

  const canUseCredentialSelection = credentialProvider && (
    enforcement.credential_selection_priority
    || !hasLlmSelection(normalizedUserSelection)
  )

  if (credentialProvider && canUseCredentialSelection) {
    candidate = buildCandidate({
      source: 'vault_credential_selection',
      llm: {
        ...normalizedUserSelection,
        provider: credentialProvider,
      },
      credentialId,
      credentialLabel,
    })

    reasons.push(`Vault credential selected for provider ${credentialProvider}.`)

    if (normalizedUserSelection.provider && normalizedUserSelection.provider !== credentialProvider) {
      coercions.providerByCredential = true
      reasons.push(`Credential provider overrode requested provider ${normalizedUserSelection.provider}.`)
    }

    const requestedModelProvider = inferProviderFromModelId(normalizedUserSelection.model)
    if (normalizedUserSelection.model && requestedModelProvider && requestedModelProvider !== credentialProvider) {
      coercions.modelByCredential = true
      candidate.model = null
      reasons.push(`Credential provider rejected incompatible requested model ${normalizedUserSelection.model}.`)
    }
  } else if (credentialProvider && !canUseCredentialSelection) {
    coercions.credentialIgnoredByPolicy = true
    reasons.push('Policy prevented the selected credential from overriding provider/model routing.')
  }

  if (!candidate) {
    if (normalizedUserSelection.provider || normalizedUserSelection.model) {
      if (llmMatches(normalizedUserSelection, effectivePersonalPreference)) {
        candidate = buildCandidate({
          source: 'personal_preference',
          llm: effectivePersonalPreference,
          credentialId,
          credentialLabel,
          capabilityLabel,
        })
        reasons.push('Using personal capability preference.')
      } else if (llmMatches(normalizedUserSelection, effectivePolicyDefault)) {
        candidate = buildCandidate({
          source: 'policy_default',
          llm: effectivePolicyDefault,
          credentialId,
          credentialLabel,
          policyLabel,
          capabilityLabel,
        })
        reasons.push('Using policy default.')
      } else if (llmMatches(normalizedUserSelection, assistantRecommendation)) {
        candidate = buildCandidate({
          source: 'assistant_recommendation',
          llm: assistantRecommendation,
          credentialId,
          credentialLabel,
        })
        reasons.push('Using assistant recommendation.')
      } else if (llmMatches(normalizedUserSelection, effectiveSystemDefault)) {
        candidate = buildCandidate({
          source: 'system_default',
          llm: effectiveSystemDefault,
          credentialId,
          credentialLabel,
        })
        reasons.push('Using system default.')
      } else {
        candidate = buildCandidate({
          source: 'user_selection',
          llm: normalizedUserSelection,
          credentialId,
          credentialLabel,
        })
        reasons.push('Using explicit user selection.')
      }
    } else if (hasLlmSelection(effectivePersonalPreference)) {
      candidate = buildCandidate({
        source: 'personal_preference',
        llm: effectivePersonalPreference,
        credentialId,
        credentialLabel,
        capabilityLabel,
      })
      reasons.push('Using personal capability preference.')
    } else if (hasLlmSelection(effectivePolicyDefault)) {
      candidate = buildCandidate({
        source: 'policy_default',
        llm: effectivePolicyDefault,
        credentialId,
        credentialLabel,
        policyLabel,
        capabilityLabel,
      })
      reasons.push('Using policy default.')
    } else if (assistantRecommendation?.provider || assistantRecommendation?.model) {
      candidate = buildCandidate({
        source: 'assistant_recommendation',
        llm: assistantRecommendation,
        credentialId,
        credentialLabel,
      })
      reasons.push('Using assistant recommendation.')
    } else {
      candidate = buildCandidate({
        source: 'system_default',
        llm: effectiveSystemDefault,
        credentialId,
        credentialLabel,
      })
      reasons.push('Using system default.')
    }
  }

  if (!candidate.provider && candidate.model) {
    candidate.provider = inferProviderFromModelId(candidate.model)
    if (candidate.provider) {
      coercions.providerInferredFromModel = true
      reasons.push(`Provider inferred from model ${candidate.model}.`)
    }
  }

  if (!candidate.provider) {
    candidate.provider = effectiveSystemDefault.provider
    reasons.push(`Provider fell back to system default ${candidate.provider}.`)
  }

  const providerExists = !!MODEL_CATALOG[candidate.provider]
  if (!providerExists) {
    reasons.push(`Unknown provider ${candidate.provider}; replaced with system default ${effectiveSystemDefault.provider}.`)
    candidate.provider = effectiveSystemDefault.provider
    candidate.model = effectiveSystemDefault.model
    coercions.invalidModelReplaced = true
  }

  const providerModels = MODEL_CATALOG[candidate.provider]?.models || []
  const modelExistsForProvider = candidate.model && providerModels.some(model => model.id === candidate.model)
  const modelProvider = inferProviderFromModelId(candidate.model)

  if (candidate.model && modelProvider && modelProvider !== candidate.provider) {
    candidate.model = null
    coercions.invalidModelReplaced = true
    reasons.push(`Model/provider mismatch detected; resetting model for ${candidate.provider}.`)
  } else if (candidate.model && !modelExistsForProvider) {
    candidate.model = null
    coercions.invalidModelReplaced = true
    reasons.push(`Unknown model for provider ${candidate.provider}; resetting to provider default.`)
  }

  if (!candidate.model) {
    candidate.model = getProviderDefaultModelId(candidate.provider) || effectiveSystemDefault.model
    coercions.modelDefaultedForProvider = true
    reasons.push(`Model defaulted for provider ${candidate.provider}.`)
  }

  // Provider parity gate: coerce non-explicit selections away from unverified providers.
  // This is the AOCL-native replacement for the external providerExecutionGuard.
  // Explicit sources (user_selection, vault_credential_selection, specialist_lock) are never coerced.
  const EXPLICIT_SOURCES = new Set(['user_selection', 'vault_credential_selection', 'specialist_lock'])
  if (
    enforcement.require_explicit_for_non_default_provider
    && candidate.provider
    && !EXPLICIT_SOURCES.has(candidate.source)
    && !VERIFIED_PROVIDERS.includes(candidate.provider)
  ) {
    const fallbackProvider = PARITY_FALLBACK_PROVIDER
    const fallbackModel = getProviderDefaultModelId(fallbackProvider) || effectiveSystemDefault.model
    reasons.push(`Provider ${candidate.provider} lacks verified parity; coerced to ${fallbackProvider}/${fallbackModel}.`)
    coercions.providerParityGuard = true
    candidate.provider = fallbackProvider
    candidate.model = fallbackModel
  }

  return {
    ...candidate,
    capability,
    capabilityLabel: candidate.capabilityLabel || capabilityLabel,
    policyLabel: candidate.policyLabel || policyLabel,
    selectionMode: candidate.source === 'specialist_lock' ? 'locked' : 'recommended',
    credentialProvider,
    fallbackChain: [],
    coercions,
    reasons,
  }
}

export function buildExecutionTracePayload(plan, overrides = {}) {
  if (!plan) return { ...overrides }

  return {
    target: plan.provider || 'llm',
    targetType: 'llm',
    provider: plan.provider || null,
    model: plan.model || null,
    source: plan.source || null,
    selectionMode: plan.selectionMode || null,
    capability: plan.capability || null,
    capabilityLabel: plan.capabilityLabel || null,
    policyLabel: plan.policyLabel || null,
    reasons: plan.reasons || [],
    coercions: plan.coercions || {},
    credentialId: plan.credentialId || null,
    credentialLabel: plan.credentialLabel || null,
    credentialProvider: plan.credentialProvider || null,
    fallbackChain: plan.fallbackChain || [],
    ...overrides,
  }
}
