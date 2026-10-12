/**
 * QuoxIdentity P1 (territory B, collector) — the attach kit.
 *
 * GET /api/v1/agent-attach/kit renders everything a live CLI session needs
 * to run AS an attached agent: system prompt, tool scope, llm config, and a
 * best-effort core-memory slice. See docs/QUOXIDENTITY_P1_CONTRACT.md for
 * the binding contract; this module implements the "Collector" section.
 *
 * Route logic lives here (not inline in server.js) and is wired up as a
 * dependency-injected handler factory, mirroring the existing
 * createBackupTriggerHandler/createBackupDownloadHandler pattern
 * (lib/qlusterBackupProxy.js) — server.js passes in the real
 * storeAuditEnvelope as `audit`; tests inject a stub.
 */

'use strict';

const { deriveActorType } = require('../utils/httpAuth.js');
const { getAssistant, getAssistantPrompt, HOUSE_VOICE } = require('./entityAssistantLoader.js');
// AGENT_TOOLS[agentId] is already an array of LLM-safe tool NAMES (no dots —
// see [llm-tool-name-vs-storage-id] gotcha in the contract); used verbatim,
// no name transform needed.
// getToolDef(name, orgId) resolves a tool's definition (hardcoded TOOL_DEFS or a
// dynamic toolsmith/Divergence tool from the store) — used to hydrate per-tool
// input schemas into the kit so an attached agent knows each tool's input shape
// without trial-and-erroring `{}` (autonomous tooling audit, 2026-09-21).
const { AGENT_TOOLS, getToolDef } = require('./agentTools.js');
// llm config source: the SAME policy resolver server.js's own chat
// dispatchers call for an assistant's llm/llmPolicy (see server.js's
// /internal chat fast-path and /chat dispatch, both `require('./lib/llmRoutingPolicy.cjs')`
// and call resolveCollectorPolicyPlan({ orgId, selectedAgent, ... })).
const { resolveCollectorPolicyPlan } = require('./llmRoutingPolicy.cjs');
// QUOXIDENTITY P2 (territory D): reuse the handoff lookup rather than
// forking it — kit.memory.handoff and the handoff endpoint must agree on
// what counts as "the handoff" (tags contain 'handoff', freshest first).
const { fetchLatestHandoffMemory } = require('./agentAttachHandoff.js');

// quox#576 flaw #2: a custom/org assistant's real primary key is a ULID
// (auth routes/assistants.js: `const id = ulid()`, always UPPERCASE
// Crockford base32 — 26 chars, alphabet 0-9A-HJKMNP-TV-Z, excludes
// I/L/O/U). Blindly lowercasing req.user.agent_id below (as this file used
// to) corrupts a ULID claim so it can never match auth's case-sensitive
// `WHERE id = ?` (routes/internal-assistants.js), meaning attach-by-ULID
// only ever worked by luck when the caller typed the (already-lowercase)
// slug instead. Mirrors auth's lib/agentIdentity.js normalizeAgentId()
// ULID branch so a legacy/stale-cased claim (a lease minted before that fix
// shipped) self-heals here too, rather than compounding the damage.
const ULID_RE = /^[0-9A-Z]{26}$/i;
function normalizeAttachAgentId(raw) {
  const s = String(raw || '').trim();
  return ULID_RE.test(s) ? s.toUpperCase() : s.toLowerCase();
}

const MEMORY_URL_DEFAULT = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const MEMORY_FETCH_TIMEOUT_MS = 2000;
// QuoxIdentity custom-attach fix Part A (#487): same host/port convention
// other collector modules use to reach auth's /api/internal/* surface
// (e.g. reflectionMiningScheduler.js's AUTH_URL).
const AUTH_URL_DEFAULT = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;

// QUOXIDENTITY P2: durable memory budget for kit hydration.
// finding-8 follow-on (SEER round 3): the original 600-token budget dropped an
// 8-note orientation set to ~4, and because ordering was newest-first the
// OLDEST note (the agent's mission — the most orientation-critical) fell off.
// Raised to hold a realistic agent orientation set, and hydration is now
// ordered by importance THEN recency (see fetchDurableMemoriesForKit) so a
// marked-important note survives the cap even when the budget is hit.
const DURABLE_MAX_ITEMS = 20;
const DURABLE_MAX_TOKENS = 2000;
const DURABLE_CHARS_PER_TOKEN = 4;
const DURABLE_MAX_CHARS = DURABLE_MAX_TOKENS * DURABLE_CHARS_PER_TOKEN;

// Importance rank for hydration ordering (higher survives the cap first).
const IMPORTANCE_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// Same fallback server.js's own resolveCollectorPolicyPlan() callers use
// when policy resolution throws (see server.js fast-path catch: "defaulting
// to anthropic/claude-sonnet-4-6").
const DEFAULT_LLM = Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'default' });

/**
 * Resolve the kit's `llm` field via the shared policy resolver, falling
 * back to DEFAULT_LLM on any failure (no org policy, auth service
 * unreachable, resolver throws) — never throws itself.
 */
async function resolveKitLlm({ orgId, agentId }) {
  try {
    const resolved = await resolveCollectorPolicyPlan({ orgId, selectedAgent: agentId });
    const plan = resolved?.plan;
    if (plan?.provider && plan?.model) {
      return { provider: plan.provider, model: plan.model, source: plan.source || 'policy' };
    }
    return { ...DEFAULT_LLM };
  } catch (err) {
    console.warn(`[AgentAttachKit] llm policy resolution failed for agent=${agentId}, using DEFAULT: ${err.message}`);
    return { ...DEFAULT_LLM };
  }
}

/**
 * QuoxIdentity custom-attach fix Part A (QuoxPlan #487) — ADDITIVE fallback.
 * getAssistant()/getAssistantPrompt() (entityAssistantLoader.js) only know
 * static core agents (the JSON files under src/config/entities/assistants/).
 * A USER/ORG-created custom assistant lives in auth's SQLite `assistants`
 * table instead and has no static entry, so a plain attach on a custom id
 * previously 404d with "unknown_agent" even though grant/attach was already
 * agent-agnostic. This resolves ONE custom assistant, org-scoped, via
 * auth's internal endpoint (services/auth/routes/internal-assistants.js) —
 * same self-fetch convention (X-Service-Key) fetchCoreMemoriesForKit above
 * uses for the memory service. Never throws: any failure (network error,
 * non-2xx, including an ordinary 404 for an id that is neither a core nor a
 * custom agent) resolves to `{ assistant: null }`, which the caller treats
 * as "not a custom assistant either" and falls through to the existing
 * unknown_agent 404.
 */
async function fetchCustomAssistantForKit({
  orgId,
  agentId,
  authServiceUrl = AUTH_URL_DEFAULT,
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn,
  timeoutMs = MEMORY_FETCH_TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const url = `${authServiceUrl}/api/internal/assistants/${encodeURIComponent(agentId)}?org_id=${encodeURIComponent(orgId || '')}`;
    const resp = await doFetch(url, {
      headers: {
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || '',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      // A 404 here is the ordinary "not a custom assistant either" case,
      // not a failure worth logging loudly; anything else (5xx, auth
      // unreachable) is worth a line since it silently degrades a kit fetch.
      if (resp.status !== 404) {
        console.error(`[AgentAttachKit] custom assistant lookup failed for agent=${agentId} — HTTP ${resp.status}`);
      }
      return { assistant: null };
    }
    const data = await resp.json();
    // Shape check, not just "any truthy JSON": the internal endpoint's real
    // success body always carries `id` (routes/internal-assistants.js). This
    // guards against treating some other 2xx JSON body as a valid custom
    // assistant.
    return { assistant: data && typeof data === 'object' && typeof data.id === 'string' ? data : null };
  } catch (err) {
    console.error(`[AgentAttachKit] custom assistant fetch failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { assistant: null };
  }
}

/**
 * Build the kit's per-tool input schemas: for each tool the agent can call,
 * resolve its definition (hardcoded TOOL_DEFS or a dynamic toolsmith/Divergence
 * tool) and carry its description + input_schema so an attached session knows
 * the required/optional fields up front. Never throws: a tool whose definition
 * can't be resolved (some connector-family tools) is simply omitted — its name
 * still appears in kit.tools, it just has no schema hint.
 */
function buildToolSchemas(tools, orgId) {
  const out = {};
  for (const name of Array.isArray(tools) ? tools : []) {
    try {
      const def = getToolDef(name, orgId || '__global__');
      if (def && def.input_schema) {
        out[name] = {
          description: typeof def.description === 'string' ? def.description.slice(0, 240) : undefined,
          input_schema: def.input_schema,
        };
      }
    } catch {
      // best-effort per tool
    }
  }
  return out;
}

/**
 * Best-effort fetch of the agent's core memories from the memory service.
 * 2s timeout. On ANY failure (non-2xx, network error, timeout) returns an
 * empty core list WITH `memory_error` set — never a silent [] (contract:
 * "no silent fallback"). Uses the same self-fetch header convention as
 * other internal collector->memory calls (INTERNAL_SERVICE_KEY).
 */
async function fetchCoreMemoriesForKit({
  orgId,
  agentId,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn,
  timeoutMs = MEMORY_FETCH_TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    // QUOXIDENTITY F8: agent_scope=1 reads the whole agent namespace (org +
    // agent_id), not just rows written under X-User-Id: 'service'. Without it,
    // core promoted from an attached session's critical writes (which land
    // under the agent service user) never hydrates.
    const params = new URLSearchParams({ agent_id: agentId || '', agent_scope: '1' });
    const url = `${memoryServiceUrl}/api/memory/core?${params}`;
    const resp = await doFetch(url, {
      headers: {
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || 'default',
        'X-User-Id': 'service',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return { core: [], memory_error: `memory_service_http_${resp.status}` };
    }
    const data = await resp.json();
    return { core: Array.isArray(data.memories) ? data.memories : [], memory_error: null };
  } catch (err) {
    console.error(`[AgentAttachKit] core memory fetch failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { core: [], memory_error: err.message || 'memory_fetch_failed' };
  }
}

/**
 * Cap an already-freshest-first list of memories to maxItems OR a running
 * content-char budget, whichever is hit first (contract: "cap 20 items or
 * ~600 tokens whichever first"). Never truncates a single item's content —
 * it stops including further items once the budget would be exceeded.
 */
function capDurableMemories(memories, { maxItems = DURABLE_MAX_ITEMS, maxChars = DURABLE_MAX_CHARS } = {}) {
  const capped = [];
  let chars = 0;
  for (const m of memories) {
    if (capped.length >= maxItems) break;
    const len = (m && typeof m.content === 'string') ? m.content.length : 0;
    if (capped.length > 0 && chars + len > maxChars) break;
    capped.push(m);
    chars += len;
  }
  return capped;
}

/**
 * Best-effort fetch of the agent's durable ('fact') memories for kit
 * hydration: agent_id filter, memory_role='fact', freshest first (the
 * underlying GET /api/memory list already orders by created_at DESC),
 * capped via capDurableMemories(). On ANY failure returns an empty list WITH
 * memory_error set — same "no silent fallback" contract as
 * fetchCoreMemoriesForKit above.
 */
async function fetchDurableMemoriesForKit({
  orgId,
  agentId,
  memoryServiceUrl = MEMORY_URL_DEFAULT,
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn,
  timeoutMs = MEMORY_FETCH_TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    // Over-fetch since memory_role isn't filterable server-side on GET
    // /api/memory yet — same convention as lib/memoryImplant.js's
    // fetchCriticalMemoriesFallback.
    // QUOXIDENTITY F8: agent_scope=1 — see fetchCoreMemoriesForKit. Durable
    // 'fact' memories an attached session writes land under the agent service
    // user, so a user_id-scoped read misses them; agent_scope hydrates the full
    // agent namespace within the org.
    const params = new URLSearchParams({ agent_id: agentId || '', limit: String(DURABLE_MAX_ITEMS * 2), agent_scope: '1' });
    const url = `${memoryServiceUrl}/api/memory?${params}`;
    const resp = await doFetch(url, {
      headers: {
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || 'default',
        'X-User-Id': 'service',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return { durable: [], memory_error: `memory_service_http_${resp.status}` };
    }
    const data = await resp.json();
    const rows = Array.isArray(data.memories) ? data.memories : [];
    const facts = rows.filter((m) => (m?.memory_role || 'fact') === 'fact');
    // finding-8 follow-on: order by importance THEN recency before capping, so
    // a marked-important note survives the budget even if it is old. rows
    // already arrive created_at DESC; V8's sort is stable, so equal-importance
    // notes keep that freshest-first order.
    const ordered = facts
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ra = IMPORTANCE_RANK[a.m?.importance] ?? IMPORTANCE_RANK.medium;
        const rb = IMPORTANCE_RANK[b.m?.importance] ?? IMPORTANCE_RANK.medium;
        return rb - ra || a.i - b.i;
      })
      .map((x) => x.m);
    return { durable: capDurableMemories(ordered), memory_error: null };
  } catch (err) {
    console.error(`[AgentAttachKit] durable memory fetch failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { durable: [], memory_error: err.message || 'memory_fetch_failed' };
  }
}

/**
 * QUOXIDENTITY P3 (territory F): best-effort kit.slot hydration from the
 * agent's slot binding (lib/agentSlotBindings.js) + the live dev_slots row
 * (lib/devSlotsStore.js, read only — no new SQL here, per contract). Never
 * throws: any failure (unlicensed org, no binding, binding points at a
 * since-deleted slot, a store call itself throwing) degrades to
 * `{ slot: null, slot_error }`, and an agent with no binding at all is the
 * ordinary case (`{ slot: null }`, no error — there is nothing wrong, there
 * is just no address yet).
 *
 * `getSlotBinding` and `getSlot` are optional DI seams (P1's kit shipped
 * before P3 existed, with `slot: null` hardcoded); when either is absent
 * this resolves to the same P1 default rather than throwing, so a
 * not-yet-wired deployment degrades gracefully instead of 500ing every kit
 * fetch.
 */
async function resolveKitSlot({ orgId, agentId, getSlotBinding, getSlot, isPluginLicensed }) {
  if (typeof getSlotBinding !== 'function' || typeof getSlot !== 'function') {
    return { slot: null, slot_error: null };
  }
  try {
    if (typeof isPluginLicensed === 'function') {
      const licensed = await isPluginLicensed(orgId, 'quoxslots');
      if (!licensed) return { slot: null, slot_error: 'licence' };
    }
    const binding = getSlotBinding({ orgId, agentId });
    if (!binding) return { slot: null, slot_error: null };

    const slotRow = getSlot({ orgId, name: binding.slot_name });
    if (!slotRow) {
      // The binding still exists but the slot address it names does not
      // (e.g. retired after the binding was set) — best-effort degrade,
      // never a silent slot:null with no explanation of why.
      return { slot: null, slot_error: 'slot_not_found' };
    }

    return {
      slot: {
        name: slotRow.name,
        matrix_room_id: slotRow.matrix_room_id || null,
        holder_session: slotRow.holder_session || null,
        state: slotRow.state,
      },
      slot_error: null,
    };
  } catch (err) {
    console.error(`[AgentAttachKit] slot hydration failed (org=${orgId || 'default'}, agent=${agentId}): ${err.message}`);
    return { slot: null, slot_error: err.message || 'slot_hydration_failed' };
  }
}

/**
 * Express handler factory for GET /api/v1/agent-attach/kit.
 * @param {object} deps
 * @param {(envelope: object) => void} [deps.audit] - storeAuditEnvelope (server.js)
 * @param {Function} [deps.fetchFn] - override for the memory-service AND auth-service fetch (tests)
 * @param {string} [deps.memoryServiceUrl] - override for the memory service base URL (tests)
 * @param {string} [deps.authServiceUrl] - QuoxIdentity custom-attach fix Part A: override for the auth service base URL (tests)
 * @param {Function} [deps.getSlotBinding] - QUOXIDENTITY P3: agentSlotBindings.getBinding
 * @param {Function} [deps.getSlot] - QUOXIDENTITY P3: devSlotsStore.getSlot
 * @param {Function} [deps.isPluginLicensed] - QUOXIDENTITY P3: (orgId, pluginId) => Promise<boolean>
 */
function createAgentAttachKitHandler(deps = {}) {
  const audit = deps.audit || (() => {});
  const fetchFn = deps.fetchFn;
  const memoryServiceUrl = deps.memoryServiceUrl || MEMORY_URL_DEFAULT;
  const authServiceUrl = deps.authServiceUrl || AUTH_URL_DEFAULT;
  const getSlotBinding = deps.getSlotBinding;
  const getSlot = deps.getSlot;
  const isPluginLicensed = deps.isPluginLicensed;

  return async function agentAttachKitHandler(req, res) {
    // Mounted behind requireServiceOrUserAuth() in server.js (like siblings).
    // P1: only an attach-bound agent caller may fetch a kit — a plain
    // resident/user JWT (actor_type 'human') or an ordinary agent token
    // minted without an attach lease (actor_type 'agent' but no
    // attach_lease_id claim) is rejected with 403.
    const actorType = deriveActorType(req);
    const leaseId = req.user?.attach_lease_id || null;
    if (actorType !== 'agent' || !leaseId) {
      return res.status(403).json({
        error: 'attach_required',
        message: 'This endpoint requires an active attach lease (an agent-scoped token carrying an attach_lease_id claim).',
      });
    }

    const agentId = normalizeAttachAgentId(req.user.agent_id);
    const assistant = agentId ? getAssistant(agentId) : null;
    const orgId = req.user.org_id || null;

    // QuoxIdentity custom-attach fix Part A (#487): ADDITIVE fallback. A
    // static core agent (assistant truthy) never reaches this fetch — the
    // static path below is byte-for-byte what it was before this fix. Only
    // an agent_id with NO static entry is checked against the auth
    // `assistants` table (org-scoped custom assistants).
    let customAssistant = null;
    if (agentId && !assistant) {
      const result = await fetchCustomAssistantForKit({ orgId, agentId, authServiceUrl, fetchFn });
      customAssistant = result.assistant;
    }

    if (!agentId || (!assistant && !customAssistant)) {
      return res.status(404).json({ error: 'unknown_agent', message: `No registered assistant for agent_id '${agentId}'` });
    }

    let systemPrompt = '';
    if (assistant) {
      try {
        systemPrompt = (await getAssistantPrompt(agentId)) || '';
      } catch (err) {
        console.error(`[AgentAttachKit] system prompt load failed for agent=${agentId}: ${err.message}`);
      }
    } else if (customAssistant) {
      // Custom assistants have no persona.md file — use the DB system_prompt
      // directly, still appending the same house-voice rules the static
      // path appends via getAssistantPrompt().
      systemPrompt = [customAssistant.system_prompt || '', HOUSE_VOICE].filter(Boolean).join('\n');
    }

    const tools = assistant
      ? (AGENT_TOOLS[agentId] || [])
      : (Array.isArray(customAssistant?.tools) ? customAssistant.tools : []);
    // Per-tool input schemas so the attached session knows each tool's shape
    // (required/optional fields) up front instead of probing with `{}` — the
    // top recurring finding of the 2026-09-21 tooling audit.
    const tool_schemas = buildToolSchemas(tools, orgId);
    const llm = await resolveKitLlm({ orgId, agentId });

    // QUOXIDENTITY P2: core (existing, P1) + durable (agent 'fact' memories,
    // budget-capped) + handoff (single freshest 'handoff'-tagged memory),
    // all best-effort in parallel — none may throw, each degrades to
    // empty/null with its own error surfaced via the aggregated memory_error
    // below (contract: "never silent").
    const [
      { core, memory_error: coreError },
      { durable, memory_error: durableError },
      { handoff, error: handoffError },
      { slot, slot_error },
    ] = await Promise.all([
      fetchCoreMemoriesForKit({ orgId, agentId, memoryServiceUrl, fetchFn }),
      fetchDurableMemoriesForKit({ orgId, agentId, memoryServiceUrl, fetchFn }),
      fetchLatestHandoffMemory({ orgId, agentId, memoryServiceUrl, fetchFn }),
      resolveKitSlot({ orgId, agentId, getSlotBinding, getSlot, isPluginLicensed }),
    ]);
    const memory_error = coreError || durableError || handoffError || null;

    const kit = {
      agent_id: agentId,
      display_name: assistant?.identity?.name || customAssistant?.name || agentId,
      system_prompt: systemPrompt,
      tools,
      tool_schemas,
      llm,
      memory: { namespace: agentId, core, durable, handoff: handoff || null, memory_error },
      slot, // QUOXIDENTITY P3
      slot_error, // QUOXIDENTITY P3: null when slot is a valid address or genuinely unbound
      lease: {
        id: leaseId,
        expires_at: req.user.exp ? new Date(req.user.exp * 1000).toISOString() : null,
      },
      contract_version: 1,
    };

    // Witness EVERY kit fetch (contract: AEE envelope, intent
    // quox.identity.attach_kit_fetch, from=agent.<agent_id>). Audit failure
    // must never fail the fetch itself.
    try {
      audit({
        type: 'event',
        from: `agent.${agentId}`,
        to: 'audit.system',
        intent: 'quox.identity.attach_kit_fetch',
        corr: leaseId,
        org_id: orgId,
        payload: {
          lease_id: leaseId,
          org_id: orgId,
          ...(req.user.session_label ? { session_label: req.user.session_label } : {}),
        },
      });
    } catch (err) {
      console.warn('[AgentAttachKit] audit envelope emit failed (non-fatal):', err.message);
    }

    return res.json(kit);
  };
}

module.exports = {
  createAgentAttachKitHandler,
  resolveKitLlm,
  fetchCoreMemoriesForKit,
  fetchDurableMemoriesForKit,
  fetchCustomAssistantForKit,
  capDurableMemories,
  resolveKitSlot,
  DEFAULT_LLM,
};
