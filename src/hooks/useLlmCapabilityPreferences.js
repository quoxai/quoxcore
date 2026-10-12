import { useCallback, useEffect, useState } from 'react'
import { fetchLlmCapabilityPreferences } from '../services/llmCapabilityPreferencesClient'

export function useLlmCapabilityPreferences(authFetch, orgId) {
  const [state, setState] = useState({
    loading: !!orgId,
    error: null,
    source: 'member',
    preferences: { capabilities: {} },
  })

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (!orgId || !authFetch) {
      const empty = { loading: false, error: null, source: 'member', preferences: { capabilities: {} } }
      setState(empty)
      return empty
    }

    setState(prev => ({ ...prev, loading: true, error: null }))
    const payload = await fetchLlmCapabilityPreferences(authFetch, orgId, { force })
    const next = { loading: false, error: null, ...payload }
    setState(next)
    return next
  }, [authFetch, orgId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    ...state,
    refresh,
  }
}

export default useLlmCapabilityPreferences
