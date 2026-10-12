import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async fetcher whenever `deps` change, tracking loading/error/data.
 * `fetcher` must be stable-ish (wrap in useCallback at the call site) since
 * it's re-invoked on every dependency change plus on manual `retry()`.
 *
 * Same implementation as quoxplan/lib/useAsync.js (the precedent this
 * mirrors) — kept as a per-product copy rather than a shared import, same as
 * quoxplan's own file.
 *
 * SIGNAL-PERF: `retry()` now takes an optional `{ force, silent }`. `force`
 * is forwarded straight to `fetcher`, which forwards it to the api.js call
 * so it bypasses the module-level response cache — this is what the
 * explicit Refresh control uses. `silent` keeps whatever is already on
 * screen up instead of swapping to the loading skeleton, so a background
 * refresh (or a failed one) never blanks a view that already has good data;
 * plain retry() calls (error-retry, post-mutation refetch) are unaffected
 * and behave exactly as before. `updatedAt` is set on every successful
 * resolve, silent or not, so callers can show "updated Xm ago" honestly.
 */
export function useAsync(fetcher, deps) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
    updatedAt: null,
    refreshing: false,
  });
  const generation = useRef(0);

  const run = useCallback((runOpts = {}) => {
    const { silent = false } = runOpts;
    const gen = ++generation.current;
    setState((s) => ({
      ...s,
      loading: silent ? s.loading : true,
      error: silent ? s.error : null,
      refreshing: silent,
    }));
    fetcher(runOpts)
      .then((data) => {
        if (gen !== generation.current) return;
        setState({ loading: false, error: null, data, updatedAt: Date.now(), refreshing: false });
      })
      .catch((error) => {
        if (gen !== generation.current) return;
        setState((s) => (silent
          // A silent (background) refresh failing must not blank a view that already has
          // good data on screen — surfacing that error would be worse than the stale data.
          ? { ...s, refreshing: false }
          : { loading: false, error, data: null, updatedAt: null, refreshing: false }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { ...state, retry: run };
}
