import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

/**
 * Schedules list with loading/error/retry. Small per-product copy of the
 * useAsync pattern (quoxsignal/lib/useAsync.js): a generation guard drops
 * stale responses. `retry({ silent: true })` refreshes without blanking the
 * table.
 */
export function useSchedules() {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const generation = useRef(0)

  const retry = useCallback((opts = {}) => {
    const silent = Boolean(opts.silent)
    const gen = ++generation.current
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }))
    api.listSchedules()
      .then((data) => {
        if (gen === generation.current) setState({ loading: false, error: null, data })
      })
      .catch((error) => {
        if (gen !== generation.current) return
        // A failed background refresh keeps the rows already on screen.
        setState((s) => (silent ? s : { loading: false, error, data: null }))
      })
  }, [])

  useEffect(() => {
    retry()
    return () => { generation.current++ }
  }, [retry])

  return { schedules: state.data || [], loading: state.loading, error: state.error, retry }
}
