/**
 * OPGOV agent inventory — the org-wide rollup of the reach grant graph
 * (quox#573, OPGOV #488). "You cannot govern what you have not enumerated."
 *
 * This module deliberately owns NO enumeration of its own: every per-agent
 * fact comes from the same resolver `quox reach` uses (deps.getReach →
 * getCachedStaticReach) and the same least-privilege computation behind
 * `quox reach unused` (deps.getUnused). Reach, inventory and the future
 * governance compiler consume ONE grant graph; forking it is the failure
 * mode the issue names.
 *
 * Honesty gate (load-bearing, same discipline as reachResolver): a source
 * that fails to enumerate is UNKNOWN, first-class, at whichever level it
 * failed — a whole registry (org agents store down), one agent's reach, or
 * one agent's usage window. Nothing failed is ever rendered as zero, and
 * totals only sum what actually resolved (`totals.complete` says whether
 * the rollup covered everything).
 */

'use strict';

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_UNUSED_WINDOW_DAYS = 30;

function defaultNowIso() {
  return new Date().toISOString();
}

/** Bounded-concurrency map that never rejects: each slot resolves to
 * { ok, value | error } so one agent's failure cannot sink the rollup. */
async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: (err && err.message) || String(err) };
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

function summariseReach(reach) {
  const s = reach.sources || {};
  const countOf = (zone) => (s[zone] && s[zone].ok ? s[zone].count : 'unknown');
  return {
    tools: countOf('tools'),
    credentials: countOf('credentials'),
    hosts: countOf('hosts'),
    egress: countOf('egress'),
    delegates: countOf('delegation'),
    badge: reach.badge !== undefined ? reach.badge : null,
    unknown_zones: Array.isArray(reach.unknown) ? reach.unknown.map((u) => u.zone) : [],
  };
}

/**
 * @param {{orgId: string, includeUnused?: boolean, unusedWindowDays?: number, concurrency?: number}} args
 * @param {{
 *   listCoreAssistants: () => Array<object>,          // entityAssistantLoader.listAssistants
 *   fetchOrgAgents: (orgId) => Promise<{ok: boolean, items?: Array<object>, error?: string}>,
 *   getReach: (agentId, orgId) => Promise<object>,     // getCachedStaticReach
 *   getUnused?: (agentId, orgId, windowDays) => Promise<object>, // computeLeastPrivilege wrapper
 *   nowIso?: () => string,
 * }} deps
 */
async function resolveOrgInventory(args, deps) {
  const { orgId } = args || {};
  if (!orgId) throw new Error('resolveOrgInventory: orgId is required');
  if (!deps || typeof deps.listCoreAssistants !== 'function') throw new Error('resolveOrgInventory: deps.listCoreAssistants is required');
  if (typeof deps.fetchOrgAgents !== 'function') throw new Error('resolveOrgInventory: deps.fetchOrgAgents is required');
  if (typeof deps.getReach !== 'function') throw new Error('resolveOrgInventory: deps.getReach is required');

  const nowIso = deps.nowIso || defaultNowIso;
  const includeUnused = args.includeUnused !== false && typeof deps.getUnused === 'function';
  const windowDays = args.unusedWindowDays || DEFAULT_UNUSED_WINDOW_DAYS;
  const concurrency = args.concurrency || DEFAULT_CONCURRENCY;
  const startedAt = Date.now();

  const registryUnknowns = [];

  // ---- Enumerate the subjects (WHO exists) ----
  let core = [];
  try {
    core = deps.listCoreAssistants().map((a) => ({
      id: a.id,
      name: (a.identity && a.identity.name) || a.name || a.id,
      source: 'core',
      // Model routing is per-agent config; an agent with no declared llm
      // rides the org's default routing — that is 'default-routing', not
      // unknown (we enumerated the source and it says nothing is pinned).
      model: (a.llm && a.llm.model) || null,
      provider: (a.llm && a.llm.provider) || null,
    }));
  } catch (err) {
    registryUnknowns.push({ source: 'core_assistants', statement: `core roster failed to enumerate: ${err.message}` });
  }

  const orgAgentsResult = await deps.fetchOrgAgents(orgId);
  let orgAgents = [];
  if (orgAgentsResult && orgAgentsResult.ok) {
    orgAgents = (orgAgentsResult.items || []).map((a) => ({
      id: a.id,
      name: a.name || a.id,
      source: 'org',
      model: a.model || null,
      provider: a.provider || null,
    }));
  } else {
    registryUnknowns.push({
      source: 'org_agents',
      statement: `org agent store failed to enumerate: ${(orgAgentsResult && orgAgentsResult.error) || 'no response'}`,
    });
  }

  // Dedup by id; an org-created agent shadowing a core id keeps both labels.
  const byId = new Map();
  for (const a of [...core, ...orgAgents]) {
    if (byId.has(a.id)) byId.get(a.id).source = `${byId.get(a.id).source}+${a.source}`;
    else byId.set(a.id, { ...a });
  }
  const subjects = Array.from(byId.values()).sort((x, y) => x.id.localeCompare(y.id));

  // ---- Per-agent reach + usage (WHAT each can touch, WHAT it used) ----
  const reachResults = await mapBounded(subjects, concurrency, (a) => deps.getReach(a.id, orgId));
  let unusedResults = [];
  if (includeUnused) {
    unusedResults = await mapBounded(subjects, concurrency, (a) => deps.getUnused(a.id, orgId, windowDays));
  }

  const agents = subjects.map((subject, i) => {
    const entry = { ...subject };
    const r = reachResults[i];
    if (r && r.ok && r.value) {
      entry.reach = summariseReach(r.value);
    } else {
      entry.reach = 'unknown';
      entry.reach_error = (r && r.error) || 'reach did not resolve';
    }
    if (includeUnused) {
      const u = unusedResults[i];
      if (u && u.ok && u.value && typeof u.value.unused_count === 'number') {
        entry.unused_grants = u.value.unused_count;
      } else if (u && u.ok && u.value && Array.isArray(u.value.unused)) {
        entry.unused_grants = u.value.unused.length;
      } else {
        entry.unused_grants = 'unknown';
      }
    }
    return entry;
  });

  // ---- Totals: sum only what resolved; say plainly whether that is all ----
  const resolvedReach = agents.filter((a) => a.reach !== 'unknown');
  const numeric = (vals) => vals.filter((v) => typeof v === 'number');
  const totals = {
    agents: agents.length,
    agents_by_source: agents.reduce((acc, a) => { acc[a.source] = (acc[a.source] || 0) + 1; return acc; }, {}),
    agents_reach_resolved: resolvedReach.length,
    agents_reach_unknown: agents.length - resolvedReach.length,
    tool_grants: numeric(resolvedReach.map((a) => a.reach.tools)).reduce((s, n) => s + n, 0),
    credential_grants: numeric(resolvedReach.map((a) => a.reach.credentials)).reduce((s, n) => s + n, 0),
    delegation_edges: numeric(resolvedReach.map((a) => a.reach.delegates)).reduce((s, n) => s + n, 0),
    complete: registryUnknowns.length === 0
      && agents.every((a) => a.reach !== 'unknown' && (a.reach.unknown_zones || []).length === 0),
  };

  return {
    v: 1,
    schema: 'inventory.v1',
    org_id: orgId,
    generated_at: nowIso(),
    duration_ms: Date.now() - startedAt,
    unused_window_days: includeUnused ? windowDays : undefined,
    totals,
    unknowns: registryUnknowns,
    agents,
  };
}

module.exports = {
  resolveOrgInventory,
  DEFAULT_UNUSED_WINDOW_DAYS,
};
