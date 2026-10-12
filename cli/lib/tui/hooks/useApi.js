/**
 * useApi — React hook for API calls with loading/error/data state
 *
 * Wraps an async fetch function and manages its lifecycle state.
 * Automatically calls the fetch function on mount and when deps change.
 * Provides a `refresh` function for manual re-fetching.
 *
 * Usage:
 *   const { data, loading, error, refresh } = useApi(
 *     () => client.fleet.list(),
 *     [client]
 *   );
 *
 * @param {Function} fetchFn  - async function that returns data
 * @param {Array}    deps     - dependency array (re-fetch when changed)
 * @returns {{ data: any, loading: boolean, error: Error|null, refresh: Function }}
 */

import { useState, useEffect, useCallback } from 'react';

export function useApi(fetchFn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
