'use strict';

/**
 * QUOXON handoff offer (owner, live 2026-10-17 19:51). Attached to TRIAGE-Q, the owner asked "which VMs use the most
 * CPU and memory". TRIAGE-Q honestly had no fleet or metrics tools and told him to detach and ask CommanderQ.
 *
 * suggestHandoff decides, from the turn's OWN tool selection (never the answer text), whether the attached agent lacks
 * the tools this ask needs. When it does, the turn carries handoff_suggested and the TUI offers to hand this one
 * question to CommanderQ (y/N). Nothing here runs anything; it is a suggestion the human answers.
 *
 * Never offered: CommanderQ itself, any agent that can delegate (it routes on its own), a custom agent with no
 * registry grant, an ask with no gap, or a gap in a tool family the agent already holds (TRIAGE-Q is never told to
 * hand a mail question away because inbox_search ranks higher than its inbox_pending).
 */

const HANDOFF_TARGET = 'quox';

// QUOXON 2026-10-17 21:58: the refusal an attached agent sees when a tool is outside its role. Without it, TRIAGE-Q read
// "Delegate to: atlas, metrics", could not delegate, and asked the owner to pick an agent beside the handoff card.
const HANDOFF_REFUSAL_NOTE = "The user will be offered a one-key handoff to CommanderQ after your answer. Say plainly what you could not do; don't ask them to detach, switch, or pick an agent.";
// QUOXON 2026-10-17 22:42: TRIAGE-Q then offered "Run /vm list?" as a workaround and that card took the handoff's place.
const HANDOFF_NO_COMMAND_NOTE = "Don't suggest a terminal or slash command as a workaround either; the handoff answers the question.";

// Role-scope refusals recorded during a turn (conversation -> {orgId, agent, tools, at}); the turn's end takes them.
const _refused = new Map();
const REFUSED_TTL_MS = 30 * 60 * 1000;

function canHandOff(agentId) {
  const id = String(agentId || '').toLowerCase().trim();
  if (!id || id === HANDOFF_TARGET || id === 'commanderq') return false;
  try {
    const held = (require('./agentTools.js').AGENT_TOOLS || {})[id];
    return Array.isArray(held) && !held.includes('delegate_to_agent');
  } catch { return false; }
}

function targetReaches(tool) {
  try {
    const t = (require('./agentTools.js').AGENT_TOOLS || {})[HANDOFF_TARGET] || [];
    return t.includes(tool) || t.includes('delegate_to_agent');
  } catch { return false; }
}

/**
 * Called from the not_granted refusal. When the refused agent is THIS conversation's own attached agent (its recorded
 * turn names it), cannot delegate, and CommanderQ can reach the tool: record the refusal (the turn's end turns it into
 * handoff_suggested, so the card is certain) and return the note for the refusal text. Else null (refusal unchanged).
 */
function noteScopeRefusal(ctx, toolName) {
  const agent = String((ctx && ctx.agentId) || '').toLowerCase();
  const conv = ctx && (ctx.session_id || ctx.conversationId);
  const orgId = ctx && ctx.orgId;
  if (!conv || !orgId || !toolName || !canHandOff(agent) || !targetReaches(toolName)) return null;
  let turn = null;
  try { turn = require('./approvalTurnContext.js').getTurn(conv, orgId); } catch { turn = null; }
  if (!turn || turn.agentId !== agent) return null; // a delegated hop inside someone else's turn: unchanged
  const now = Date.now();
  for (const [k, v] of _refused) if (now - v.at > REFUSED_TTL_MS) _refused.delete(k);
  const key = String(conv);
  const e = _refused.get(key);
  if (e && e.orgId === String(orgId) && e.agent === agent) { if (!e.tools.includes(toolName)) e.tools.push(toolName); e.at = now; }
  else _refused.set(key, { orgId: String(orgId), agent, tools: [toolName], at: now });
  return `${HANDOFF_REFUSAL_NOTE} ${HANDOFF_NO_COMMAND_NOTE}`;
}

/** The role-scope refusals recorded for this conversation, org and agent (taken once). */
function takeScopeRefusal(conv, orgId, agent) {
  const key = String(conv || '');
  const e = _refused.get(key);
  if (!e || e.orgId !== String(orgId || '') || e.agent !== String(agent || '').toLowerCase()) return [];
  _refused.delete(key);
  return Date.now() - e.at > REFUSED_TTL_MS ? [] : e.tools.slice();
}

// Plain words for what the agent cannot do, by tool family. Unknown families fall back to the tool name in words.
const FAMILY_WORDS = {
  proxmox: 'read VM stats', fleet: 'read fleet health', docker: 'read Docker', metrics: 'read metrics',
  system: 'read host stats', network: 'read the network', netwatch: 'read the network', security: 'read security findings',
  backup: 'read backups', pbs: 'read backups', quoxplan: 'read the roadmap', plan: 'read the roadmap', ward: 'read the evidence chain',
  wazuh: 'read security alerts', seo: 'read SEO data', quoxseo: 'read SEO data', calendar: 'read the calendar',
  contacts: 'read contacts', voice: 'read calls', browser: 'read web pages', web: 'read web pages', github: 'read GitHub',
  routeros: 'read the router', mikrotik: 'read the router', vault: 'read the vault', alerts: 'read alerts', ssh: 'run host commands',
};

const family = (tool) => String(tool || '').split('_')[0].toLowerCase();

function displayName(id) {
  try {
    const loader = require('./entityAssistantLoader');
    if (typeof loader.listAssistants === 'function' && !loader.listAssistants().length && typeof loader.loadAssistants === 'function') loader.loadAssistants();
    const a = loader.getAssistant(id);
    return (a && a.identity && a.identity.name) || String(id).toUpperCase();
  } catch { return String(id).toUpperCase(); }
}

// QUOXON first-text (2026-10-19): an ask that names a fleet host ("whats wrong with hostnode01?") ranks no tool by
// name, so TRIAGE-Q reached for fleet_status anyway and paid a refused call plus a second model hop (~10 s). A named
// host is a fleet read: the gap when the agent holds no host-reading family. Whole words only.
const HOST_READ_FAMILIES = new Set(['fleet', 'docker', 'system', 'ssh', 'metrics', 'proxmox', 'host', 'pve', 'vm']);
const HOST_GAP_TOOL = 'fleet_status';
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namesHost(message, hosts) {
  const text = String(message || '').toLowerCase();
  if (!text || !Array.isArray(hosts)) return false;
  return hosts.some((h) => typeof h === 'string' && h.length >= 3
    && new RegExp(`(^|[^a-z0-9_-])${escapeRe(h.toLowerCase())}($|[^a-z0-9_-])`).test(text));
}

/** -> null | { agent, name, from, from_name, reason, tools } */
function suggestHandoff({ agent = '', message = '', orgId = 'guard', refused = [], hosts = null } = {}) {
  const id = String(agent || '').toLowerCase().trim();
  const refusedTools = (Array.isArray(refused) ? refused : []).filter((t) => typeof t === 'string' && t);
  if (!id || id === HANDOFF_TARGET || id === 'commanderq' || (!String(message || '').trim() && !refusedTools.length)) return null;
  let at;
  try { at = require('./agentTools.js'); } catch { return null; }
  const held = (at.AGENT_TOOLS || {})[id];
  if (!Array.isArray(held) || held.includes('delegate_to_agent')) return null;
  let gaps = [];
  try {
    const pool = at.getToolsForAgent(id, { orgId });
    gaps = require('./turnToolSelection.js').selectTurnTools({ pool, message: String(message), agent: id, withUnheld: true }).unheldHints || [];
  } catch { gaps = []; }
  const heldFamilies = new Set(held.map(family));
  const target = (at.AGENT_TOOLS || {})[HANDOFF_TARGET] || [];
  const reach = (tool) => target.includes(tool) || target.includes('delegate_to_agent');
  gaps = gaps.filter((g) => g && g.tool && !heldFamilies.has(family(g.tool)) && reach(g.tool));
  if (!gaps.length && namesHost(message, hosts) && ![...heldFamilies].some((f) => HOST_READ_FAMILIES.has(f)) && reach(HOST_GAP_TOOL)) {
    gaps = [{ tool: HOST_GAP_TOOL }];
  }
  // a real refusal during the turn is the strongest signal: it comes first and is never filtered by family
  const refusedGaps = refusedTools.filter((t) => !held.includes(t) && reach(t) && !gaps.some((g) => g.tool === t)).map((tool) => ({ tool }));
  gaps = [...refusedGaps, ...gaps];
  if (!gaps.length) return null;
  const fromName = displayName(id);
  const words = FAMILY_WORDS[family(gaps[0].tool)] || `run ${String(gaps[0].tool).replace(/_/g, ' ')}`;
  return {
    agent: HANDOFF_TARGET,
    name: displayName(HANDOFF_TARGET),
    from: id,
    from_name: fromName,
    reason: `${fromName} can't ${words}.`,
    tools: [...new Set(gaps.map((g) => g.tool))].slice(0, 4),
  };
}

/**
 * QUOXON first-text (2026-10-19): the gap suggestHandoff predicts BEFORE dispatch is recorded exactly as a refusal
 * would be, so the end-of-turn card stays certain when the model, told up front, never makes the refused call.
 */
function notePredictedGap(conv, orgId, agent, tools) {
  const id = String(agent || '').toLowerCase();
  const list = (Array.isArray(tools) ? tools : []).filter((t) => typeof t === 'string' && t);
  if (!conv || !orgId || !list.length || !canHandOff(id)) return false;
  const key = String(conv);
  const now = Date.now();
  const e = _refused.get(key);
  if (e && e.orgId === String(orgId) && e.agent === id) { for (const t of list) if (!e.tools.includes(t)) e.tools.push(t); e.at = now; }
  else _refused.set(key, { orgId: String(orgId), agent: id, tools: list.slice(), at: now });
  return true;
}

/** The prompt note for a predicted gap: skip the tools (they would be refused) and answer in one hop. '' when none. */
function gapPromptNote(suggestion) {
  if (!suggestion || !Array.isArray(suggestion.tools) || !suggestion.tools.length) return '';
  return `\n\n## Outside your role this turn\nThis ask needs ${suggestion.tools.join(', ')}, which your role does not hold. Do not call them: they will be refused. ${HANDOFF_REFUSAL_NOTE} ${HANDOFF_NO_COMMAND_NOTE}`;
}

module.exports = { suggestHandoff, noteScopeRefusal, takeScopeRefusal, notePredictedGap, gapPromptNote, HANDOFF_REFUSAL_NOTE, HANDOFF_NO_COMMAND_NOTE, FAMILY_WORDS };
