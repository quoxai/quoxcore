import { EXECUTION_CAPABILITIES, LLM_POLICY_VERSION, getLlmIdentityKey } from './contract.js'

function buildProviderModelIndex(modelCatalog) {
  return Object.fromEntries(
    Object.entries(modelCatalog || {}).map(([providerId, provider]) => [
      providerId,
      new Set((provider?.models || []).map(model => model.id)),
    ]),
  )
}

function validateLlmReference(llm, path, providerModels, errors) {
  if (!llm || typeof llm !== 'object') {
    errors.push(`${path} must be an object`)
    return
  }

  if (!llm.provider || typeof llm.provider !== 'string') {
    errors.push(`${path}.provider is required`)
    return
  }

  if (!providerModels[llm.provider]) {
    errors.push(`${path}.provider '${llm.provider}' is not in the model catalog`)
    return
  }

  if (!llm.model || typeof llm.model !== 'string') {
    errors.push(`${path}.model is required`)
    return
  }

  if (!providerModels[llm.provider].has(llm.model)) {
    errors.push(`${path}.model '${llm.model}' is not valid for provider '${llm.provider}'`)
  }
}

export function validateLlmRoutingPolicy(policy, { modelCatalog = {} } = {}) {
  const errors = []
  const providerModels = buildProviderModelIndex(modelCatalog)

  if (!policy || typeof policy !== 'object') {
    return { valid: false, errors: ['policy must be an object'] }
  }

  if (policy.version !== LLM_POLICY_VERSION) {
    errors.push(`policy.version must be ${LLM_POLICY_VERSION}`)
  }

  if (!policy.policy_id || typeof policy.policy_id !== 'string') {
    errors.push('policy.policy_id is required')
  }

  if (typeof policy.enabled !== 'boolean') {
    errors.push('policy.enabled must be a boolean')
  }

  if (!policy.enforcement || typeof policy.enforcement !== 'object') {
    errors.push('policy.enforcement must be an object')
  } else {
    ;[
      'allow_user_provider_override',
      'allow_user_model_override',
      'credential_selection_priority',
      'block_hidden_fallbacks',
    ].forEach((field) => {
      if (typeof policy.enforcement[field] !== 'boolean') {
        errors.push(`policy.enforcement.${field} must be a boolean`)
      }
    })

    // LLM-CHOICE Phase 1: allow_oauth_credentials is OPTIONAL — existing
    // stored org policies predate this field and must still validate.
    // Defaults to true (OAuth allowed) when absent; see resolveCollectorPolicyPlan.
    if (policy.enforcement.allow_oauth_credentials !== undefined
      && typeof policy.enforcement.allow_oauth_credentials !== 'boolean') {
      errors.push('policy.enforcement.allow_oauth_credentials must be a boolean when present')
    }
  }

  validateLlmReference(policy.system_default, 'system_default', providerModels, errors)

  if (!policy.capabilities || typeof policy.capabilities !== 'object') {
    errors.push('policy.capabilities must be an object')
  } else {
    for (const capability of EXECUTION_CAPABILITIES) {
      const capabilityPolicy = policy.capabilities[capability]
      if (!capabilityPolicy || typeof capabilityPolicy !== 'object') {
        errors.push(`capabilities.${capability} must be defined`)
        continue
      }

      validateLlmReference(
        capabilityPolicy.primary,
        `capabilities.${capability}.primary`,
        providerModels,
        errors,
      )

      // LLM-CHOICE Phase 1: credential_constraints is OPTIONAL per capability.
      // Existing stored capability configs predate this field.
      if (capabilityPolicy.credential_constraints !== undefined) {
        if (typeof capabilityPolicy.credential_constraints !== 'object' || capabilityPolicy.credential_constraints === null) {
          errors.push(`capabilities.${capability}.credential_constraints must be an object when present`)
        } else if (
          capabilityPolicy.credential_constraints.allow_oauth !== undefined
          && typeof capabilityPolicy.credential_constraints.allow_oauth !== 'boolean'
        ) {
          errors.push(`capabilities.${capability}.credential_constraints.allow_oauth must be a boolean when present`)
        }
      }

      if (!Array.isArray(capabilityPolicy.fallbacks)) {
        errors.push(`capabilities.${capability}.fallbacks must be an array`)
        continue
      }

      if (typeof capabilityPolicy.allow_user_override !== 'boolean') {
        errors.push(`capabilities.${capability}.allow_user_override must be a boolean`)
      }

      const seenKeys = new Set()
      const primaryKey = getLlmIdentityKey(capabilityPolicy.primary)
      if (primaryKey !== ':') {
        seenKeys.add(primaryKey)
      }

      capabilityPolicy.fallbacks.forEach((fallback, index) => {
        const path = `capabilities.${capability}.fallbacks[${index}]`
        validateLlmReference(fallback, path, providerModels, errors)
        const identityKey = getLlmIdentityKey(fallback)
        if (seenKeys.has(identityKey)) {
          errors.push(`${path} duplicates an earlier provider/model in the fallback chain`)
        } else {
          seenKeys.add(identityKey)
        }
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
