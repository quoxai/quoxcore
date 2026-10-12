'use strict';

/**
 * AGH-CHAIN-4: Per-agent honesty rollup.
 *
 * Computes claims_made / claims_verified / claims_stripped /
 * unfulfilled_promises / honesty_rate from VOLT events.
 *
 * Multi-tenant invariant: ALL results are filtered by org_id in JS
 * after reading run.started events. Cross-org leakage is a critical bug.
 *
 * Cache: Map<string, {value, expires_at}>  TTL = ttlMs (default 5 min).
 */

const WINDOW_MS = {
  '24h': 24 * 3600e3,
  '7d':  7  * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
};

const VALID_WINDOWS = Object.keys(WINDOW_MS);

const GUARD_EVENT_TYPES = [
  'response_contract_applied',
  'chain_verification_applied',
];

/**
 * eventHasAppliedGuard(ev)
 *
 * Two event payload shapes are in play:
 *   - response_contract_applied (AGH-RESP): { guards: [{ name, applied }] }
 *   - chain_verification_applied (AGH-CHAIN-1/2/3, real shape emitted by
 *     stackModeDispatch.js): { chain_verification: { guardKey: { applied, ... }, ... } }
 *
 * Historical/legacy chain_verification_applied events may carry the older
 * { guards: [...] } array shape (e.g. from before the traceMap shape landed,
 * or synthetic fixtures) — checked as a fallback so those still count.
 */
function eventHasAppliedGuard(ev) {
  let data;
  try {
    data = JSON.parse(ev.data || '{}');
  } catch {
    return false;
  }

  if (data.chain_verification && typeof data.chain_verification === 'object') {
    return Object.values(data.chain_verification).some(
      g => g && typeof g === 'object' && g.applied === true
    );
  }

  if (Array.isArray(data.guards)) {
    return data.guards.some(g => g && g.applied === true);
  }

  return false;
}

/**
 * createHonestyRollup({ voltDb, promiseStore, ttlMs? })
 */
function createHonestyRollup({ voltDb, promiseStore, ttlMs = 5 * 60 * 1000 }) {
  /** @type {Map<string, {value: any, expires_at: number}>} */
  const cache = new Map();

  function cacheKey(...parts) {
    return parts.join('::');
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires_at) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function cacheSet(key, value) {
    cache.set(key, { value, expires_at: Date.now() + ttlMs });
  }

  function invalidate() {
    cache.clear();
  }

  /**
   * Load all relevant events for the window from volt_events + volt_runs.
   * Returns { runMeta: Map<run_id, {agent_id, org_id}>, eventsByRun: Map<run_id, event[]> }
   */
  function loadWindowData(sinceTs) {
    const sinceIso = new Date(sinceTs).toISOString();

    const rows = voltDb.prepare(`
      SELECT
        ve.event_id,
        ve.run_id,
        ve.event_type,
        ve.ts,
        ve.data,
        vr.corr
      FROM volt_events ve
      JOIN volt_runs vr ON vr.run_id = ve.run_id
      WHERE ve.ts >= ?
        AND ve.event_type IN ('run.started', 'response_contract_applied', 'chain_verification_applied')
      ORDER BY ve.run_id, ve.ts
    `).all(sinceIso);

    // Build run meta from run.started events
    const runMeta = new Map();
    const eventsByRun = new Map();

    for (const row of rows) {
      if (!eventsByRun.has(row.run_id)) {
        eventsByRun.set(row.run_id, []);
      }
      eventsByRun.get(row.run_id).push(row);

      if (row.event_type === 'run.started') {
        try {
          const data = JSON.parse(row.data || '{}');
          runMeta.set(row.run_id, {
            agent_id: data.agent_id || data.selected_agent || null,
            org_id: data.org_id || null,
          });
        } catch {
          runMeta.set(row.run_id, { agent_id: null, org_id: null });
        }
      }
    }

    return { runMeta, eventsByRun };
  }

  /**
   * Aggregate counters per agent for a given org+window.
   * Returns Map<agent_id, { claims_made, claims_stripped, claims_verified, honesty_rate, runIds }>
   */
  function aggregateByAgent(orgId, sinceTs) {
    const { runMeta, eventsByRun } = loadWindowData(sinceTs);

    const agents = new Map();

    for (const [runId, meta] of runMeta.entries()) {
      // Multi-tenant filter: skip runs not belonging to this org
      if (meta.org_id !== orgId) continue;

      const agentId = meta.agent_id || 'unknown';
      if (!agents.has(agentId)) {
        agents.set(agentId, {
          claims_made: 0,
          claims_stripped: 0,
          claims_verified: 0,
          honesty_rate: 1,
          runIds: [],
          events: [],
        });
      }

      const agg = agents.get(agentId);
      const events = eventsByRun.get(runId) || [];
      const guardEvents = events.filter(e => GUARD_EVENT_TYPES.includes(e.event_type));

      if (guardEvents.length > 0) {
        agg.claims_made += 1;
        agg.runIds.push(runId);

        let anyStripped = false;
        for (const ev of guardEvents) {
          if (eventHasAppliedGuard(ev)) {
            anyStripped = true;
          }
          agg.events.push(ev);
        }

        if (anyStripped) {
          agg.claims_stripped += 1;
        } else {
          agg.claims_verified += 1;
        }
      }
    }

    // Compute honesty_rate
    for (const agg of agents.values()) {
      agg.honesty_rate = agg.claims_made > 0
        ? agg.claims_verified / agg.claims_made
        : 1;
    }

    return agents;
  }

  /**
   * Compute sparkline buckets for a window.
   * Returns array of [bucket_start_iso, claims_made, claims_stripped]
   */
  function buildSparkline(agentAgg, sinceTs, windowId) {
    const now = Date.now();
    let bucketCount, bucketMs;
    if (windowId === '24h') {
      bucketCount = 24;
      bucketMs = 3600e3;
    } else if (windowId === '7d') {
      bucketCount = 7;
      bucketMs = 24 * 3600e3;
    } else {
      bucketCount = 30;
      bucketMs = 24 * 3600e3;
    }

    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = sinceTs + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      buckets.push([new Date(bucketStart).toISOString(), 0, 0]);

      for (const ev of (agentAgg ? agentAgg.events : [])) {
        const evTs = new Date(ev.ts).getTime();
        if (evTs >= bucketStart && evTs < bucketEnd) {
          try {
            const data = JSON.parse(ev.data || '{}');
            const guards = Array.isArray(data.guards) ? data.guards : [];
            const stripped = guards.some(g => g.applied === true);
            buckets[i][1] += 1; // claims_made
            if (stripped) buckets[i][2] += 1; // claims_stripped
          } catch {
            buckets[i][1] += 1;
          }
        }
      }
    }

    return buckets;
  }

  /**
   * getOrgLeaderboard(orgId, window)
   * Returns { agents: [...], window, computed_at }
   */
  function getOrgLeaderboard(orgId, window) {
    if (!VALID_WINDOWS.includes(window)) {
      throw new Error(`Invalid window: ${window}. Must be one of ${VALID_WINDOWS.join(', ')}`);
    }

    const key = cacheKey('leaderboard', orgId, window);
    const cached = cacheGet(key);
    if (cached) return cached;

    const windowMs = WINDOW_MS[window];
    const sinceTs = Date.now() - windowMs;
    const agentsMap = aggregateByAgent(orgId, sinceTs);

    const agents = [];
    for (const [agentId, agg] of agentsMap.entries()) {
      const unfulfilled = promiseStore
        ? promiseStore.countOpenPromisesByAgentInWindow(orgId, agentId, sinceTs)
        : 0;
      agents.push({
        agent_id: agentId,
        claims_made: agg.claims_made,
        claims_verified: agg.claims_verified,
        claims_stripped: agg.claims_stripped,
        unfulfilled_promises: unfulfilled,
        honesty_rate: agg.honesty_rate,
      });
    }

    // Sort by honesty_rate ascending (worst first for leaderboard visibility)
    agents.sort((a, b) => a.honesty_rate - b.honesty_rate);

    const result = { agents, window, computed_at: new Date().toISOString() };
    cacheSet(key, result);
    return result;
  }

  /**
   * getAgentMetrics(orgId, agentId, window)
   * Returns { agent_id, claims_made, claims_verified, claims_stripped, unfulfilled_promises, honesty_rate, sparkline, computed_at }
   */
  function getAgentMetrics(orgId, agentId, window) {
    if (!VALID_WINDOWS.includes(window)) {
      throw new Error(`Invalid window: ${window}. Must be one of ${VALID_WINDOWS.join(', ')}`);
    }

    const key = cacheKey('metrics', orgId, agentId, window);
    const cached = cacheGet(key);
    if (cached) return cached;

    const windowMs = WINDOW_MS[window];
    const sinceTs = Date.now() - windowMs;
    const agentsMap = aggregateByAgent(orgId, sinceTs);

    const agg = agentsMap.get(agentId) || {
      claims_made: 0,
      claims_stripped: 0,
      claims_verified: 0,
      honesty_rate: 1,
      events: [],
    };

    const unfulfilled = promiseStore
      ? promiseStore.countOpenPromisesByAgentInWindow(orgId, agentId, sinceTs)
      : 0;

    const sparkline = buildSparkline(agg, sinceTs, window);

    const result = {
      agent_id: agentId,
      claims_made: agg.claims_made,
      claims_verified: agg.claims_verified,
      claims_stripped: agg.claims_stripped,
      unfulfilled_promises: unfulfilled,
      honesty_rate: agg.honesty_rate,
      sparkline,
      computed_at: new Date().toISOString(),
    };

    cacheSet(key, result);
    return result;
  }

  /**
   * getDrillThroughEvents(orgId, agentId, window, guardKind)
   * Returns [{event_id, run_id, ts, payload_preview}]
   */
  function getDrillThroughEvents(orgId, agentId, window, guardKind) {
    if (!VALID_WINDOWS.includes(window)) {
      throw new Error(`Invalid window: ${window}. Must be one of ${VALID_WINDOWS.join(', ')}`);
    }

    const windowMs = WINDOW_MS[window];
    const sinceTs = Date.now() - windowMs;
    const agentsMap = aggregateByAgent(orgId, sinceTs);

    const agg = agentsMap.get(agentId);
    if (!agg) return [];

    const events = [];
    for (const ev of agg.events) {
      let include = false;
      if (guardKind === 'claims_stripped') {
        try {
          const data = JSON.parse(ev.data || '{}');
          const guards = Array.isArray(data.guards) ? data.guards : [];
          include = guards.some(g => g.applied === true);
        } catch {
          include = false;
        }
      } else {
        include = true;
      }

      if (include) {
        const dataStr = ev.data || '';
        events.push({
          event_id: ev.event_id,
          run_id: ev.run_id,
          ts: ev.ts,
          payload_preview: dataStr.length > 200 ? dataStr.slice(0, 200) + '…' : dataStr,
        });
      }
    }

    return events;
  }

  /**
   * getRecentCorrections(orgId, window, limit)
   *
   * AGH-CHAIN honesty ledger: reads chain_verification_applied events
   * (distinct from response_contract_applied — this is the AGH-CHAIN-1/2/3
   * guard family: detect_promise / verify_promise_kept / verify_cross_agent_claim /
   * verify_cross_org_claim) directly, so each row can carry the specific
   * guard name rather than the collapsed claims_stripped/claims_verified
   * split used by the leaderboard.
   *
   * Returns [{ event_id, run_id, agent_id, ts, guard, summary }], newest first.
   */
  function getRecentCorrections(orgId, window, limit = 20) {
    if (!VALID_WINDOWS.includes(window)) {
      throw new Error(`Invalid window: ${window}. Must be one of ${VALID_WINDOWS.join(', ')}`);
    }

    const windowMs = WINDOW_MS[window];
    const sinceTs = Date.now() - windowMs;
    const { runMeta, eventsByRun } = loadWindowData(sinceTs);

    const corrections = [];
    for (const [runId, meta] of runMeta.entries()) {
      if (meta.org_id !== orgId) continue;

      const events = eventsByRun.get(runId) || [];
      for (const ev of events) {
        if (ev.event_type !== 'chain_verification_applied') continue;

        let data;
        try {
          data = JSON.parse(ev.data || '{}');
        } catch {
          continue;
        }

        const traceMap = data.chain_verification || {};
        for (const [guardKey, guard] of Object.entries(traceMap)) {
          if (guard && typeof guard === 'object' && guard.applied === true) {
            const summary =
              guard.reason ||
              (guard.promise_id ? `Unfulfilled promise ${guard.promise_id}` : null) ||
              (guard.claim_action ? `Unverified claim: ${guard.claim_action}` : null) ||
              (guard.agent_name ? `Unverified reference to ${guard.agent_name}` : null) ||
              (guard.org_name ? `Unverified reference to ${guard.org_name}` : null) ||
              'Correction applied';

            corrections.push({
              event_id: ev.event_id,
              run_id: runId,
              agent_id: meta.agent_id || 'unknown',
              ts: ev.ts,
              guard: guardKey,
              summary,
            });
          }
        }
      }
    }

    corrections.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    return corrections.slice(0, limit);
  }

  return { getOrgLeaderboard, getAgentMetrics, getDrillThroughEvents, getRecentCorrections, invalidate };
}

module.exports = { createHonestyRollup };
