'use strict';

/**
 * QUOXON first-text (2026-10-19): fleet host names, synchronously, for the handoff gap predictor
 * (lib/handoffSuggest.js) before a chat turn dispatches. Only used to MATCH names in the user's ask; never shown.
 * get() never blocks: it returns the last-known names and starts a background refresh when stale (TTL). Failures
 * are counted distinctly from an empty fleet, keep the last-known names, and wait a full TTL before the next try.
 */
function createFleetHostNames({ load, liveIds = () => [], ttlMs = 5 * 60 * 1000, now = Date.now, log = console } = {}) {
  let names = [];
  let fetchedAt = -Infinity;
  let inFlight = false;
  let failures = 0;
  let loads = 0;
  const live = () => { try { return (liveIds() || []).filter((x) => typeof x === 'string'); } catch { return []; } };
  const merge = (ids) => [...new Set(ids.map((x) => String(x).toLowerCase()).filter(Boolean))];
  function refresh() {
    if (inFlight || typeof load !== 'function') return;
    inFlight = true;
    fetchedAt = now();
    Promise.resolve().then(load).then((r) => {
      loads++;
      if (!r || r.success !== true || !Array.isArray(r.hosts)) throw new Error((r && r.error) || 'no hosts in response');
      names = merge([...r.hosts.map((h) => h && (h.id || h.host_id || h.name)).filter(Boolean), ...live()]);
    }).catch((e) => {
      failures++;
      try { log.warn(`[FleetHostNames] refresh failed (${failures} total), keeping ${names.length} last-known: ${e && e.message}`); } catch { /* log only */ }
    }).finally(() => { inFlight = false; });
  }
  function get() {
    if (now() - fetchedAt >= ttlMs) refresh();
    return names.length ? names : merge(live());
  }
  return { get, stats: () => ({ names: names.length, failures, loads }) };
}

module.exports = { createFleetHostNames };
