/**
 * GOV-1: Policy Store Client
 *
 * Frontend client for the unified governance policy store.
 * Talks to collector /api/v1/policies endpoints.
 * Replaces quoxflowClient policy functions.
 */

const COLLECTOR_BASE = import.meta.env.VITE_COLLECTOR_URL || '/collector'
const CACHE_TTL = 30000 // 30 seconds

const policyCache = new Map()

function getCached(key) {
  const entry = policyCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    policyCache.delete(key)
    return null
  }
  return entry.value
}

function setCache(key, value) {
  policyCache.set(key, { value, ts: Date.now() })
}

export function clearPolicyCache() {
  policyCache.clear()
}

async function policyFetch(path, options = {}) {
  const url = `${COLLECTOR_BASE}/api/v1/policies${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Policy API error: ${res.status}`)
  }
  return res.json()
}

/**
 * List policies for an org
 */
export async function listPolicies(orgId, { category, enabled, effect, limit, offset, force } = {}) {
  const params = new URLSearchParams({ org_id: orgId })
  if (category) params.set('category', category)
  if (enabled !== undefined) params.set('enabled', String(enabled))
  if (effect) params.set('effect', effect)
  if (limit) params.set('limit', String(limit))
  if (offset) params.set('offset', String(offset))

  const cacheKey = `list:${params.toString()}`
  if (!force) {
    const cached = getCached(cacheKey)
    if (cached) return cached
  }

  const result = await policyFetch(`?${params.toString()}`)
  setCache(cacheKey, result)
  return result
}

/**
 * Get a single policy by ID
 */
export async function getPolicy(id) {
  const cached = getCached(`get:${id}`)
  if (cached) return cached.policy

  const result = await policyFetch(`/${id}`)
  setCache(`get:${id}`, result)
  return result.policy
}

/**
 * Create a new policy
 */
export async function createPolicy(policy) {
  const result = await policyFetch('', {
    method: 'POST',
    body: JSON.stringify(policy),
  })
  clearPolicyCache()
  return result.policy
}

/**
 * Update a policy
 */
export async function updatePolicy(id, updates) {
  const result = await policyFetch(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
  clearPolicyCache()
  return result.policy
}

/**
 * Delete a policy
 */
export async function deletePolicy(id) {
  const result = await policyFetch(`/${id}`, {
    method: 'DELETE',
  })
  clearPolicyCache()
  return result
}

/**
 * Validate a policy without saving
 */
export async function validatePolicy(policy) {
  return policyFetch('/validate', {
    method: 'POST',
    body: JSON.stringify(policy),
  })
}

/**
 * Fetch all active (enabled) policies for an org.
 * Used by policyGate.js to evaluate incoming requests.
 * Returns cached result if available and not expired.
 * Falls back to empty array on error (policyGate will use hardcoded defaults).
 */
export async function fetchActivePolicies(orgId) {
  if (!orgId) orgId = '__system__'

  const cacheKey = `active:${orgId}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  try {
    const result = await listPolicies(orgId, { enabled: true, limit: 500 })
    const policies = result.data || []
    // Sort by priority DESC (highest priority first)
    policies.sort((a, b) => (b.priority || 0) - (a.priority || 0))
    setCache(cacheKey, policies)
    return policies
  } catch (err) {
    console.warn('[PolicyStore] Failed to fetch active policies:', err.message)
    return []
  }
}

/**
 * GOV-7: Template pack API
 */
export async function listTemplatePacks() {
  return policyFetch('/templates')
}

export async function getTemplatePack(packId) {
  return policyFetch(`/templates/${packId}`)
}

export async function checkTemplateConflicts(packId, orgId) {
  return policyFetch(`/templates/${packId}/conflicts`, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId }),
  })
}

export async function enableTemplatePack(packId, orgId, createdBy) {
  const result = await policyFetch(`/templates/${packId}/enable`, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, created_by: createdBy }),
  })
  clearPolicyCache()
  return result
}

/**
 * Policy categories and effects (mirrors server constants)
 */
export const POLICY_CATEGORIES = ['safety', 'execution', 'governance', 'compliance']
export const POLICY_EFFECTS = ['allow', 'deny', 'require_approval', 'redact', 'log_only']
