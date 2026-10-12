import { MODEL_CATALOG } from '../config/modelCatalog.js'
import { getSeedLlmRoutingPolicy } from '../../shared/llm-routing/seedPolicy.js'
import { validateLlmRoutingPolicy } from '../../shared/llm-routing/validate.js'

const ASSISTANT_CAPABILITY_MAP = {
  quox: 'planning',
  prism: 'planning',
  forge: 'coding',
  quoxcode: 'coding',
  tester: 'coding',
  gemini: 'analysis',
  insight: 'analysis',
  corey: 'analysis',
  scholar: 'research',
  perplexity: 'research',
  imagesq: 'image_generation',
}

function normalizeTextParts(parts = []) {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

export function inferExecutionCapability({ assistantId = null, assistantConfig = null, isChief = false } = {}) {
  if (isChief || (assistantId && assistantId.startsWith('chief-'))) return 'executive_advisory'

  const normalizedId = assistantId?.startsWith('chief-') ? assistantId.slice(6) : assistantId
  if (normalizedId && ASSISTANT_CAPABILITY_MAP[normalizedId]) {
    return ASSISTANT_CAPABILITY_MAP[normalizedId]
  }

  const signature = normalizeTextParts([
    assistantConfig?.specialty,
    assistantConfig?.description,
    assistantConfig?.role,
    ...(assistantConfig?.domains || []),
    ...(assistantConfig?.toolCapabilities || []),
  ])

  if (/\bimage|vision|visual\b/.test(signature)) return 'image_generation'
  if (/\bresearch|search|fact|citation|current\b/.test(signature)) return 'research'
  if (/\bcode|coding\b/.test(signature)) return 'coding'
  if (/\breview|synthesis|analysis\b/.test(signature)) return 'analysis'
  if (/\bplan|strategy|orchestr|coordination\b/.test(signature)) return 'planning'

  return 'general_assistant'
}

export function getCapabilitySeedPolicy(policy = null) {
  return policy ? structuredClone(policy) : getSeedLlmRoutingPolicy()
}

export function getCapabilityPolicyDefault(capability, policy = null) {
  const seedPolicy = getCapabilitySeedPolicy(policy)
  const capabilityPolicy = seedPolicy.capabilities[capability] || seedPolicy.capabilities.general_assistant

  return {
    capability,
    capabilityLabel: capabilityPolicy.capabilityLabel,
    policyLabel: capabilityPolicy.policyLabel,
    provider: capabilityPolicy.primary.provider,
    model: capabilityPolicy.primary.model,
    fallbacks: capabilityPolicy.fallbacks || [],
    allowUserOverride: capabilityPolicy.allow_user_override !== false,
    // LLM-CHOICE Phase 1: per-capability no-OAuth override (optional).
    credentialConstraints: capabilityPolicy.credential_constraints
      ? { allowOAuth: capabilityPolicy.credential_constraints.allow_oauth }
      : null,
  }
}

export function getCapabilityPolicyContext(input = {}, policy = null) {
  const resolvedPolicy = getCapabilitySeedPolicy(policy)
  const capability = input.capabilityOverride || inferExecutionCapability(input)
  const capabilityPolicy = getCapabilityPolicyDefault(capability, resolvedPolicy)
  return {
    capability,
    capabilityLabel: capabilityPolicy.capabilityLabel,
    policyLabel: capabilityPolicy.policyLabel,
    policyEnabled: resolvedPolicy.enabled !== false,
    policyEnforcement: {
      ...(resolvedPolicy.enforcement || {}),
    },
    systemDefault: {
      provider: resolvedPolicy.system_default?.provider || null,
      model: resolvedPolicy.system_default?.model || null,
    },
    policyDefault: {
      provider: capabilityPolicy.provider,
      model: capabilityPolicy.model,
    },
    policyFallbacks: capabilityPolicy.fallbacks || [],
    allowUserOverride: capabilityPolicy.allowUserOverride,
    // LLM-CHOICE Phase 1: per-capability no-OAuth override (optional; null when unset).
    capabilityCredentialConstraints: capabilityPolicy.credentialConstraints || null,
  }
}

export function validateCapabilitySeedPolicy() {
  return validateLlmRoutingPolicy(getCapabilitySeedPolicy(), {
    modelCatalog: MODEL_CATALOG,
  })
}
