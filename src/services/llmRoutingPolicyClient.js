import { getSeedLlmRoutingPolicy } from '../../shared/llm-routing/seedPolicy.js'

const policyCache = new Map()

function getCachedPolicy(orgId) {
  const entry = policyCache.get(orgId)
  if (!entry) return null
  if ((Date.now() - entry.timestamp) > 60000) {
    policyCache.delete(orgId)
    return null
  }
  return entry.value
}

export function getSeedPolicyPayload() {
  return {
    source: 'seed',
    policy: getSeedLlmRoutingPolicy(),
    record: null,
  }
}

export async function fetchLlmRoutingPolicy(authFetch, orgId, { force = false } = {}) {
  if (!orgId || !authFetch) return getSeedPolicyPayload()

  if (!force) {
    const cached = getCachedPolicy(orgId)
    if (cached) return cached
  }

  try {
    const response = await authFetch(`/api/orgs/${orgId}/llm-routing-policy`)
    if (!response.ok) return getSeedPolicyPayload()
    const data = await response.json()
    policyCache.set(orgId, { value: data, timestamp: Date.now() })
    return data
  } catch (error) {
    console.warn('[LlmRoutingPolicy] Failed to fetch org policy:', error.message)
    return getSeedPolicyPayload()
  }
}

export async function testLlmRoutingPolicy(authFetch, orgId, policy) {
  const response = await authFetch(`/api/orgs/${orgId}/llm-routing-policy/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || 'Failed to validate execution policy')
  }
  return response.json()
}

export async function saveLlmRoutingPolicy(authFetch, orgId, policy) {
  const response = await authFetch(`/api/orgs/${orgId}/llm-routing-policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || 'Failed to save execution policy')
    error.validationErrors = data.validation_errors || []
    throw error
  }

  policyCache.set(orgId, { value: { source: 'org', policy: data.policy, record: null }, timestamp: Date.now() })
  void fetch('/collector/chat/policy-cache/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ org_id: orgId }),
  }).catch((error) => {
    console.warn('[LlmRoutingPolicy] Failed to invalidate collector cache:', error.message)
  })
  return data
}

export async function resolveLlmExecutionPlan({
  orgId = null,
  selectedAgent = 'quox',
  capability = null,
  provider = null,
  model = null,
  credentialId = null,
  policy = null,
  personalPreference = null,
} = {}) {
  const response = await fetch('/collector/chat/resolve-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      org_id: orgId,
      selected_agent: selectedAgent,
      capability_override: capability,
      provider,
      model,
      credential_id: credentialId,
      policy_override: policy,
      personal_preference_override: personalPreference,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || 'Failed to resolve execution plan')
    error.validationErrors = data.validation_errors || []
    throw error
  }

  return data
}

export function clearLlmRoutingPolicyCache(orgId = null) {
  if (orgId) {
    policyCache.delete(orgId)
    return
  }
  policyCache.clear()
}
