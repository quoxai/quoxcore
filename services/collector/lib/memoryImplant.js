/**
 * Memory Implant Injection — TRUST-GATE-1.12b
 *
 * Before: `memory_context` was populated only from whatever the frontend
 * sent (can be stale — e.g. localStorage counts surviving across sessions)
 * or, when the frontend sent nothing, the CLI-3d pre-flight fallback
 * (chatMemoryPreflight.js).
 *
 * After: at chat dispatch the collector fetches (a) the org/user's core
 * memories (GET /api/memory/core) and (b) the top relevant search hits for
 * the current message (GET /api/memory/search), using the TRUST-GATE-1.12a
 * internal-service auth (X-Service-Key + X-Org-Id/X-User-Id headers). The
 * result is formatted into a single, clearly-delimited "[MEMORY CONTEXT]"
 * block, hard-capped to ~600 tokens (~5 core + ~5 hits, clean truncation),
 * which SUPERSEDES any frontend-supplied memory_context — this is the one
 * existing prompt slot every downstream consumer already reads
 * (stackModeDispatch.js, l6ShapeRewriter.js, chatMemoryPreflight.js, the
 * direct/local-provider dispatch branches in server.js).
 *
 * Degrades gracefully: memory service down or slow (~2s timeout) means the
 * chat turn proceeds without any memory context. Every failure is logged
 * loudly (console.error) exactly once per failed fetch — never silently
 * swallowed, and never allowed to fail the chat turn.
 */

const MEMORY_URL_DEFAULT = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || '';
const AUTH_URL_DEFAULT = process.env.AUTH_SERVICE_URL || 'http://auth:3101';

const TIMEOUT_MS = 2000;
const MAX_CORE = 5;
const MAX_HITS = 5;
const MAX_TOKENS = 900; // QUOXMIND #1111: room for the org core set + cited recall
const MAX_ITEM_CHARS = 320; // one memory never eats the whole budget
const CHARS_PER_TOKEN = 4; // rough approximation, same convention used elsewhere for token budgets
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

function scopingHeaders({ serviceKey, orgId, userId }) {
  return {
    'X-Service-Key': serviceKey,
    'X-Org-Id': orgId || 'default',
    'X-User-Id': userId || 'service',
  };
}

// VULCAN-DASH S1 (2026-09-29): agent-scoped memory read.
//
// QUOXIDENTITY F8's `agent_scope=1` drops the user_id filter so a read
// returns the whole (org_id, agent_id) namespace. That is the ONLY way a
// browser/dashboard chat can see the rows an attach-bound CLI session wrote
// under user_id='service' (see agentAttachHandoff.js — it writes handoffs as
// user_id='service', agent_id=<agent>, and reads them back with
// agent_scope=1 for exactly this reason). Without it, dashboard chat with an
// attached agent like Vulcan can never recall what the CLI session left.
//
// Safety: the memory service honours agent_scope=1 ONLY for role===service
// callers (server.js /api/memory[/core|/search] gate: `agent_scope === '1'
// && req.user?.role === 'service'`). Org isolation is ALWAYS preserved, so
// there is no cross-ORG or cross-AGENT bleed. It IS a within-org, cross-USER
// broadening of that ONE agent's namespace, so it is deliberately scoped to
// NAMED agents only: the default personal assistant / orchestrator
// identities stay per-user (behaviour unchanged), while every specialist /
// attached agent (vulcan, forge, ...) reads its shared org+agent namespace —
// exactly the F8 model and the "same context in the dashboard as the
// attached CLI session" goal.
const PERSONAL_SCOPE_AGENTS = new Set(['quox', 'commanderq', 'jarvis']);

function isAgentScopedIdentity(agentId) {
  if (!agentId) return false;
  return !PERSONAL_SCOPE_AGENTS.has(String(agentId).toLowerCase());
}

/**
 * MEM-INJECT core-fallback: `core_memories` is a dead tier today — nothing
 * promotes memories into it (PUT /api/memory/core exists but nothing in the
 * product writes it), so real orgs get zero rows and the "Core memories:"
 * slot never fills. Zero-migration stopgap: when the core-memory fetch
 * comes back empty, fall back to the top-N `importance === 'critical'`
 * memories from the regular memory table (GET /api/memory, which returns
 * the `importance` column but doesn't filter on it server-side yet — this
 * over-fetches and filters client-side). HOLD: the real promotion-on-write
 * path (services/memory) is a follow-up, out of scope here.
 * Never throws — returns [] on any failure and logs it loudly.
 */
async function fetchCriticalMemoriesFallback({
  orgId,
  userId,
  agentId,
  agentScope = false,
  memoryServiceUrl,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
  limit = MAX_CORE,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    // Over-fetch since importance isn't filterable server-side yet.
    const params = new URLSearchParams({ limit: String(limit * 4) });
    if (agentId) params.set('agent_id', agentId);
    if (agentScope && agentId) params.set('agent_scope', '1');
    const url = `${memoryServiceUrl}/api/memory?${params}`;
    const resp = await doFetch(url, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.memories || [])
      .filter(m => m && m.importance === 'critical')
      .slice(0, limit);
  } catch (err) {
    console.error(`[MemoryImplant] critical-memory fallback fetch failed (org=${orgId || 'default'}): ${err.message}`);
    return [];
  }
}

/**
 * Fetch org/user core memories for the agent handling this turn.
 * Never throws — returns [] on any failure (timeout, non-2xx, network error)
 * and logs the failure loudly.
 */
async function fetchCoreMemories({
  orgId,
  userId,
  agentId,
  agentScope = false,
  memoryServiceUrl,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
  limit = MAX_CORE,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const params = new URLSearchParams({ agent_id: agentId || 'quox' });
    if (agentScope && agentId) params.set('agent_scope', '1');
    const url = `${memoryServiceUrl}/api/memory/core?${params}`;
    const resp = await doFetch(url, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const core = (data.memories || []).slice(0, limit);
    if (core.length > 0) return core;

    // core_memories is empty (the common case today) — fall back to
    // critical-importance memories rather than shipping an empty slot.
    return await fetchCriticalMemoriesFallback({
      orgId, userId, agentId, agentScope, memoryServiceUrl, serviceKey, fetchFn: doFetch, timeoutMs, limit,
    });
  } catch (err) {
    console.error(`[MemoryImplant] core memory fetch failed (org=${orgId || 'default'}): ${err.message}`);
    return [];
  }
}

/**
 * Fetch the top search hits relevant to the current prompt.
 * Never throws — returns [] on any failure and logs it loudly.
 */
async function fetchSearchHits({
  orgId,
  userId,
  agentId,
  agentScope = false,
  prompt,
  memoryServiceUrl,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
  limit = MAX_HITS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const params = new URLSearchParams({ q: prompt || '', limit: String(limit) });
    if (agentId) params.set('agent_id', agentId);
    if (agentScope && agentId) params.set('agent_scope', '1');
    const url = `${memoryServiceUrl}/api/memory/search?${params}`;
    const resp = await doFetch(url, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).slice(0, limit);
  } catch (err) {
    console.error(`[MemoryImplant] search hit fetch failed (org=${orgId || 'default'}): ${err.message}`);
    return [];
  }
}

// QUOXMIND #1111: the org's agent identities (auth users.actor_type='agent').
// Memories they wrote are org-visible; a HUMAN's rows stay private to that
// human. Cached per org for 10 minutes. On any failure we return [] so recall
// fails CLOSED (no widening), and say so in the log.
const AGENT_USERS_TTL_MS = 10 * 60 * 1000;
const agentUsersCache = new Map();
function _resetAgentUsersCache() { agentUsersCache.clear(); }

async function fetchOrgAgentUserIds({ orgId, userId, authServiceUrl = AUTH_URL_DEFAULT, serviceKey = SERVICE_KEY_DEFAULT, fetchFn, timeoutMs = TIMEOUT_MS }) {
  if (!orgId) return [];
  const hit = agentUsersCache.get(orgId);
  if (hit && Date.now() - hit.at < AGENT_USERS_TTL_MS) return hit.ids;
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const resp = await doFetch(`${authServiceUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/agent-users`, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const ids = (data.users || []).map(u => u && u.id).filter(Boolean);
    agentUsersCache.set(orgId, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    console.error(`[MemoryImplant] agent identity list failed (org=${orgId}), recall limited to own + org-shared rows: ${err.message}`);
    return [];
  }
}

/** The org core set (pinned + auto-promoted) for this caller. Never throws. */
async function fetchCoreSet({ orgId, userId, agentUserIds = [], memoryServiceUrl, serviceKey = SERVICE_KEY_DEFAULT, fetchFn, timeoutMs = TIMEOUT_MS, limit = MAX_CORE }) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (agentUserIds.length) params.set('agent_user_ids', agentUserIds.join(','));
    const resp = await doFetch(`${memoryServiceUrl}/api/memory/core-set?${params}`, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.memories || []).slice(0, limit);
  } catch (err) {
    console.error(`[MemoryImplant] core-set fetch failed (org=${orgId || 'default'}): ${err.message}`);
    return [];
  }
}

/** Cross-agent org recall for the current prompt, ranked. Never throws. */
async function fetchOrgRecall({ orgId, userId, prompt, agentUserIds = [], memoryServiceUrl, serviceKey = SERVICE_KEY_DEFAULT, fetchFn, timeoutMs = TIMEOUT_MS, limit = MAX_HITS }) {
  if (!prompt || !String(prompt).trim()) return [];
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const params = new URLSearchParams({ q: String(prompt).slice(0, 500), limit: String(limit) });
    if (agentUserIds.length) params.set('agent_user_ids', agentUserIds.join(','));
    const resp = await doFetch(`${memoryServiceUrl}/api/memory/recall?${params}`, {
      headers: scopingHeaders({ serviceKey, orgId, userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.results || []).slice(0, limit);
  } catch (err) {
    console.error(`[MemoryImplant] org recall failed (org=${orgId || 'default'}): ${err.message}`);
    return [];
  }
}

/**
 * Truncate text to a char budget, cutting at the last full line boundary
 * within budget rather than mid-word/mid-line, with a visible marker.
 */
function truncateToCharBudget(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const clean = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${clean}\n[...truncated]`;
}

/**
 * Format fetched core memories + search hits into a single, clearly
 * delimited block, hard-capped to ~600 tokens. Returns '' when there is
 * nothing to inject.
 */
function citeLine(m) {
  const content = String(m.content || '').replace(/\s+/g, ' ').trim();
  const body = content.length > MAX_ITEM_CHARS ? `${content.slice(0, MAX_ITEM_CHARS - 1)}…` : content;
  if (!m.id) return `- ${m.label ? `${m.label}: ` : ''}${body}`;
  const date = m.created_at ? String(m.created_at).slice(0, 10) : '';
  const src = [`memory ${m.id}`, m.agent_id || 'unknown agent', m.memory_type, date].filter(Boolean).join(' · ');
  return `- [${src}] ${body}`;
}

/**
 * Format the core set + recall hits into a single, clearly delimited block,
 * hard-capped to MAX_TOKENS. Memories with an id are cited
 * ([memory <id> · <agent> · <type> · <date>]) and deduped across sections.
 * Returns '' when there is nothing to inject.
 */
function formatMemoryContextBlock({ core = [], hits = [], maxChars = MAX_CHARS } = {}) {
  const seen = new Set();
  const keep = (m) => {
    if (!m || !m.content) return false;
    // The agent's own earlier answers (tags conversation_qa, from chat or AEE mining) are never grounding:
    // re-feeding them let an answer cite itself (proof integrity, 2026-10-19).
    if (Array.isArray(m.tags) && m.tags.includes('conversation_qa')) return false;
    const key = m.id || `c:${m.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const cappedCore = core.filter(keep).slice(0, MAX_CORE);
  const cappedHits = hits.filter(keep).slice(0, MAX_HITS);

  if (cappedCore.length === 0 && cappedHits.length === 0) return '';

  const lines = ['[MEMORY CONTEXT]'];
  if (cappedCore.length > 0) {
    lines.push('Core memories:');
    cappedCore.forEach(m => lines.push(citeLine(m)));
  }
  if (cappedHits.length > 0) {
    lines.push('Relevant memories:');
    cappedHits.forEach(m => lines.push(citeLine(m)));
  }
  if ([...cappedCore, ...cappedHits].some(m => m.id)) {
    lines.push('These are this org\'s stored memories, written by the agent named in each bracket. When an answer uses one, cite it as (memory <id>, <agent>).');
  }
  lines.push('[/MEMORY CONTEXT]');

  return truncateToCharBudget(lines.join('\n'), maxChars);
}

/**
 * Build the memory implant for the current chat turn. Never throws — any
 * failure degrades to '' (proceed without memory context).
 */
async function buildMemoryImplant({
  orgId,
  userId,
  agentId,
  prompt,
  // VULCAN-DASH S1: when undefined, auto-derive from the agent identity
  // (named/attached agents read their org+agent namespace; the default
  // personal assistant stays per-user). Pass an explicit boolean to override.
  agentScope,
  // QUOXMIND #1111: the org core set + cross-agent recall. Default on for
  // every agent; false for an agent restricted to its own namespace.
  orgRecall = true,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  authServiceUrl = AUTH_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
}) {
  try {
    const scopeToAgent = agentScope === undefined ? isAgentScopedIdentity(agentId) : !!agentScope;
    const orgPart = orgRecall
      ? fetchOrgAgentUserIds({ orgId, userId, authServiceUrl, serviceKey, fetchFn, timeoutMs }).then(agentUserIds => Promise.all([
        fetchCoreSet({ orgId, userId, agentUserIds, memoryServiceUrl, serviceKey, fetchFn, timeoutMs }),
        fetchOrgRecall({ orgId, userId, prompt, agentUserIds, memoryServiceUrl, serviceKey, fetchFn, timeoutMs }),
      ]))
      : Promise.resolve([[], []]);
    const [core, hits, [coreSet, recall]] = await Promise.all([
      fetchCoreMemories({ orgId, userId, agentId, agentScope: scopeToAgent, memoryServiceUrl, serviceKey, fetchFn, timeoutMs }),
      fetchSearchHits({ orgId, userId, agentId, agentScope: scopeToAgent, prompt, memoryServiceUrl, serviceKey, fetchFn, timeoutMs }),
      orgPart,
    ]);
    // Core: pinned/auto org core set first, then the agent's own core rows.
    // Recall: cross-agent org hits first (cited), then the agent's own hits.
    const allCore = [...coreSet, ...core];
    const allHits = [...recall, ...hits];
    const block = formatMemoryContextBlock({ core: allCore, hits: allHits });
    if (block) {
      const ids = new Set();
      const count = (list) => list.filter(m => m && m.content && !ids.has(m.id || m.content) && ids.add(m.id || m.content)).length;
      const nCore = Math.min(MAX_CORE, count(allCore));
      const nRecall = Math.min(MAX_HITS, count(allHits));
      console.log(`[MemoryImplant] injected ${block.length} chars (core=${nCore}, recall=${nRecall}) org=${orgId || 'default'} agent=${agentId || 'quox'}`);
    }
    return block;
  } catch (err) {
    // Belt-and-braces: fetchCoreMemories/fetchSearchHits already catch their
    // own errors, but this must never propagate and fail the chat turn.
    console.error(`[MemoryImplant] injection failed, proceeding without context: ${err.message}`);
    return '';
  }
}

/**
 * Override sanitizedContext.memory_context with the implant block. The
 * server-side implant SUPERSEDES any frontend-supplied memory_context
 * (which can be stale — e.g. localStorage counts). If the implant is empty
 * (memory service down/timeout/nothing relevant), the existing value is
 * left untouched so the chat turn proceeds unaffected.
 */
function applyMemoryImplant(sanitizedContext, implantBlock) {
  if (!implantBlock) return sanitizedContext;
  return { ...sanitizedContext, memory_context: implantBlock };
}

module.exports = {
  fetchCoreMemories,
  fetchCriticalMemoriesFallback,
  fetchSearchHits,
  truncateToCharBudget,
  formatMemoryContextBlock,
  buildMemoryImplant,
  applyMemoryImplant,
  isAgentScopedIdentity,
  fetchOrgAgentUserIds,
  fetchCoreSet,
  fetchOrgRecall,
  _resetAgentUsersCache,
  MAX_TOKENS,
  MAX_CORE,
  MAX_HITS,
};
