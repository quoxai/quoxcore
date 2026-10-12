const PREFERENCE_NAMESPACE = 'llmCapabilityPreferences'
const preferenceCache = new Map()

function getEmptyPreferencePayload() {
  return {
    source: 'member',
    preferences: {
      capabilities: {},
    },
  }
}

function normalizePreferences(preferences = {}) {
  return {
    capabilities: {
      ...(preferences.capabilities || {}),
    },
  }
}

function getCached(orgId) {
  const cached = preferenceCache.get(orgId)
  if (!cached) return null
  if ((Date.now() - cached.timestamp) > 60000) {
    preferenceCache.delete(orgId)
    return null
  }
  return cached.value
}

export function getCapabilityPreference(namespacePayload, capability) {
  return namespacePayload?.preferences?.capabilities?.[capability] || null
}

/**
 * Merge a single capability's provider/model into an existing preferences
 * payload without touching any other capability's saved preference. Used
 * when a manual toolbar model pick (e.g. HomeView's ModelSelector) should
 * be saved as the personal default for just that one capability.
 */
export function mergeCapabilityPreference(existingPreferences, capability, provider, model) {
  return {
    capabilities: {
      ...(existingPreferences?.capabilities || {}),
      [capability]: { provider, model },
    },
  }
}

export async function fetchLlmCapabilityPreferences(authFetch, orgId, { force = false } = {}) {
  if (!orgId || !authFetch) return getEmptyPreferencePayload()

  if (!force) {
    const cached = getCached(orgId)
    if (cached) return cached
  }

  try {
    const response = await authFetch(`/api/orgs/${orgId}/my-preferences`)
    if (!response.ok) return getEmptyPreferencePayload()
    const data = await response.json()
    const payload = {
      source: 'member',
      preferences: normalizePreferences(data.preferences?.[PREFERENCE_NAMESPACE]),
    }
    preferenceCache.set(orgId, { value: payload, timestamp: Date.now() })
    return payload
  } catch (error) {
    console.warn('[LlmCapabilityPreferences] Failed to fetch member preferences:', error.message)
    return getEmptyPreferencePayload()
  }
}

export async function saveLlmCapabilityPreferences(authFetch, orgId, preferences) {
  const response = await authFetch(`/api/orgs/${orgId}/my-preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preferences: {
        [PREFERENCE_NAMESPACE]: normalizePreferences(preferences),
      },
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Failed to save personal capability preferences')
  }

  const payload = {
    source: 'member',
    preferences: normalizePreferences(preferences),
  }
  preferenceCache.set(orgId, { value: payload, timestamp: Date.now() })
  return payload
}

export function clearLlmCapabilityPreferencesCache(orgId = null) {
  if (orgId) {
    preferenceCache.delete(orgId)
    return
  }
  preferenceCache.clear()
}
