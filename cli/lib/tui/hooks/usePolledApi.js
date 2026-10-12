/**
 * usePolledApi — React hook for API calls with optional background polling
 *
 * Generalization of useApi that adds:
 *   - `active` gating: only fetches / polls while active is true
 *   - `intervalMs` polling: re-fetches on a timer while active (cleared on
 *     inactive/unmount — never polls in the background)
 *   - `isStale` flag: true when the last successful fetch is older than
 *     2x the poll interval (only meaningful when intervalMs > 0)
 *   - simple error backoff: a failed fetch skips the next scheduled tick
 *     instead of hammering a broken endpoint every intervalMs
 *
 * Usage:
 *   const { data, loading, error, refresh, lastFetched, isStale } = usePolledApi(
 *     () => client.get('/api/v1/fleet/status', { service: 'collector' }),
 *     [client],
 *     { intervalMs: 10000, active: isActive }
 *   );
 *
 * @param {Function} fetchFn   - async function that returns data
 * @param {Array}    deps      - dependency array (re-fetch when changed)
 * @param {Object}   [options]
 * @param {number}   [options.intervalMs=0] - poll interval in ms (0 = no polling)
 * @param {boolean}  [options.active=true]  - whether fetching/polling is enabled
 * @returns {{ data: any, loading: boolean, error: Error|null, refresh: Function, lastFetched: number|null, isStale: boolean }}
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export function usePolledApi(fetchFn, deps = [], options = {}) {
  const { intervalMs = 0, active = true } = options;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);

  // Simple backoff: when a fetch fails, skip the next scheduled poll tick
  // instead of hammering a broken endpoint every intervalMs.
  const skipNextTickRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setData(result);
      setLastFetched(Date.now());
      skipNextTickRef.current = false;
    } catch (err) {
      setError(err);
      skipNextTickRef.current = true;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // ── Fetch on activation and whenever deps change while active ────────
  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active, refresh]);

  // ── Poll on an interval, only while active ────────────────────────────
  useEffect(() => {
    if (!active || !intervalMs) return;

    const id = setInterval(() => {
      if (skipNextTickRef.current) {
        // Back off one tick after a failure, then resume normal cadence.
        skipNextTickRef.current = false;
        return;
      }
      refresh();
    }, intervalMs);

    return () => clearInterval(id);
  }, [active, intervalMs, refresh]);

  const isStale = Boolean(
    intervalMs > 0 && lastFetched != null && Date.now() - lastFetched > intervalMs * 2
  );

  return { data, loading, error, refresh, lastFetched, isStale };
}
