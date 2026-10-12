/**
 * agentActivity.js — VULCAN-DASH S2/S3 read model (stats overview + history).
 *
 * A browser/dashboard user cannot read an agent's shared (org_id, agent_id)
 * memory namespace directly: the memory service honours agent_scope=1 ONLY
 * for role===service callers, and a browser user JWT is role=user. So the
 * durable facts an attach-bound CLI session left behind (written under
 * user_id='service' by the detach ritual — see agentAttachHandoff.js) are
 * invisible to the browser.
 *
 * This module does that read SERVER-SIDE with the internal service key,
 * scoped to the CALLER'S org (the route passes the request's resolved org,
 * never a client-supplied one) and agent_scope=1 so the whole agent
 * namespace comes back. It is the read side of the same continuity the
 * chat implant (memoryImplant.js) provides on the write/inject side.
 *
 * Never throws — returns { ok:false, memories:[], stats, error } on any
 * failure (timeout, non-2xx, network) and logs it loudly.
 */

'use strict';

const MEMORY_URL_DEFAULT = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || '';

const TIMEOUT_MS = 3000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The detach ritual writes a handoff as a memory_type='fact' row under
// user_id='service' (agentAttachHandoff.js). Those service-written rows are
// the "session activity" a dashboard user most wants to see — surface a count
// and the freshest one distinctly from the agent's other durable memories.
function isHandoff(m) {
  return !!(m && m.user_id === 'service');
}

function summarizeAgentActivity(memories = []) {
  const list = Array.isArray(memories) ? memories.filter(Boolean) : [];
  const byType = {};
  let latestActivityAt = null;
  let handoffCount = 0;
  let latestHandoff = null;

  for (const m of list) {
    const type = m.memory_type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
    const ts = m.created_at || m.updated_at || null;
    if (ts && (!latestActivityAt || ts > latestActivityAt)) latestActivityAt = ts;
    if (isHandoff(m)) {
      handoffCount += 1;
      const hTs = m.created_at || m.updated_at || '';
      if (!latestHandoff || hTs > (latestHandoff.created_at || latestHandoff.updated_at || '')) {
        latestHandoff = m;
      }
    }
  }

  return {
    total: list.length,
    byType,
    handoffCount,
    latestActivityAt,
    latestHandoffAt: latestHandoff ? (latestHandoff.created_at || latestHandoff.updated_at || null) : null,
    latestHandoffExcerpt: latestHandoff ? String(latestHandoff.content || '').slice(0, 280) : null,
  };
}

/**
 * Fetch an agent's org+agent-scoped memory rows and a derived stats summary.
 * @param {{ orgId:string, agentId:string, limit?:number|string,
 *   memoryServiceUrl?:string, serviceKey?:string, fetchFn?:Function,
 *   timeoutMs?:number }} args
 */
async function fetchAgentActivity({
  orgId,
  agentId,
  limit = DEFAULT_LIMIT,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  const cappedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const empty = (error) => ({ ok: false, memories: [], stats: summarizeAgentActivity([]), ...(error ? { error } : {}) });

  if (!agentId) return empty('missing_agent_id');

  try {
    const params = new URLSearchParams({ agent_id: agentId, agent_scope: '1', limit: String(cappedLimit) });
    const url = `${memoryServiceUrl}/api/memory?${params}`;
    const resp = await doFetch(url, {
      headers: {
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || 'default',
        'X-User-Id': 'service',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return empty(`memory_service_${resp.status}`);
    const data = await resp.json();
    const memories = Array.isArray(data.memories) ? data.memories : [];
    return { ok: true, memories, stats: summarizeAgentActivity(memories) };
  } catch (err) {
    console.error(`[AgentActivity] fetch failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return empty(err.message);
  }
}

// Owner 2026-10-08: "Last active" read only durable memory rows (written on
// detach), so an agent attached and working all day showed "8 days". The
// agent's own witnessed envelopes are the real activity signal. The scan is
// capped (newest N rows for this sender via idx_envelopes_from_ts, then the
// org filter) because a busy agent in another org made the unbounded query
// take ~2s on the collector event loop. Never throws: null on any failure.
const ENVELOPE_SCAN_CAP = 1000;

function latestAgentEnvelopeAt(db, { orgId, agentId, scanCap = ENVELOPE_SCAN_CAP } = {}) {
  if (!db || !agentId || !orgId) return null;
  try {
    const row = db.prepare(
      'SELECT ts FROM (SELECT ts, org_id FROM envelopes INDEXED BY idx_envelopes_from_ts '
      + 'WHERE "from" = ? ORDER BY ts DESC LIMIT ?) WHERE org_id = ? LIMIT 1'
    ).get(`agent.${agentId}`, scanCap, orgId);
    return row ? row.ts : null;
  } catch (err) {
    console.error(`[AgentActivity] envelope last-seen failed (agent=${agentId}): ${err.message}`);
    return null;
  }
}

function withLastSeen(stats, envelopeAt) {
  const mem = stats ? stats.latestActivityAt || null : null;
  const lastSeenAt = [mem, envelopeAt || null].filter(Boolean).sort().pop() || null;
  return { ...stats, lastEnvelopeAt: envelopeAt || null, lastSeenAt };
}

module.exports = {
  latestAgentEnvelopeAt,
  withLastSeen,
  ENVELOPE_SCAN_CAP,
  fetchAgentActivity,
  summarizeAgentActivity,
  isHandoff,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
