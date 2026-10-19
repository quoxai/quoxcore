'use strict';
/**
 * DELEGATION (HYPERION study, 2026-10-15): who to delegate to, generated from the registry.
 *
 * The delegate guidance used to hardcode roles ("cipher (networking)", "DAEDALUS for Docker"), so
 * the model sent docker fleet asks to the wrong agent and never named NETWATCH for networking.
 * This is now the ONE source: a domain is a tool-name pattern, and the agents named for it are the
 * registered specialists that actually hold a matching tool (AGENT_TOOLS, after entity and plugin
 * grants load), ranked by how many of the domain's tools each holds. No agent id is written here.
 *
 * Guard: test/delegationRoster.test.js fails if a prompt string pairs an agent with a role by hand.
 */

// Tool-name patterns per domain. These describe TOOLS, never agents.
const DOMAINS = [
  { key: 'networking', label: 'networking (interfaces, routes, ping, DNS, ports, routers, VPN, mesh)', match: /^(network_|mikrotik_|routeros_|tailscale_)/ },
  { key: 'docker_fleet', label: 'Docker across all hosts (fleet containers, stacks, fleet logs and stats)', match: /^docker_fleet_/ },
  { key: 'host', label: 'one host: Docker images, logs and stats, services, processes, disk, memory, box health', match: /^(docker_(?!fleet_)|system_|box_health$)/ },
  { key: 'monitoring', label: 'monitoring (Prometheus metrics, alerts, Grafana dashboards)', match: /^(prometheus_|alerts_|grafana_)/ },
  { key: 'uptime', label: 'uptime, SLA reports, incidents and service dependencies', match: /^uptime_/ },
  { key: 'security', label: 'security (permission and user audits, failed logins, sessions, certificates)', match: /^security_(?!(create|get|list)_engagements?$|add_target$|verify_target$|check_policy$|list_findings$)/ },
  { key: 'security_testing', label: 'authorized security testing engagements (scope, targets, findings)', match: /^security_((create|get|list)_engagements?|add_target|verify_target|check_policy|list_findings)$/ },
  { key: 'wazuh', label: 'Wazuh (SIEM agents, alerts, vulnerabilities, manager status)', match: /^wazuh_/ },
  { key: 'proxmox', label: 'Proxmox (VMs, snapshots, VM diagnosis, the VM pool)', match: /^proxmox_/ },
  { key: 'browser', label: 'web pages (browser automation, extraction, Lighthouse audits, objectives)', match: /^browser_/ },
  { key: 'backup', label: 'backups, restores and updates', match: /^keeper_/ },
  { key: 'workflows', label: 'workflows (list, run, executions)', match: /(^|_)workflows?(_|$)|^list_executions$/ },
  { key: 'research', label: 'web research with citations', match: /^web_read$/ },
  { key: 'files', label: 'files and documents', match: /^(list_files|read_file|search_files)$/ },
];

const MAX_PER_DOMAIN = 4;
// A tool many specialists hold (network_check sits with seven) says nothing about who owns the
// domain; only tools held by at most this many specialists count toward an agent's claim.
const MAX_SPECIFIC_HOLDERS = 4;

function defaultDeps() {
  const at = require('./agentTools.js');
  const loader = require('./entityAssistantLoader');
  if (!loader.listAssistants().length) { try { loader.loadAssistants(); } catch { /* names optional */ } }
  return { agentTools: at.AGENT_TOOLS, listAssistants: loader.listAssistants, getAssistant: loader.getAssistant };
}

// A delegate target is a registered assistant that is not an orchestrator.
function isSpecialist(id, getAssistant) {
  const a = getAssistant(id);
  if (!a) return false;
  if (String(id).toLowerCase() === 'quox') return false;
  return a?.hierarchy?.role !== 'orchestrator';
}

/** -> [{ key, label, match, agents: [id...] }] for every domain at least one specialist holds. */
function buildDelegationRoster(deps = defaultDeps()) {
  const { agentTools, listAssistants, getAssistant } = deps;
  const ids = (listAssistants() || []).filter((id) => Array.isArray(agentTools[id]) && isSpecialist(id, getAssistant));
  const holders = new Map();
  for (const id of ids) for (const t of new Set(agentTools[id])) holders.set(t, (holders.get(t) || 0) + 1);
  const rows = [];
  for (const d of DOMAINS) {
    const count = (id, specificOnly) => new Set(agentTools[id].filter((t) => d.match.test(t) && (!specificOnly || holders.get(t) <= MAX_SPECIFIC_HOLDERS))).size;
    const anySpecific = ids.some((id) => count(id, true) > 0);
    const scored = ids
      .map((id) => ({ id, n: count(id, anySpecific) }))
      .filter((s) => s.n > 0)
      .sort((a, b) => (b.n - a.n) || a.id.localeCompare(b.id));
    if (scored.length) rows.push({ key: d.key, label: d.label, match: d.match, agents: scored.slice(0, MAX_PER_DOMAIN).map((s) => s.id) });
  }
  return rows;
}

let _cache = null;

// The two roster lines every orchestrator prompt carries when NO hat scopes its agents. Kept
// verbatim here so each prompt site renders them from one place (CUSTOM-HATS).
const UNSCOPED_OTHER_AGENT_LINES = [
  '- Anything else: any agent or custom agent by its id (agent_directory lists them).',
  '- Plugin specialists (only when the org has that plugin; if a delegation is refused as not enabled, tell the user plainly): inboxq = email and inbox, calendar-q = calendar and schedule, contactsq = people, contacts and reaching them, notesq = notes ("jot this down", "write that down", find, read or edit a note). Never claim you saved a note yourself: delegate to notesq and report what it returned.',
].join('\n');

/**
 * CUSTOM-HATS (owner 2026-10-17): the agents an ENFORCED hat puts in scope, from a turn's hat
 * manifest, or null when no hat scopes the roster (preview, no hat, or a hat with no specialists,
 * e.g. Default). This is PRESENTATION: the delegation gate (agentTools delegate_to_agent, P-D)
 * is what refuses an out-of-scope agent; this only stops the turn carrying their context.
 */
function hatAgentScope(hm) {
  if (!hm || hm.enforced !== true || hm.delegationScoped !== true) return null;
  let agents = Array.isArray(hm.scopedAgents) ? hm.scopedAgents : null;
  if (!agents && hm.authorizedAgents instanceof Set) agents = [...hm.authorizedAgents].filter((a) => a !== String(hm.orchestrator || 'quox').toLowerCase());
  if (!agents) return null;
  const list = [...new Set(agents.map((a) => String(a).toLowerCase()).filter(Boolean))];
  return { hatKey: String(hm.hatKey || ''), agents: list };
}

function normScope(scope) {
  if (!scope || !Array.isArray(scope.agents)) return null;
  return { hatKey: String(scope.hatKey || ''), agents: [...new Set(scope.agents.map((a) => String(a).toLowerCase()).filter(Boolean))] };
}

/**
 * Markdown lines "- <domain>: id (NAME), ..." The first agent holds the most of that domain's tools.
 * With { scope } (hatAgentScope), the roster names ONLY the hat's agents: a head line lists them
 * (custom org agents included, which the registry roster never names) and each domain row keeps
 * only in-scope holders; a row with none is dropped.
 */
function renderDelegationRoster(deps, { scope } = {}) {
  const d = deps || defaultDeps();
  const named = (id) => {
    const n = d.getAssistant(id)?.identity?.name;
    return n && n.toLowerCase() !== id ? `${id} (${n})` : id;
  };
  const sc = normScope(scope);
  if (sc) {
    const allowed = new Set(sc.agents);
    const rows = buildDelegationRoster(d)
      .map((r) => ({ ...r, agents: r.agents.filter((a) => allowed.has(a)) }))
      .filter((r) => r.agents.length);
    const head = `- Your active hat "${sc.hatKey}" puts ONLY these agents in scope right now: ${sc.agents.length ? sc.agents.map(named).join(', ') : 'none'}.`;
    return [head, ...rows.map((r) => `- ${r.label}: ${r.agents.map(named).join(', ')}`)].join('\n');
  }
  const sig = deps ? null : `${Object.values(d.agentTools).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0)}:${d.listAssistants().length}`;
  if (sig && _cache && _cache.sig === sig) return _cache.text;
  const text = buildDelegationRoster(d).map((r) => `- ${r.label}: ${r.agents.map(named).join(', ')}`).join('\n');
  if (sig) _cache = { sig, text };
  return text;
}

/** The lines after the roster: unscoped = any agent + plugin specialists; scoped = this hat only. */
function renderOtherAgentLines(scope) {
  const sc = normScope(scope);
  if (!sc) return UNSCOPED_OTHER_AGENT_LINES;
  return `- Delegate ONLY to the agents in the "${sc.hatKey}" hat. Every other agent in the org is outside this hat (a delegation to one is refused), so do not list or offer them. If the user needs one, say so plainly and offer to propose a hat switch (hat_propose_switch).`;
}

module.exports = { DOMAINS, buildDelegationRoster, renderDelegationRoster, renderOtherAgentLines, hatAgentScope, UNSCOPED_OTHER_AGENT_LINES };
