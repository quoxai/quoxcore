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
  { key: 'research', label: 'web research with citations', match: /^perplexity_/ },
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
/** Markdown lines "- <domain>: id (NAME), ..." The first agent holds the most of that domain's tools. */
function renderDelegationRoster(deps) {
  const d = deps || defaultDeps();
  const sig = deps ? null : `${Object.values(d.agentTools).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0)}:${d.listAssistants().length}`;
  if (sig && _cache && _cache.sig === sig) return _cache.text;
  const named = (id) => {
    const n = d.getAssistant(id)?.identity?.name;
    return n && n.toLowerCase() !== id ? `${id} (${n})` : id;
  };
  const text = buildDelegationRoster(d).map((r) => `- ${r.label}: ${r.agents.map(named).join(', ')}`).join('\n');
  if (sig) _cache = { sig, text };
  return text;
}

module.exports = { DOMAINS, buildDelegationRoster, renderDelegationRoster };
