/**
 * useHealth — polls the aggregate service-health endpoint for the
 * StatusBar's health dot.
 *
 * Wraps usePolledApi with a 30s cadence and derives a simple traffic-light
 * color from whatever shape the health payload happens to be in. Never
 * throws — any fetch failure or unrecognized shape degrades to 'grey'.
 *
 * Usage:
 *   const { color, loading, lastFetched, isStale } = useHealth(client, {
 *     intervalMs: 30000,
 *   });
 *
 * @param {Object} client - API client with a `.get(path, opts)` method
 * @param {Object} [options]
 * @param {number} [options.intervalMs=30000] - poll interval in ms
 * @param {number} [options.staleAfterMs=90000] - age at which the reading is considered stale
 * @returns {{ color: 'green'|'amber'|'red'|'grey', loading: boolean, lastFetched: number|null, isStale: boolean }}
 */

import { usePolledApi } from './usePolledApi.js';
import { resolveEndpoint } from '../../api/endpoints.js';

const HEALTHY_STATUSES = new Set(['healthy', 'ok', 'up', 'online', 'pass', 'passing']);
const DEGRADED_STATUSES = new Set(['degraded', 'partial', 'warning', 'warn']);
const DOWN_STATUSES = new Set(['down', 'unhealthy', 'critical', 'fail', 'failing', 'offline']);

/** Normalize a single status-ish field into 'green' | 'amber' | 'red' | null (unknown). */
function statusToColor(status, healthy) {
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (HEALTHY_STATUSES.has(s)) return 'green';
    if (DEGRADED_STATUSES.has(s)) return 'amber';
    if (DOWN_STATUSES.has(s)) return 'red';
  }
  if (typeof healthy === 'boolean') return healthy ? 'green' : 'red';
  return null;
}

/** Defensively derive a dot color from an unknown health-aggregate response shape. */
export function deriveHealthColor(data) {
  if (!data || typeof data !== 'object') return 'grey';

  // Direct top-level status/healthy fields.
  const direct = statusToColor(data.status, data.healthy);
  if (direct) return direct;

  // Array of per-service entries — aggregate worst-case wins.
  const services = Array.isArray(data.services)
    ? data.services
    : Array.isArray(data.data)
      ? data.data
      : null;

  if (services && services.length > 0) {
    let sawDegraded = false;
    for (const svc of services) {
      const c = statusToColor(svc?.status, svc?.healthy);
      if (c === 'red') return 'red';
      if (c === 'amber') sawDegraded = true;
      // unknown entries (c === null) don't downgrade the aggregate
    }
    return sawDegraded ? 'amber' : 'green';
  }

  return 'grey';
}

export function useHealth(client, options = {}) {
  const { intervalMs = 30000, staleAfterMs = 90000 } = options;
  const active = Boolean(client && typeof client.get === 'function');

  const { data, loading, error, lastFetched } = usePolledApi(
    () => client.get(resolveEndpoint('v1.health.aggregate.list').path, { service: resolveEndpoint('v1.health.aggregate.list').service }),
    [client],
    { intervalMs, active }
  );

  const color = !active
    ? 'grey'
    : loading && lastFetched == null
      ? 'grey'
      : error
        ? 'grey'
        : deriveHealthColor(data);

  const isStale = Boolean(lastFetched != null && Date.now() - lastFetched > staleAfterMs);

  return { color, loading, lastFetched, isStale };
}
