import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Run an async loader whenever `deps` change. Stale responses are dropped.
 * `error` keeps the ApiError so callers can branch on status.
 */
export function useAsync(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const run = useCallback(() => {
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.resolve().then(loader).then(
      (data) => { if (mine === seq.current) setState({ data, error: null, loading: false }) },
      (error) => { if (mine === seq.current) setState({ data: null, error, loading: false }) },
    )
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run() }, [run])
  return { ...state, reload: run }
}
