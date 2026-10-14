import { useCallback, useEffect, useRef, useState } from 'react'
import { approvalsApi } from './approvalsApi.js'

/**
 * Generation-guarded loader shared by the policy and escalation hooks: stale
 * responses are dropped, and `retry({ silent: true })` refreshes without
 * blanking what is on screen.
 */
function useLoader(fetcher) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const generation = useRef(0)

  const retry = useCallback((opts = {}) => {
    const silent = Boolean(opts.silent)
    const gen = ++generation.current
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }))
    fetcher()
      .then((data) => {
        if (gen === generation.current) setState({ loading: false, error: null, data })
      })
      .catch((error) => {
        if (gen !== generation.current) return
        setState((s) => (silent ? s : { loading: false, error, data: null }))
      })
  }, [fetcher])

  useEffect(() => {
    retry()
    return () => { generation.current++ }
  }, [retry])

  return { ...state, retry }
}

const loadPolicy = () => approvalsApi.getPolicy()
const loadEscalations = () => approvalsApi.listEscalations()

export function useApprovalsPolicy() {
  const { data, loading, error, retry } = useLoader(loadPolicy)
  return { policy: data, loading, error, retry }
}

export function useEscalations() {
  const { data, loading, error, retry } = useLoader(loadEscalations)
  return { escalations: data || [], loading, error, retry }
}
