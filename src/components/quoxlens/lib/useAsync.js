import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async fetcher whenever `deps` change, tracking loading/error/data.
 * `fetcher` must be stable-ish (wrap in useCallback at the call site) since
 * it's re-invoked on every dependency change plus on manual `retry()`.
 *
 * Same implementation as quoxsignal/lib/useAsync.js and quoxplan/lib/useAsync.js
 * (the precedent this mirrors) — kept as a per-product copy rather than a
 * shared import, same convention those two already established.
 */
export function useAsync(fetcher, deps) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const generation = useRef(0);

  const run = useCallback(() => {
    const gen = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher()
      .then((data) => {
        if (gen !== generation.current) return;
        setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (gen !== generation.current) return;
        setState({ loading: false, error, data: null });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { ...state, retry: run };
}
