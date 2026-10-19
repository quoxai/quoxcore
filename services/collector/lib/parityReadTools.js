'use strict';
/**
 * QUOXON-PARITY lane E1: read-only agent tools for what the CLI can already read.
 *
 *   ward_verify           quox governance ward verify --envelope <id>   (#809)
 *   ward_status           quox governance ward status                   (#811)
 *   standing_grants_list  quox approvals grants list                    (#811)
 *   safety_status         quox safety status                            (#810)
 *   memory_history        quox memory history <id>                      (#811)
 *   agent_directory       the agent registry (capabilities, tools)      (#818)
 *
 * Every tool reads in-process (or, for memory, the memory service with the caller's
 * own identity) and scopes to ctx.orgId, the org the chat dispatcher resolved from the
 * turn's verified identity. No tool accepts an org id from the model, and none acts
 * with a service key on a model-supplied id outside that org: a WARD entry tagged to
 * another org is answered exactly like a missing one.
 *
 * Failure is never data: a store that cannot be read returns success:false with the
 * reason, never "none active", "GREEN" or "not witnessed".
 */

let deps = {};

/** server.js / agentTools.js wire the live stores here. */
function setParityReadDeps(next) { deps = { ...deps, ...(next || {}) }; }
function __resetParityDepsForTesting() { deps = {}; _wardStatusCache.clear(); }

const NO_ORG = { success: false, error: 'No organization context for this turn; refusing to read.' };

async function wardService() {
  if (typeof deps.getWardService !== 'function') return null;
  try { return (await deps.getWardService()) || null; } catch { return null; }
}
const WARD_UNAVAILABLE = { success: false, error: 'WARD is not available on this instance, so the receipt cannot be checked. Say so; do not guess.' };
// #1046: the WARD module can load while its store is closed (boot window, or the
// gracefulShutdown grace during a redeploy). That is "not ready, retry", never the raw
// internal "call initWardStore()" error and never a verdict.
const WARD_NOT_READY = { success: false, retryable: true, error: 'WARD is not ready on this instance right now (the collector is starting or restarting), so this cannot be checked yet. Say so and retry shortly; do not guess.' };
const isStoreNotReady = (e) => /not initiali[sz]ed/i.test(String(e && e.message));
function wardStoreReady(ward) {
  if (typeof ward.getDb !== 'function') return true;
  try { return !!ward.getDb(); } catch { return false; }
}

const SOURCE_KINDS = ['AEE', 'AOCL', 'VOLT'];

const ward_verify = {
  name: 'ward_verify',
  description: 'Verify the WARD witness receipt for one envelope id (an AEE envelope, or an AOCL/VOLT source): WITNESSED means it is in the tamper-evident chain under a verified signed tip. Read-only; the same check as `quox governance ward verify --envelope <id>`. To LIST recent chain entries (with their source kinds), do not loop this over envelopes: delegate to the auditus specialist, which holds ward_query_entries.',
  input_schema: {
    type: 'object',
    properties: {
      envelope_id: { type: 'string', description: 'The envelope (source event) id, e.g. 01M4V6QPP2X82G6GFPZZK1P7XA or ENV_...' },
      source_kind: { type: 'string', enum: SOURCE_KINDS, description: 'Source protocol of the id (default AEE).' },
    },
    required: ['envelope_id'],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const id = String((input && (input.envelope_id || input.source_id)) || '').trim();
    if (!id) return { success: false, error: 'envelope_id is required' };
    const kind = SOURCE_KINDS.includes(input && input.source_kind) ? input.source_kind : 'AEE';
    const ward = await wardService();
    if (!ward || typeof ward.verifyReceipt !== 'function') return WARD_UNAVAILABLE;
    if (!wardStoreReady(ward)) return WARD_NOT_READY;
    try {
      const entry = typeof ward.getEntryBySourceAnyChain === 'function' ? ward.getEntryBySourceAnyChain(kind, id) : null;
      // Another org's entry is answered exactly like a missing one: no existence leak.
      if (!entry || (entry.org_id && entry.org_id !== orgId)) {
        return {
          success: true, status: 'NOT_WITNESSED', witnessed: false, source_kind: kind, source_id: id,
          message: `No WARD witness entry exists for ${kind} ${id} in this org. It is not witnessed (or the id is wrong).`,
        };
      }
      let keypair = null;
      try { keypair = typeof ward.getHookKeypair === 'function' ? ward.getHookKeypair() : null; } catch { keypair = null; }
      const r = ward.verifyReceipt({
        chainId: entry.chain_id || undefined, sourceKind: kind, sourceId: id,
        publicKey: (keypair && keypair.publicKey) || undefined, requireSignatures: true,
      }) || {};
      const witnessed = r.status === 'WITNESSED';
      return {
        success: true,
        ...r,
        witnessed,
        org_scope: entry.org_id ? 'org' : 'untagged',
        message: witnessed
          ? `${kind} ${id} is WITNESSED: in the WARD chain under a verified signed tip.`
          : `${kind} ${id} receipt status ${r.status || 'UNKNOWN'}${r.reason ? ` (${r.reason})` : ''}.`,
      };
    } catch (e) {
      if (isStoreNotReady(e)) return WARD_NOT_READY;
      return { success: false, error: `WARD receipt check failed: ${e && e.message}` };
    }
  },
};

const _wardStatusCache = new Map(); // org -> { v, exp }; whole-chain counts are not cheap
const WARD_STATUS_TTL_MS = 60000;

const ward_status = {
  name: 'ward_status',
  description: 'WARD witness chain health: total entries, signed tips, witness signer state, and how many entries this org has. Read-only; the same as `quox governance ward status`. Totals only: to LIST the entries themselves, delegate to the auditus specialist (ward_query_entries).',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async (_input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const hit = _wardStatusCache.get(orgId);
    if (hit && hit.exp > Date.now()) return hit.v;
    const ward = await wardService();
    if (!ward || typeof ward.getStats !== 'function') return { success: false, error: 'WARD is not available on this instance; chain health is unknown. Say so; do not guess.' };
    if (!wardStoreReady(ward)) return WARD_NOT_READY;
    try {
      const stats = ward.getStats();
      const witness = typeof ward.getWitnessStats === 'function' ? ward.getWitnessStats() : null;
      const orgEntries = typeof ward.getEntryCountByOrg === 'function' ? ward.getEntryCountByOrg(orgId) : null;
      const v = { success: true, stats, witness, org_entries: orgEntries };
      _wardStatusCache.set(orgId, { v, exp: Date.now() + WARD_STATUS_TTL_MS });
      return v;
    } catch (e) {
      if (isStoreNotReady(e)) return WARD_NOT_READY;
      return { success: false, error: `WARD status read failed: ${e && e.message}` };
    }
  },
};

const standing_grants_list = {
  name: 'standing_grants_list',
  description: "List the org's standing grants: org-admin pre-approved fleet command lanes (one host plus an anchored ssh_exec command), active only unless include_inactive. Read-only; the same as `quox approvals grants list`.",
  input_schema: {
    type: 'object',
    properties: { include_inactive: { type: 'boolean', description: 'Also list revoked and expired grants.' } },
    required: [],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const store = deps.standingGrants || require('./fleetStandingGrants.js');
    try {
      const grants = store.listGrants(orgId, { includeInactive: !!(input && input.include_inactive) }) || [];
      return { success: true, count: grants.length, grants };
    } catch (e) {
      return { success: false, error: `Standing grant store unavailable (${e && e.message}); whether any grant is active is unknown.` };
    }
  },
};

const safety_status = {
  name: 'safety_status',
  description: "Read the org's real safety status: the DEFCON level (GREEN, BLUE, AMBER, ORANGE, RED) and the active agent kill switches (E-STOPs); with agent_id, also whether that agent is blocked from dispatch. Read-only; the same as `quox safety status`.",
  input_schema: {
    type: 'object',
    properties: { agent_id: { type: 'string', description: 'Optional agent id to check against the dispatch gate.' } },
    required: [],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const db = typeof deps.getVoltDb === 'function' ? deps.getVoltDb() : null;
    if (!db) return { success: false, error: 'The safety store is not available, so the DEFCON level is unknown. Say so; do not state a level.' };
    try {
      const ks = require('./killSwitchStore.js');
      const s = ks.getSafetyStatus(db, orgId);
      const out = { success: true, defcon: s.defcon, killSwitches: s.killSwitches || [] };
      const agentId = input && typeof input.agent_id === 'string' && input.agent_id.trim() ? input.agent_id.trim() : null;
      if (agentId) out.gate = ks.checkSafetyGate(db, orgId, agentId);
      return out;
    } catch (e) {
      return { success: false, error: `Safety status read failed (${e && e.message}); the DEFCON level is unknown.` };
    }
  },
};

const MEMORY_HISTORY_MAX = 20;

const memory_history = {
  name: 'memory_history',
  description: 'Revision history of one memory: its versions over time (corrections, supersessions, retirements), newest first. Get the memory id from memory_search first. Read-only; the same as `quox memory history <id>`.',
  input_schema: {
    type: 'object',
    properties: { memory_id: { type: 'string', description: 'The memory id (from memory_search results).' } },
    required: ['memory_id'],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const id = String((input && input.memory_id) || '').trim();
    if (!id) return { success: false, error: 'memory_id is required (find it with memory_search)' };
    // The caller's own identity: their bearer, else org/user-scoped service headers
    // (the same rule every memory tool uses, lib/memoryToolHandlers.js).
    const headers = ctx.token
      ? { Authorization: `Bearer ${ctx.token}` }
      : { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '', 'X-Org-Id': orgId, 'X-User-Id': ctx.userId || 'service' };
    const base = deps.memoryServiceUrl || process.env.MEMORY_SERVICE_URL || 'http://memory:3103';
    const f = deps.fetch || fetch;
    try {
      const res = await f(`${base}/api/memory/${encodeURIComponent(id)}/history`, { headers });
      if (res.status === 404) return { success: false, error: `Memory ${id} was not found in your memory.` };
      if (!res.ok) return { success: false, error: `Memory service returned ${res.status}; history unavailable.` };
      const body = await res.json();
      const history = Array.isArray(body && body.history) ? body.history : [];
      return { success: true, memory_id: id, count: history.length, history: history.slice(0, MEMORY_HISTORY_MAX), truncated: history.length > MEMORY_HISTORY_MAX };
    } catch (e) {
      return { success: false, error: `Memory history read failed: ${e && e.message}` };
    }
  },
};

// #818: agents described their peers from imagination (CIPHER "Tailscale mesh, DNS
// lookups"). This reads the agent registry itself: entity identity + declared
// capabilities, and for one agent its granted tool names.
const DIRECTORY_DOMAINS_MAX = 8;
// #843: `quox agent list` is the registry roster MERGED by agent_id with the org's own agent
// rows (every status except retired); this reads those rows the same way, over the auth
// service's internal route, so the directory's set and total equal the CLI's.
async function listOrgAgentsFromAuth(orgId, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const base = env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
  const url = `${base}/internal/agents?org_id=${encodeURIComponent(orgId)}&include_inactive=1`;
  const res = await fetchImpl(url, { headers: env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': env.INTERNAL_SERVICE_KEY } : {}, signal: AbortSignal.timeout(8000) });
  if (!res || !res.ok) throw new Error(`auth /internal/agents returned ${res ? res.status : 'no response'}`);
  const body = await res.json();
  if (!Array.isArray(body && body.agents)) throw new Error('auth /internal/agents returned no agents list');
  return body.agents;
}

const agent_directory = {
  name: 'agent_directory',
  description: 'List every agent in this org you can talk to or delegate to: the registered specialists plus the org\'s own agents (the same set and total as `quox agent list`), each with its role, capability domains and source; total and breakdown give the counts. With agent_id, one agent\'s full registered capabilities and granted tools. Read-only; the source of truth for what an agent can do and how many there are.',
  input_schema: {
    type: 'object',
    properties: { agent_id: { type: 'string', description: 'Optional agent id (e.g. cipher) for one agent in detail.' } },
    required: [],
  },
  execute: async (input, ctx) => {
    if (!(ctx && ctx.orgId)) return NO_ORG;
    if (typeof deps.listAgents !== 'function' || typeof deps.getAgent !== 'function') return { success: false, error: 'The agent registry is not available; agent capabilities are unknown. Say so; do not describe them.' };
    try {
      const shape = (e, full) => {
        const idn = (e && e.identity) || {};
        const cap = (e && e.capabilities) || {};
        const domains = Array.isArray(cap.domains) ? [...new Set(cap.domains)] : [];
        return {
          id: e.id, name: idn.name || e.id, role: idn.tagline || null,
          domains: full ? domains : domains.slice(0, DIRECTORY_DOMAINS_MAX),
          ...(full ? {
            description: idn.description || null,
            toolCapabilities: Array.isArray(cap.toolCapabilities) ? cap.toolCapabilities : [],
            workflows: Array.isArray(cap.workflows) ? cap.workflows : [],
            tools: typeof deps.getAgentTools === 'function' ? (deps.getAgentTools(e.id) || []) : [],
          } : {}),
        };
      };
      const shapeOrg = (o) => ({
        id: o.agentId, name: o.name || o.agentId, role: o.description ? String(o.description).slice(0, 120) : null,
        domains: Array.isArray(o.domains) ? o.domains.slice(0, DIRECTORY_DOMAINS_MAX) : [],
        status: o.status || null, level: o.level ?? null, source: 'org',
      });
      let orgRows = null; let orgError = null;
      if (typeof deps.listOrgAgents === 'function') {
        try { orgRows = (await deps.listOrgAgents(ctx.orgId)) || []; } catch (e) { orgError = (e && e.message) || String(e); }
      } else orgError = 'org agent list not wired';
      // CUSTOM-HATS (owner 2026-10-17): under an enforced hat that scopes its agents, the
      // directory is the hat's roster (the agents this turn can use), never the whole org.
      const scope = require('./delegationRoster.js').hatAgentScope(ctx.hatManifest);
      const raw = input && typeof input.agent_id === 'string' && input.agent_id.trim() ? input.agent_id.trim() : null;
      let one = raw ? raw.toLowerCase() : null;
      let resolvedFrom = null;
      if (one) {
        let e = deps.getAgent(one);
        let o = (orgRows || []).find((r) => String(r.agentId).toLowerCase() === one);
        // #962: not an id — try to resolve it as a DISPLAY NAME (identity.name, or an org agent's name),
        // case-insensitive. "hyperion"/"ATLAS" -> atlas. Only a UNIQUE match resolves; ambiguity says so.
        if (!e && !o) {
          const regMatches = (deps.listAgents() || [])
            .map((id) => deps.getAgent(id)).filter(Boolean)
            .filter((a) => String((a.identity && a.identity.name) || '').toLowerCase() === one);
          const orgMatches = (orgRows || []).filter((r) => String(r.name || '').toLowerCase() === one);
          const ids = new Set([...regMatches.map((a) => a.id), ...orgMatches.map((r) => r.agentId)].map((x) => String(x).toLowerCase()));
          if (ids.size > 1) {
            return { success: false, error: `"${raw}" is a display name shared by more than one agent (${[...ids].join(', ')}). Ask by agent id.` };
          }
          if (ids.size === 1) {
            resolvedFrom = raw;
            one = [...ids][0];
            e = deps.getAgent(one);
            o = (orgRows || []).find((r) => String(r.agentId).toLowerCase() === one);
          }
        }
        const inScope = scope ? { in_hat_scope: scope.agents.includes(one), ...(scope.agents.includes(one) ? {} : { hat_note: `${one} is outside the active hat '${scope.hatKey}': you cannot delegate to it under this hat.` }) } : {};
        if (e) return { success: true, ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}), ...inScope, agent: { ...shape(e, true), source: o ? 'org+registry' : 'registry', ...(o ? { status: o.status || null } : {}) } };
        if (o) return { success: true, ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}), ...inScope, agent: shapeOrg(o) };
        return { success: false, error: `No agent with id or name "${raw}" is registered or in this org${orgError ? ` (the org's own agents could not be read: ${orgError})` : ''}.` };
      }
      const merged = new Map();
      for (const e of (deps.listAgents() || []).map((id) => deps.getAgent(id)).filter(Boolean)) merged.set(e.id, { ...shape(e, false), source: 'registry' });
      let both = 0;
      for (const o of orgRows || []) {
        if (!o || !o.agentId) continue;
        const reg = merged.get(o.agentId);
        if (reg) { both++; merged.set(o.agentId, { ...reg, source: 'org+registry', status: o.status || null }); } else merged.set(o.agentId, shapeOrg(o));
      }
      const allAgents = [...merged.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (scope) {
        const ids = new Set(scope.agents);
        const inHat = allAgents.filter((a) => ids.has(String(a.id).toLowerCase()));
        const found = new Set(inHat.map((a) => String(a.id).toLowerCase()));
        const missing = scope.agents.filter((a) => !found.has(a));
        return {
          success: true, complete: orgRows !== null, total: inHat.length, count: inHat.length,
          scope: { hat: scope.hatKey, narrowed: true, agents_in_scope: scope.agents, org_total: orgRows === null ? null : allAgents.length, ...(missing.length ? { not_found: missing } : {}) },
          note: `These are the ${inHat.length} agent(s) the active hat '${scope.hatKey}' lets you use right now. The org has ${orgRows === null ? 'more' : allAgents.length} agents in all; the rest are outside this hat, so do not list or offer them.${missing.length ? ` The hat also names ${missing.join(', ')}, which no registered or org agent matches.` : ''}`,
          agents: inHat,
        };
      }
      const agents = allAgents;
      const registry = agents.filter((a) => a.source !== 'org').length;
      if (orgRows === null) {
        return {
          success: true, complete: false, total: null, count: agents.length, org_agents_error: orgError,
          breakdown: { registry, org_created: null, org_and_registry: null },
          note: `Only the ${agents.length} registered specialists could be read; the org's own agents could not (${orgError}), so the total is unknown. Say that; do not give ${agents.length} as the total.`,
          agents,
        };
      }
      return {
        success: true, complete: true, total: agents.length, count: agents.length,
        breakdown: { registry, org_created: agents.length - registry, org_and_registry: both },
        agents,
      };
    } catch (e) {
      return { success: false, error: `Agent registry read failed: ${e && e.message}` };
    }
  },
};

const PARITY_READ_TOOLS = { ward_verify, ward_status, standing_grants_list, safety_status, memory_history, agent_directory };
const PARITY_READ_TOOL_NAMES = Object.keys(PARITY_READ_TOOLS);

module.exports = { PARITY_READ_TOOLS, PARITY_READ_TOOL_NAMES, setParityReadDeps, __resetParityDepsForTesting, listOrgAgentsFromAuth, __depsForTesting: () => deps };
