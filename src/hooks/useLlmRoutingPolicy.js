import { useCallback, useEffect, useState } from 'react'
import { fetchLlmRoutingPolicy, getSeedPolicyPayload } from '../services/llmRoutingPolicyClient'

export function useLlmRoutingPolicy(authFetch, orgId) {
  const [state, setState] = useState(() => ({
    loading: !!orgId,
    error: null,
    ...getSeedPolicyPayload(),
  }))

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (!orgId || !authFetch) {
      const seed = getSeedPolicyPayload()
      setState({ loading: false, error: null, ...seed })
      return seed
    }

    setState(prev => ({ ...prev, loading: true, error: null }))
    const result = await fetchLlmRoutingPolicy(authFetch, orgId, { force })
    setState({ loading: false, error: null, ...result })
    return result
  }, [authFetch, orgId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    ...state,
    refresh,
  }
}

export default useLlmRoutingPolicy

