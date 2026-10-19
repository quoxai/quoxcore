'use strict';
/**
 * Z2H-7B3 (gripe quox#1220): an answer built ONLY from a real, server-run tool result.
 *
 * Two uses, both without a model in the loop:
 *   1. directAnswer: a pure live-data lookup on a LOCAL provider is answered from the tool result
 *      with no model call (per-intent rule DIRECT_ANSWER_INTENTS, id `fleet-roster-lookup`).
 *   2. fallbackAnswer: live data was pre-read, then the model failed or ran out its budget. The user
 *      still gets the real result, summarised deterministically, labelled honestly.
 * No model text is ever mixed in. The renderer reads fields of the tool result and nothing else.
 *
 * Why direct answers are gated on LOCAL providers (ollama, lmstudio) and not on licence or plan:
 * the cost being avoided is the model's wall-clock, and only a local CPU model has one that
 * blows a turn (qwen2.5:7b on 4 vCPU: 16.5 tok/s prompt read, so the governed prompt alone took
 * over 150 s, 6 of 6 fleet asks produced no answer). On openai, anthropic and the hosted compat
 * presets a lookup costs seconds, and the model adds value (it can interpret, compare, explain),
 * so those keep the model. QUOX_DIRECT_ANSWER=local (default) | always | off overrides the gate.
 */

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

function directAnswerMode(env = process.env) {
  const v = String((env && env.QUOX_DIRECT_ANSWER) || 'local').trim().toLowerCase();
  return v === 'always' || v === 'off' ? v : 'local';
}
const isLocalProvider = (provider) => LOCAL_PROVIDERS.has(String(provider || '').toLowerCase());

const { COUNT_RE, unwrapQueued, singleHostFrom, matchHosts } = require('./fleetAsk.js');
const NOUNS = '(?:hosts?|servers?|machines?|boxes|nodes?|fleet)';
// An ALLOWLIST grammar for the WHOLE message (WORKER2 review): [please] LEAD [determiners] NOUN [are|is] [state] [and their status].
// Anything that does not fit end to end goes to the model: a denylist of "more than a lookup" words can never be complete
// ("which servers are not backed up", "which nodes are running nginx", "is web01 down" are not a roster).
const ROSTER_RE = new RegExp(
  '^\\s*(?:(?:please|pls|hey|hi|quox)[,\\s]+)*'
  + "(?:which|what(?:'s|\\s+is|\\s+are)?|list|show|give|tell|display|how\\s+many|are|is)"
  + '(?:\\s+(?:me|the|my|our|all|of|any|every|current|status|state|health))*'
  + `\\s+${NOUNS}`
  + '(?:\\s+(?:are|is|do\\s+i\\s+have))?'
  + '(?:\\s+(?:online|offline|up|down|alive|reachable|connected|healthy|status))?'
  + '(?:\\s+and\\s+their\\s+status)?'
  + '\\s*[?.!]*\\s*$', 'i');

// Z2H-7B4: "is web01 down?" -> only that host. NOT a direct-answer intent (the existing WORKER2 rule keeps single-host asks with the
// model); the prefetch narrows what the model is shown, and the timeout fallback shows only that host.
function renderHost(result, registry, host) {
  if (!result || typeof result !== 'object') return 'fleet_status returned nothing usable.';
  if (result.success === false || result.error) return `fleet_status failed: ${String(result.error || 'unknown error').slice(0, 300)}. I cannot say anything about ${host}.`;
  const hosts = Array.isArray(result.hosts) ? result.hosts : [];
  const rows = matchHosts(hosts, host);
  if (rows.length) {
    const line = (row) => { const s = hostState(row); return `${row.host || row.name || host}: ${s.word}${s.note ? ` (${s.note})` : ''}`; };
    if (rows.length === 1) return `${line(rows[0])}.`;
    // several hosts share the name: keep every one, never pick silently
    return `${rows.length} hosts named ${host}.*:\n${rows.map((r) => `- ${line(r)}`).join('\n')}`;
  }
  const regOk = registry && registry.success !== false && Array.isArray(registry.hosts);
  const regs = regOk ? matchHosts(registry.hosts, host) : [];
  if (regs.length > 1) return `${regs.length} hosts named ${host}.* are registered but not reporting (agent not running or not installed): ${regs.map((r) => r.id || r.host || r.name).join(', ')}.`;
  if (regs.length) return `${host} is registered but not reporting (agent not running or not installed), so its state is unknown.`;
  if (registry && !regOk) return `${host} is not reporting, and the Bastion registry could not be read (${String(registry.error || 'unknown error').slice(0, 200)}), so I cannot say whether it is registered.`;
  return `${host} is not a known host: it is not in the Bastion registry and not reporting.`;
}

const DIRECT_ANSWER_INTENTS = [
  {
    id: 'fleet-roster-lookup', need: 'fleet', tool: 'fleet_status',
    // Z2H-7B4: tested on the user's own words (a queued follow-up arrives wrapped), plus the how-many/count forms.
    test: (m) => { const t = unwrapQueued(m).trim(); return ROSTER_RE.test(t) || COUNT_RE.test(t); },
    render: renderFleet,
  },
];

const MAX_LISTED = 25;

function hostState(h) {
  const conn = String(h && h.connection || 'unknown').toLowerCase();
  const health = String(h && h.health || 'unknown').toLowerCase();
  const seen = h && h.last_seen && !/^(?:undefined|NaN)/.test(String(h.last_seen)) ? String(h.last_seen) : null;
  if (conn === 'dead') return { rank: 0, word: 'offline', note: seen ? `last seen ${seen}` : null };
  if (conn === 'stale') return { rank: 1, word: 'stale', note: seen ? `last seen ${seen}` : null };
  if (conn === 'connected') {
    if (health === 'healthy' || health === 'unknown') return { rank: 3, word: 'online', note: null };
    return { rank: 2, word: 'online', note: `health ${health}` };
  }
  return { rank: 1, word: 'unknown', note: null };
}

function sameHost(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

/**
 * `registry` (optional) is the Bastion registry read: every registered host, reporting or not. fleet_status counts
 * REPORTING agents only, so "0 hosts" must never stand while hosts are registered (quox#1243).
 */
function renderFleet(result, registry) {
  if (!result || typeof result !== 'object') return 'fleet_status returned nothing usable.';
  if (result.success === false || result.error) return `fleet_status failed: ${String(result.error || 'unknown error').slice(0, 300)}. No host list is available.`;
  // SDK-TEAM: fleet_status now returns the Bastion registry as the inventory; the total and state counts are the registry's.
  if (Number.isFinite(result.registry_total) && result.by_state && Array.isArray(result.hosts)) {
    const bs = result.by_state;
    const order = ['active', ...Object.keys(bs).filter((k) => k !== 'active').sort()];
    const parts = order.filter((k) => bs[k]).map((k) => `${bs[k]} ${k}`);
    const rep = Number.isFinite(result.reporting_agents) ? `${result.reporting_agents} reporting an agent` : 'agent reporting unknown';
    const down = Array.isArray(result.not_active) ? result.not_active : [];
    const names = down.slice(0, MAX_LISTED).map((h) => `- ${h.id}: ${h.state}${h.health && h.health !== 'unknown' ? ` (health ${h.health})` : ''}`);
    const more = down.length > MAX_LISTED ? [`- and ${down.length - MAX_LISTED} more not active`] : [];
    // FLEET-UNHEALTHY: active hosts whose reporting agent (or registry health) says degraded/unhealthy are not healthy too.
    const sick = (Array.isArray(result.not_healthy) ? result.not_healthy : []).filter((h) => h && !down.some((d) => d.id === h.host));
    const sickLines = sick.length ? [`Not healthy while still reachable (${sick.length}):`, ...sick.slice(0, MAX_LISTED).map((h) => `- ${h.host}: ${h.status} (${h.source})`)] : [];
    return [`${result.registry_total} host${result.registry_total === 1 ? '' : 's'} registered: ${parts.join(', ')}; ${rep}.`, ...names, ...more, ...sickLines].join('\n');
  }
  const hosts = Array.isArray(result.hosts) ? result.hosts : null;
  if (!hosts) {
    const total = Number.isFinite(result.total_agents) ? result.total_agents : null;
    return total === null ? 'fleet_status returned no host list.' : `${total} host${total === 1 ? '' : 's'} reported, with no per-host detail.`;
  }
  const regOk = registry && registry.success !== false && Array.isArray(registry.hosts);
  const regFailed = registry && !regOk;
  const reportingNames = hosts.map((h) => String(h.host || h.name || h.host_id || 'unnamed'));
  const silent = regOk ? registry.hosts.map((h) => String(h && (h.id || h.host || h.name) || 'unnamed')).filter((n) => !reportingNames.some((r) => sameHost(r, n))) : [];
  const silentWhy = '(agent not running or not installed)';
  if (!hosts.length) {
    if (regOk && silent.length) {
      const shown = silent.slice(0, MAX_LISTED).join(', ') + (silent.length > MAX_LISTED ? `, and ${silent.length - MAX_LISTED} more` : '');
      return `${silent.length} host${silent.length === 1 ? '' : 's'} registered, 0 reporting ${silentWhy}: ${shown}.`;
    }
    if (regOk) return '0 hosts reported by fleet_status, and the Bastion registry lists none.';
    if (regFailed) return `0 hosts reported by fleet_status. The Bastion registry could not be read (${String(registry.error || 'unknown error').slice(0, 200)}), so this does not show that no hosts are registered.`;
    return '0 hosts reported by fleet_status.';
  }
  const rows = hosts.map((h) => ({ name: String(h.host || h.name || h.host_id || 'unnamed'), s: hostState(h) }))
    .sort((a, b) => a.s.rank - b.s.rank || a.name.localeCompare(b.name));
  const count = (w) => rows.filter((r) => r.s.word === w).length;
  const parts = [`${count('online')} online`];
  if (count('stale')) parts.push(`${count('stale')} stale`);
  if (count('offline')) parts.push(`${count('offline')} offline`);
  if (count('unknown')) parts.push(`${count('unknown')} unknown`);
  const head = silent.length
    ? `${rows.length + silent.length} hosts registered, ${rows.length} reporting: ${parts.join(', ')}. ${silent.length} not reporting ${silentWhy}: ${silent.slice(0, MAX_LISTED).join(', ')}${silent.length > MAX_LISTED ? `, and ${silent.length - MAX_LISTED} more` : ''}.`
    : `${rows.length} host${rows.length === 1 ? '' : 's'}: ${parts.join(', ')}.`;
  const shown = rows.slice(0, MAX_LISTED).map((r) => `- ${r.name}: ${r.s.word}${r.s.note ? ` (${r.s.note})` : ''}`);
  const more = rows.length > MAX_LISTED ? [`- and ${rows.length - MAX_LISTED} more online (problems are listed first)`] : [];
  return [head, ...shown, ...more].join('\n');
}

function renderGeneric(tool, result) {
  let body;
  try { body = typeof result === 'string' ? result : JSON.stringify(result); } catch { body = String(result); }
  return `${tool} returned: ${String(body).slice(0, 800)}`;
}

/** A single-host ask renders only that host, even if the item was not narrowed upstream. */
function withFocus(items, message) {
  const host = singleHostFrom(message);
  return host ? items.map((it) => (it.tool === 'fleet_status' && !it.focus ? { ...it, focus: host } : it)) : items;
}

function renderItem(item) {
  // an item narrowed to one host (item.focus) renders as that host only (never the roster)
  if (item.focus && item.tool === 'fleet_status') return renderHost(item.result, item.registry, item.focus);
  const intent = DIRECT_ANSWER_INTENTS.find((i) => i.tool === item.tool);
  return intent ? intent.render(item.result, item.registry) : renderGeneric(item.tool, item.result);
}

/**
 * Pure lookup on a local provider -> { intent, text, toolsUsed }, else null.
 * `prefetch` is the liveDataPrefetch result (items already run, through the governed door).
 */
function directAnswer({ message, prefetch, provider, env = process.env } = {}) {
  if (!prefetch || !Array.isArray(prefetch.items) || !prefetch.items.length) return null;
  const mode = directAnswerMode(env);
  if (mode === 'off') return null;
  if (mode === 'local' && !isLocalProvider(provider)) return null;
  const intent = DIRECT_ANSWER_INTENTS.find((i) => i.test(message) && prefetch.items.some((it) => it.tool === i.tool));
  if (!intent) return null;
  const items = prefetch.items.filter((it) => it.tool === intent.tool);
  const text = `${items.map(renderItem).join('\n')}\n\nAnswered from ${intent.tool} directly, with no model call (a plain lookup on a local model).`;
  return { intent: intent.id, text, toolsUsed: items.map((i) => i.tool) };
}

/**
 * The model failed or timed out after a pre-read.
 * - `message` omitted: the legacy shape, every item rendered as the answer.
 * - the question IS a roster lookup (the allowlist grammar): the real result, summarised, labelled.
 * - anything else ("which servers are not backed up?"): the honest timeout message, plus at most a clearly labelled
 *   raw-data line that does NOT answer the question. The canned roster is never passed off as the answer.
 */
function fallbackAnswer({ prefetch, reason, message } = {}) {
  if (!prefetch || !Array.isArray(prefetch.items) || !prefetch.items.length) return null;
  const items = message === undefined ? prefetch.items : withFocus(prefetch.items, message);
  prefetch = { ...prefetch, items };
  const tools = [...new Set(prefetch.items.map((i) => i.tool))].join(', ');
  const toolsUsed = prefetch.items.map((i) => i.tool);
  const why = reason || 'the model did not finish';
  if (message === undefined) {
    return { text: `${prefetch.items.map(renderItem).join('\n')}\n\nAnswered from ${tools} directly; ${why}.`, toolsUsed, answered: true, why };
  }
  const isLookup = (item) => DIRECT_ANSWER_INTENTS.some((x) => x.tool === item.tool && x.test(message));
  if (prefetch.items.every(isLookup)) {
    return { text: `${prefetch.items.map(renderItem).join('\n')}\n\nAnswered from ${tools} directly; ${why}.`, toolsUsed, answered: true, why };
  }
  const raw = prefetch.items.map((item) => {
    const full = renderItem(item);
    const first = item.focus ? full.replace(/\n- /g, ' ').replace(/\n/g, ' ') : full.split('\n')[0];
    return /^\S+ (?:returned|failed)\b/.test(first) && item.tool !== 'fleet_status' ? first.slice(0, 300) : `${item.tool} returned: ${first.replace(/^fleet_status (?:returned|failed): /, '')}`;
  });
  const text = `This question was not answered: ${why}.\n\nFor reference only, raw data that does NOT answer your question: ${raw.join(' ')}`;
  return { text, toolsUsed, answered: false, why };
}

module.exports = { renderHost, DIRECT_ANSWER_INTENTS, LOCAL_PROVIDERS, directAnswerMode, isLocalProvider, directAnswer, fallbackAnswer, renderFleet };
