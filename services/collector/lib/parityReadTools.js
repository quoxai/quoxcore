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

const SOURCE_KINDS = ['AEE', 'AOCL', 'VOLT'];

const ward_verify = {
  name: 'ward_verify',
  description: 'Verify the WARD witness receipt for one envelope id (an AEE envelope, or an AOCL/VOLT source): WITNESSED means it is in the tamper-evident chain under a verified signed tip. Read-only; the same check as `quox governance ward verify --envelope <id>`.',
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
      return { success: false, error: `WARD receipt check failed: ${e && e.message}` };
    }
  },
};

const _wardStatusCache = new Map(); // org -> { v, exp }; whole-chain counts are not cheap
const WARD_STATUS_TTL_MS = 60000;

const ward_status = {
  name: 'ward_status',
  description: 'WARD witness chain health: total entries, signed tips, witness signer state, and how many entries this org has. Read-only; the same as `quox governance ward status`.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async (_input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    const hit = _wardStatusCache.get(orgId);
    if (hit && hit.exp > Date.now()) return hit.v;
    const ward = await wardService();
    if (!ward || typeof ward.getStats !== 'function') return { success: false, error: 'WARD is not available on this instance; chain health is unknown. Say so; do not guess.' };
    try {
      const stats = ward.getStats();
      const witness = typeof ward.getWitnessStats === 'function' ? ward.getWitnessStats() : null;
      const orgEntries = typeof ward.getEntryCountByOrg === 'function' ? ward.getEntryCountByOrg(orgId) : null;
      const v = { success: true, stats, witness, org_entries: orgEntries };
      _wardStatusCache.set(orgId, { v, exp: Date.now() + WARD_STATUS_TTL_MS });
      return v;
    } catch (e) {
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
const agent_directory = {
  name: 'agent_directory',
  description: 'List the specialist agents you can talk to or delegate to, with each one\'s registered role and capability domains; with agent_id, one agent\'s full registered capabilities and granted tools. Read-only; the source of truth for what an agent can do.',
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
      const one = input && typeof input.agent_id === 'string' && input.agent_id.trim() ? input.agent_id.trim().toLowerCase() : null;
      if (one) {
        const e = deps.getAgent(one);
        if (!e) return { success: false, error: `No agent with id "${one}" is registered.` };
        return { success: true, agent: shape(e, true) };
      }
      const agents = (deps.listAgents() || []).map((id) => deps.getAgent(id)).filter(Boolean).map((e) => shape(e, false));
      return { success: true, count: agents.length, agents };
    } catch (e) {
      return { success: false, error: `Agent registry read failed: ${e && e.message}` };
    }
  },
};

const PARITY_READ_TOOLS = { ward_verify, ward_status, standing_grants_list, safety_status, memory_history, agent_directory };
const PARITY_READ_TOOL_NAMES = Object.keys(PARITY_READ_TOOLS);

module.exports = { PARITY_READ_TOOLS, PARITY_READ_TOOL_NAMES, setParityReadDeps, __resetParityDepsForTesting };
