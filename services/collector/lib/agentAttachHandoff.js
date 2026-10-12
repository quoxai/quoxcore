/**
 * QuoxIdentity P2 (territory D, collector) — the handoff mechanism.
 *
 * POST /api/v1/agent-attach/handoff lets an attach-bound CLI session leave a
 * durable note (content, open threads, next moves) for whoever attaches to
 * the same agent next. See docs/QUOXIDENTITY_P2_CONTRACT.md for the binding
 * contract; this module implements the "Territory D" handoff section.
 *
 * Route logic lives here (not inline in server.js), mirroring
 * lib/agentAttachKit.js's dependency-injected handler factory pattern —
 * server.js passes in the real storeAuditEnvelope as `audit`; tests inject a
 * stub.
 *
 * DEVIATION from the contract's literal wording (flagged, not silent): the
 * contract says to store the handoff with memory_role='session_history'.
 * services/memory/lib/memoryStore.js's QSKL-13 write guard
 * (ALLOWED_WRITE_ROLES = ['fact']) rejects memory_role='session_history' for
 * EVERY caller with a WRONG_LAYER error — the SAME guard is mirrored locally
 * in lib/memoryToolHandlers.js's memorySave(). That guard lives in
 * services/memory, outside this territory, and cannot be relaxed here
 * without touching an out-of-territory service. This module writes
 * memory_role:'fact' instead (the only value the memory service currently
 * accepts for any write) and carries the handoff's identity entirely via
 * tags:['quoxidentity','handoff'] — which is exactly what
 * fetchLatestHandoffMemory() below filters on to find it again. If the
 * memory-service guard is ever relaxed for session_history, this can switch
 * back to the literal role with a one-line change.
 */

'use strict';

const { deriveActorType } = require('../utils/httpAuth.js');

const MEMORY_URL_DEFAULT = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const MEMORY_FETCH_TIMEOUT_MS = 2000;
const MAX_HANDOFF_CONTENT_BYTES = 8 * 1024; // 8KB cap, per contract
const HANDOFF_TAGS = ['quoxidentity', 'handoff'];
// Over-fetch multiplier for fetchLatestHandoffMemory's GET /api/memory list
// call — memory_role/tags aren't filterable server-side on that endpoint,
// same over-fetch-then-filter convention as lib/memoryImplant.js's
// fetchCriticalMemoriesFallback.
const HANDOFF_LOOKUP_LIMIT = 20;

function serviceHeaders({ orgId, serviceKey }) {
  return {
    'X-Service-Key': serviceKey,
    'X-Org-Id': orgId || 'default',
    'X-User-Id': 'service',
  };
}

/**
 * Validate handoff content: must be a non-empty string within the 8KB cap.
 * Returns { ok: true } or { ok: false, error, message, ...extra }.
 */
function validateHandoffContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, error: 'content_required', message: 'content is required and must be a non-empty string' };
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_HANDOFF_CONTENT_BYTES) {
    return {
      ok: false,
      error: 'content_too_long',
      message: `content exceeds the ${MAX_HANDOFF_CONTENT_BYTES}-byte cap (got ${byteLength} bytes)`,
      max_bytes: MAX_HANDOFF_CONTENT_BYTES,
    };
  }
  return { ok: true };
}

/**
 * Store a handoff note as a memory in the agent's namespace. Never throws —
 * returns { ok: false, error } on any failure (non-2xx, network error,
 * timeout).
 */
async function storeHandoffMemory({
  orgId,
  agentId,
  leaseId,
  content,
  open_threads,
  next_moves,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn,
  timeoutMs = MEMORY_FETCH_TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  const metadata = { lease_id: leaseId || null };
  if (Array.isArray(open_threads) && open_threads.length > 0) metadata.open_threads = open_threads;
  if (Array.isArray(next_moves) && next_moves.length > 0) metadata.next_moves = next_moves;

  try {
    const resp = await doFetch(`${memoryServiceUrl}/api/memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...serviceHeaders({ orgId, serviceKey }),
      },
      body: JSON.stringify({
        memory_type: 'fact',
        memory_role: 'fact', // see module DEVIATION note above
        content,
        agent_id: agentId,
        tags: HANDOFF_TAGS,
        importance: 'medium',
        metadata,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      let body = null;
      try { body = await resp.json(); } catch { /* non-JSON error body */ }
      return { ok: false, status: resp.status, error: body?.error || `memory_service_http_${resp.status}` };
    }

    const memory = await resp.json();
    return { ok: true, memory };
  } catch (err) {
    console.error(`[AgentAttachHandoff] store failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { ok: false, error: err.message || 'memory_fetch_failed' };
  }
}

/**
 * Fetch the single most recent handoff memory for an agent namespace
 * (tags contain 'handoff'). Never throws — returns { handoff: null, error }
 * on any failure.
 */
async function fetchLatestHandoffMemory({
  orgId,
  agentId,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn,
  timeoutMs = MEMORY_FETCH_TIMEOUT_MS,
  lookupLimit = HANDOFF_LOOKUP_LIMIT,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    // QUOXIDENTITY F8: agent_scope=1 reads the whole agent namespace so the
    // freshest handoff hydrates regardless of which user_id wrote it (today the
    // detach ritual writes under 'service'; agent_scope makes the read robust
    // if that ever changes).
    const params = new URLSearchParams({ agent_id: agentId || '', limit: String(lookupLimit), agent_scope: '1' });
    const url = `${memoryServiceUrl}/api/memory?${params}`;
    const resp = await doFetch(url, {
      headers: serviceHeaders({ orgId, serviceKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { handoff: null, error: `memory_service_http_${resp.status}` };
    const data = await resp.json();
    const rows = Array.isArray(data.memories) ? data.memories : [];
    // GET /api/memory (listMemories) orders by created_at DESC, so the first
    // row carrying the 'handoff' tag is the freshest.
    const latest = rows.find((m) => Array.isArray(m?.tags) && m.tags.includes('handoff')) || null;
    return { handoff: latest, error: null };
  } catch (err) {
    console.error(`[AgentAttachHandoff] handoff lookup failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { handoff: null, error: err.message || 'memory_fetch_failed' };
  }
}

/**
 * Express handler factory for POST /api/v1/agent-attach/handoff.
 * @param {object} deps
 * @param {(envelope: object) => void} [deps.audit] - storeAuditEnvelope (server.js)
 * @param {Function} [deps.fetchFn] - override for the memory-service fetch (tests)
 * @param {string} [deps.memoryServiceUrl] - override for the memory service base URL (tests)
 * @param {string} [deps.serviceKey] - override for INTERNAL_SERVICE_KEY (tests)
 */
function createAgentAttachHandoffHandler(deps = {}) {
  const audit = deps.audit || (() => {});
  const fetchFn = deps.fetchFn;
  const memoryServiceUrl = deps.memoryServiceUrl || MEMORY_URL_DEFAULT;
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');

  return async function agentAttachHandoffHandler(req, res) {
    // Same gate shape as GET /api/v1/agent-attach/kit (P1 contract): attach
    // lease callers only.
    const actorType = deriveActorType(req);
    const leaseId = req.user?.attach_lease_id || null;
    if (actorType !== 'agent' || !leaseId) {
      return res.status(403).json({
        error: 'attach_required',
        message: 'This endpoint requires an active attach lease (an agent-scoped token carrying an attach_lease_id claim).',
      });
    }

    const agentId = String(req.user.agent_id || '').toLowerCase();
    if (!agentId) {
      return res.status(400).json({ error: 'missing_agent_id', message: 'attach token has no agent_id claim' });
    }

    const { content, open_threads, next_moves } = req.body || {};
    const validation = validateHandoffContent(content);
    if (!validation.ok) {
      return res.status(400).json(validation);
    }

    const orgId = req.user.org_id || null;

    const stored = await storeHandoffMemory({
      orgId,
      agentId,
      leaseId,
      content,
      open_threads,
      next_moves,
      memoryServiceUrl,
      serviceKey,
      fetchFn,
    });

    if (!stored.ok) {
      // A 4xx from the memory service is a VERDICT (quota exceeded, bad
      // payload), not an outage: pass the real status and reason through
      // instead of masking it as a generic 502. On 2026-09-21 a quota-hit
      // detach surfaced as "502 Failed to store handoff" while the memory
      // service was healthy, and the session couldn't tell why (quox#571).
      const status = (stored.status >= 400 && stored.status < 500) ? stored.status : 502;
      return res.status(status).json({
        error: status === 502 ? 'handoff_store_failed' : 'handoff_store_refused',
        message: status === 502
          ? 'Failed to store handoff in the memory service.'
          : `Memory service refused the handoff (HTTP ${stored.status}).`,
        detail: stored.error || null,
      });
    }

    // Witness the handoff store (contract: AEE envelope, intent
    // quox.identity.handoff, from=agent.<agent_id>). Audit failure must
    // never fail the response — the handoff is already durably stored.
    try {
      audit({
        type: 'event',
        from: `agent.${agentId}`,
        to: 'audit.system',
        intent: 'quox.identity.handoff',
        corr: leaseId,
        org_id: orgId,
        payload: {
          lease_id: leaseId,
          org_id: orgId,
          memory_id: stored.memory?.id || null,
        },
      });
    } catch (err) {
      console.warn('[AgentAttachHandoff] audit envelope emit failed (non-fatal):', err.message);
    }

    return res.status(201).json({
      ok: true,
      memory_id: stored.memory?.id || null,
      created_at: stored.memory?.created_at || null,
    });
  };
}

module.exports = {
  createAgentAttachHandoffHandler,
  storeHandoffMemory,
  fetchLatestHandoffMemory,
  validateHandoffContent,
  MAX_HANDOFF_CONTENT_BYTES,
  HANDOFF_TAGS,
};
