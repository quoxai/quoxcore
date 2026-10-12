'use strict';

/**
 * reachResolver.js — BLAST-RADIUS-P0
 *
 * Computes an agent's static reachability closure ("blast radius") from
 * registries the collector and auth service already own: tool grants,
 * vault credential assignments, bastion fleet hosts (gated on whether the
 * agent actually holds a fleet-exec tool), the per-org QLarity egress
 * allowlist, and the agent delegation graph (canDelegateTo).
 *
 * Factory style, same DI shape as qlarityAllowlistStore.js:
 * createReachResolver({ fetchImpl, env, getToolsWithConnectors,
 * qlarityAllowlist, nowIso }) — every external dependency is injectable so
 * tests never touch a real network, DB, or the system clock.
 *
 * HONESTY RULES (hard, see BLAST-RADIUS-P0 brief):
 *  - A source fetch failure is NEVER an empty array. Each source records
 *    { ok, count } independently and a failed source's `may.<source>` key is
 *    OMITTED (not emptied) from the result, with a matching entry in
 *    `unknown`. An empty array in `may` means "asked, got zero" — a missing
 *    key means "could not ask".
 *  - Never parse an error body as data: every fetch checks resp.ok before
 *    calling .json().
 *  - Credential entries carry { id, integration_type, name } only — never a
 *    secret value, token, or ciphertext.
 */

const RESOLVER_VERSION = '0.1.0';

// ============================================================================
// Fleet-exec tool detection
// ============================================================================
// Tool ids that let an agent execute against/on a fleet host via the bastion
// (drawn from AGENT_TOOLS in lib/agentTools.js — these are the tools whose
// executors call callBastion()/BASTION_URL). Hosts are only ever fetched
// when the agent holds at least one of these; an agent with none gets
// hosts:[] and a `cannot` entry, and bastion is never contacted.
const FLEET_EXEC_TOOL_IDS = new Set([
  'ssh_exec', 'remote_ssh', 'fleet_status', 'docker_status', 'docker_extended',
  'system_admin', 'network_check', 'proxmox_vms', 'proxmox_cluster_status',
  'proxmox_vm_action',
]);
// Naming-convention fallback so a future fleet-exec tool that follows this
// pattern is still caught without editing the allowlist above.
const FLEET_EXEC_TOOL_RE = /^fleet_|bastion|ssh_exec/i;

function isFleetExecTool(toolId) {
  if (!toolId || typeof toolId !== 'string') return false;
  return FLEET_EXEC_TOOL_IDS.has(toolId) || FLEET_EXEC_TOOL_RE.test(toolId);
}

// Tools whose destination is not statically knowable — the agent can reach
// any origin on the egress allowlist, not just the ones we can enumerate
// ahead of time. Heuristic, naming-convention based (browser_*, generic
// http/webhook probes); feeds the permanent 'generic-egress' unknown zone.
const GENERIC_EGRESS_TOOL_RE = /^browser_|^http_|fetch_url|webhook|probe_http/i;

function isGenericEgressTool(toolId) {
  if (!toolId || typeof toolId !== 'string') return false;
  return GENERIC_EGRESS_TOOL_RE.test(toolId);
}

function defaultNowIso() {
  return new Date().toISOString();
}

// ============================================================================
// Fetch helper — checks resp.ok before ever parsing a body as data.
// ============================================================================

async function fetchJsonSafe(fetchImpl, url, opts, timeoutMs = 5000) {
  try {
    const resp = await fetchImpl(url, {
      ...opts,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });
    if (!resp || !resp.ok) {
      const status = resp ? resp.status : undefined;
      return { ok: false, status, error: `HTTP ${status ?? 'no-response'}` };
    }
    const body = await resp.json();
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ============================================================================
// Per-source resolvers (each independently try/caught by its caller)
// ============================================================================

/** tools source — deps.getToolsWithConnectors(agentId, orgId) */
async function resolveTools({ getToolsWithConnectors, agentId, orgId }) {
  try {
    const tools = await getToolsWithConnectors(agentId, orgId);
    const list = Array.isArray(tools) ? tools : [];
    const items = list
      .map((t) => ({
        id: t && (t.name || t.id),
        // Most tool defs carry no risk annotation today (only one hardcoded
        // _aoclClassification.risk exists in agentTools.js); 'unknown' is
        // the honest default, not a placeholder for a missing feature.
        risk: (t && t._aoclClassification && t._aoclClassification.risk) || (t && t.risk) || 'unknown',
      }))
      .filter((t) => !!t.id);
    return { ok: true, count: items.length, items };
  } catch (err) {
    return { ok: false, count: 0, items: [], error: (err && err.message) || String(err) };
  }
}

/** credentials source — GET /internal/orgs/:orgId/agent-credential-assignments */
async function resolveCredentials({ fetchImpl, env, agentId, orgId }) {
  const authBase = env.AUTH_SERVICE_URL;
  if (!authBase) return { ok: false, count: 0, items: [], error: 'AUTH_SERVICE_URL not configured' };
  const url = `${authBase}/internal/orgs/${encodeURIComponent(orgId)}/agent-credential-assignments?agent_id=${encodeURIComponent(agentId)}`;
  const headers = env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': env.INTERNAL_SERVICE_KEY } : {};
  const result = await fetchJsonSafe(fetchImpl, url, { headers });
  if (!result.ok) return { ok: false, count: 0, items: [], error: result.error };
  const assignments = Array.isArray(result.body && result.body.assignments) ? result.body.assignments : [];
  const items = assignments.map((a) => ({
    id: a.credential_id || a.id,
    integration_type: a.integration_type || 'unknown',
    name: a.label || null,
  }));
  return { ok: true, count: items.length, items };
}

/**
 * hosts source — ONLY fetched when the agent's tool list contains a
 * fleet-exec-capable tool. Returns grantedFleetTool so the caller can tell
 * "no grant" (cannot band) apart from "grant, but bastion unreachable"
 * (unknown band).
 */
async function resolveHosts({ fetchImpl, env, toolIds }) {
  const grantedFleetTool = toolIds.some(isFleetExecTool);
  if (!grantedFleetTool) {
    return { ok: true, count: 0, items: [], grantedFleetTool: false };
  }
  const bastionUrl = env.BASTION_URL;
  if (!bastionUrl) {
    return { ok: false, count: 0, items: [], grantedFleetTool: true, error: 'BASTION_URL not configured' };
  }
  const url = `${bastionUrl}/api/v1/hosts`;
  const headers = env.BASTION_API_TOKEN ? { Authorization: `Bearer ${env.BASTION_API_TOKEN}` } : {};
  const result = await fetchJsonSafe(fetchImpl, url, { headers });
  if (!result.ok) return { ok: false, count: 0, items: [], grantedFleetTool: true, error: result.error };
  const hosts = Array.isArray(result.body) ? result.body : (Array.isArray(result.body && result.body.hosts) ? result.body.hosts : []);
  const items = hosts
    .map((h) => ({
      id: h && (h.id || h.host_id || h.hostname),
      group: (h && (h.group || h.group_name)) || null,
      tags: Array.isArray(h && h.tags) ? h.tags : [],
    }))
    .filter((h) => !!h.id);
  return { ok: true, count: items.length, items, grantedFleetTool: true };
}

/** egress source — per-org QLarity allowlist + install-wide env allowlist, merged/deduped */
function resolveEgress({ qlarityAllowlist, env, orgId }) {
  try {
    const orgOrigins = (qlarityAllowlist && typeof qlarityAllowlist.originsFor === 'function')
      ? (qlarityAllowlist.originsFor({ orgId }) || [])
      : [];
    const envOrigins = String(env.POWERS_EGRESS_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const items = Array.from(new Set([...orgOrigins, ...envOrigins]));
    return { ok: true, count: items.length, items };
  } catch (err) {
    return { ok: false, count: 0, items: [], error: (err && err.message) || String(err) };
  }
}

/**
 * delegation source — GET /internal/agents, then a cycle-safe BFS over
 * canDelegateTo (persisted into config_json.delegation by
 * services/auth/scripts/seed-core-agents.js — BLAST-RADIUS-P0 deliverable 1).
 * `direct` = the subject's own 1-hop grant; `closure` = every agent
 * transitively reachable from those (direct entries included).
 */
async function resolveDelegation({ fetchImpl, env, agentId }) {
  const authBase = env.AUTH_SERVICE_URL;
  if (!authBase) return { ok: false, direct: [], closure: [], agentsById: new Map(), error: 'AUTH_SERVICE_URL not configured' };
  const url = `${authBase}/internal/agents`;
  const headers = env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': env.INTERNAL_SERVICE_KEY } : {};
  const result = await fetchJsonSafe(fetchImpl, url, { headers });
  if (!result.ok) return { ok: false, direct: [], closure: [], agentsById: new Map(), error: result.error };

  const agents = Array.isArray(result.body && result.body.agents) ? result.body.agents : [];
  const byId = new Map();
  for (const a of agents) {
    if (a && a.agentId) byId.set(a.agentId, a);
  }

  const self = byId.get(agentId);
  const directIds = (self && self.delegation && Array.isArray(self.delegation.canDelegateTo))
    ? self.delegation.canDelegateTo
    : [];
  const direct = directIds.map((id) => ({ agentId: id, name: (byId.get(id) && byId.get(id).name) || id }));

  // Cycle-safe BFS: `visited` seeds with the subject itself so a delegation
  // cycle back to the subject (A -> B -> A) can never re-enqueue A.
  const visited = new Set([agentId]);
  const closure = [];
  const queue = [...directIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const rec = byId.get(id);
    closure.push({ agentId: id, name: (rec && rec.name) || id });
    const next = (rec && rec.delegation && Array.isArray(rec.delegation.canDelegateTo)) ? rec.delegation.canDelegateTo : [];
    for (const n of next) if (!visited.has(n)) queue.push(n);
  }

  return { ok: true, direct, closure, agentsById: byId };
}

// ============================================================================
// Badge derivation
// ============================================================================
// Deterministic ladder, R0 (lowest) .. R5 (highest). Every rule whose
// condition holds pushes its own explanation into `working`; the badge level
// is the HIGHEST level among the rules that fired (so R5 also carries the
// R3/R4 reasons that are also true). No rule firing => R0.
//
// Inputs are the KNOWN state only (failed sources contribute empty arrays
// here — their absence is separately visible in `unknown`), so the badge is
// a best-effort floor, never an inflated guess.
function deriveBadge({ credentials, hosts, egress, delegates }, closureHasFleetCapableAgent) {
  const classesPresent = [];
  if (credentials.length > 0) classesPresent.push('credentials');
  if (hosts.length > 0) classesPresent.push('hosts');
  if (egress.length > 0) classesPresent.push('egress');
  if (delegates.direct.length > 0) classesPresent.push('delegates');
  const totalCount = credentials.length + hosts.length + egress.length + delegates.direct.length;

  const fired = []; // [{ level, msg }]

  if (totalCount === 1) {
    fired.push({ level: 1, msg: 'exactly one resource granted across all classes' });
  }
  if (classesPresent.length === 1 && totalCount > 1) {
    fired.push({ level: 2, msg: `multiple resources, all confined to a single class (${classesPresent[0]})` });
  }
  if (classesPresent.length >= 2) {
    fired.push({ level: 3, msg: `resources span ${classesPresent.length} classes: ${classesPresent.join(', ')}` });
  }
  if (delegates.direct.length > 0) {
    fired.push({ level: 3, msg: 'agent can delegate to at least one other agent' });
  }
  if (hosts.length > 0 && credentials.length > 0) {
    fired.push({ level: 4, msg: 'holds both fleet-exec hosts and vault credentials' });
  }
  if (closureHasFleetCapableAgent === true) {
    fired.push({ level: 4, msg: 'delegation closure reaches an agent that itself holds a fleet-exec tool' });
  }
  if (credentials.length > 5) {
    fired.push({ level: 4, msg: `more than 5 credentials assigned (${credentials.length})` });
  }
  if (hosts.length > 0 && credentials.length > 0 && delegates.direct.length > 0) {
    fired.push({ level: 5, msg: 'hosts, credentials and delegation are all present simultaneously' });
  }

  if (fired.length === 0) {
    return { level: 'R0', working: ['no credentials, hosts, egress origins, or delegation capability granted'] };
  }

  const maxLevel = Math.max(...fired.map((f) => f.level));
  return { level: `R${maxLevel}`, working: fired.map((f) => f.msg) };
}

// ============================================================================
// Factory
// ============================================================================

function createReachResolver(deps = {}) {
  const env = deps.env || (typeof process !== 'undefined' ? process.env : {});
  const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined);
  const getToolsWithConnectors = deps.getToolsWithConnectors;
  const qlarityAllowlist = deps.qlarityAllowlist || null;
  const nowIso = deps.nowIso || defaultNowIso;

  if (typeof getToolsWithConnectors !== 'function') {
    throw new Error('createReachResolver: deps.getToolsWithConnectors is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createReachResolver: deps.fetchImpl is required (no global fetch available)');
  }

  async function resolveReach({ agentId, orgId }) {
    if (!agentId) throw new Error('resolveReach: agentId is required');
    if (!orgId) throw new Error('resolveReach: orgId is required');
    const startedAt = Date.now();

    const toolsResult = await resolveTools({ getToolsWithConnectors, agentId, orgId });
    const toolIds = toolsResult.items.map((t) => t.id);

    const [credentialsResult, hostsResult, delegationResult] = await Promise.all([
      resolveCredentials({ fetchImpl, env, agentId, orgId }),
      resolveHosts({ fetchImpl, env, toolIds }),
      resolveDelegation({ fetchImpl, env, agentId }),
    ]);
    const egressResult = resolveEgress({ qlarityAllowlist, env, orgId });

    // Badge rule R4b: "delegation closure contains an agent that itself has
    // fleet tools" — only evaluated when the closure resolved AND every
    // member's own tool list resolved cleanly. Any failure anywhere in this
    // computation leaves it `null` (uncomputable), which deriveBadge treats
    // as "skip the rule", never as "false".
    let closureHasFleetCapableAgent = null;
    if (delegationResult.ok && delegationResult.closure.length > 0) {
      try {
        closureHasFleetCapableAgent = false;
        for (const member of delegationResult.closure) {
          // eslint-disable-next-line no-await-in-loop
          const memberTools = await getToolsWithConnectors(member.agentId, orgId);
          const memberToolIds = Array.isArray(memberTools) ? memberTools.map((t) => t && t.name) : null;
          if (!Array.isArray(memberToolIds)) throw new Error(`tools for ${member.agentId} did not resolve to an array`);
          if (memberToolIds.some(isFleetExecTool)) {
            closureHasFleetCapableAgent = true;
            break;
          }
        }
      } catch (_err) {
        closureHasFleetCapableAgent = null;
      }
    }

    // ---- cannot band: deny-by-default facts, never asserted from a source
    // that itself failed to resolve. ----
    const cannot = [];
    if (!hostsResult.grantedFleetTool) {
      cannot.push({ boundary: 'fleet', statement: 'no fleet-exec tool granted: this agent cannot reach any host' });
    }
    if (credentialsResult.ok) {
      cannot.push({ boundary: 'vault', statement: `no credential access outside the ${credentialsResult.count} assignment(s) enumerated above` });
    } else {
      cannot.push({ boundary: 'vault', statement: 'no credential access beyond what vault explicitly assigns to this agent (current assignment count unknown: source fetch failed)' });
    }
    cannot.push({ boundary: 'egress', statement: 'origins outside the allowlist are refused by default-deny egress' });

    // ---- unknown band: permanent zones (conditional on the facts that
    // make them apply) plus one entry per source that failed to resolve. ----
    const unknown = [];
    if (hostsResult.items.length > 0) {
      unknown.push({ zone: 'inside-shell', statement: 'once inside a host shell, further lateral movement is not statically knowable from this registry' });
    }
    if (toolIds.some(isGenericEgressTool)) {
      unknown.push({ zone: 'generic-egress', statement: 'a generic browser/HTTP tool can reach any allowlisted origin; which one it hits at call time is not statically knowable' });
    }
    if (!toolsResult.ok) unknown.push({ zone: 'tools', statement: `tool source failed: ${toolsResult.error}` });
    if (!credentialsResult.ok) unknown.push({ zone: 'credentials', statement: `credential source failed: ${credentialsResult.error}` });
    if (!hostsResult.ok) unknown.push({ zone: 'hosts', statement: `host source failed: ${hostsResult.error}` });
    if (!egressResult.ok) unknown.push({ zone: 'egress', statement: `egress source failed: ${egressResult.error}` });
    if (!delegationResult.ok) unknown.push({ zone: 'delegation', statement: `delegation source failed: ${delegationResult.error}` });

    const badge = deriveBadge(
      {
        credentials: credentialsResult.ok ? credentialsResult.items : [],
        hosts: hostsResult.items,
        egress: egressResult.ok ? egressResult.items : [],
        delegates: {
          direct: delegationResult.ok ? delegationResult.direct : [],
          closure: delegationResult.ok ? delegationResult.closure : [],
        },
      },
      closureHasFleetCapableAgent,
    );

    return {
      v: 1,
      resolver_version: RESOLVER_VERSION,
      subject: { type: 'agent', id: agentId },
      org_id: orgId,
      computed_at: nowIso(),
      duration_ms: Date.now() - startedAt,
      sources: {
        tools: { ok: toolsResult.ok, count: toolsResult.count },
        credentials: { ok: credentialsResult.ok, count: credentialsResult.count },
        hosts: { ok: hostsResult.ok, count: hostsResult.count },
        egress: { ok: egressResult.ok, count: egressResult.count },
        delegation: { ok: delegationResult.ok, count: delegationResult.ok ? delegationResult.direct.length : 0 },
      },
      may: {
        tools: toolsResult.ok ? toolsResult.items : undefined,
        credentials: credentialsResult.ok ? credentialsResult.items : undefined,
        hosts: hostsResult.ok ? hostsResult.items : undefined,
        egress: egressResult.ok ? egressResult.items : undefined,
        delegates: delegationResult.ok
          ? { direct: delegationResult.direct, closure: delegationResult.closure }
          : undefined,
      },
      cannot,
      unknown,
      badge,
    };
  }

  return { resolveReach };
}

module.exports = {
  createReachResolver,
  // Pure helpers exported for direct unit testing.
  isFleetExecTool,
  isGenericEgressTool,
  deriveBadge,
  FLEET_EXEC_TOOL_IDS,
  RESOLVER_VERSION,
};
