'use strict';

/**
 * SITE-CLI 2026-10-17 fleet/t1-network_interfaces (ev_mvclc17j_b87df8): the turn's hint said cipher holds
 * network_interfaces, but the hint is only text on delegate_to_agent and the model delegated to netwatch, whose
 * grant has network_check and fleet_status only. netwatch could not read the interfaces and proposed a hat switch.
 *
 * The guard: before a nested turn runs, the task is put through the same selection the turn uses. If that names
 * tools this task needs that the parent does not hold (delegationHints), or the call names an expect_tool, and the
 * target holds NONE of them while another agent does, the delegation is refused naming the holder. A target that
 * holds any of the hinted tools is allowed, and so is a manager that delegates onward (it routes, it does not run).
 */

function holdsAny(agentId, tools) {
  let list = [];
  try { list = require('./agentTools.js').AGENT_TOOLS[agentId] || []; } catch { list = []; }
  return tools.some((t) => list.includes(t));
}

function delegatesOnward(agentId) {
  // an agent that holds delegate_to_agent (the orchestrator, the chiefs) routes; it is never the wrong holder
  if (holdsAny(agentId, ['delegate_to_agent'])) return true;
  try {
    const h = require('./entityAssistantLoader').getAssistant(agentId)?.hierarchy;
    return !!(h && (h.role === 'orchestrator' || (Array.isArray(h.canDelegateTo) && h.canDelegateTo.length)));
  } catch { return false; }
}

/**
 * SITE-CLI 2026-10-17 (ev_mvcr6xbm_ed32fa): "Ask the Proxmox agent HYPERION: ..." was refused twice for atlas because a
 * ranker hint on the brief named a weaver tool. The user's own words win: a target they named (registry id or display
 * name, whole word) is never refused or rerouted here. This only skips a ROUTING judgement; the hat gate and the grant
 * still decide what the target may do.
 */
function userNamedTarget(targetId, userText) {
  const text = String(userText || '');
  const id = String(targetId || '').toLowerCase();
  if (!text || !id) return false;
  const names = new Set([id]);
  try {
    const loader = require('./entityAssistantLoader');
    if (typeof loader.listAssistants === 'function' && !loader.listAssistants().length && typeof loader.loadAssistants === 'function') loader.loadAssistants();
    const a = loader.getAssistant(id);
    for (const n of [a?.identity?.name, a?.identity?.shortName, a?.name]) if (n) names.add(String(n).toLowerCase());
  } catch { /* the id alone */ }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...names].some((n) => n.length >= 3 && new RegExp(`(^|[^a-z0-9_-])${esc(n)}($|[^a-z0-9_-])`, 'i').test(text));
}

const GENERIC_TOOL_WORDS = new Set(['list', 'get', 'read', 'status', 'check', 'show', 'run', 'info', 'query', 'search', 'all', 'by', 'for', 'the', 'of', 'to', 'tool', 'tools']);
const stem = (w) => String(w || '').toLowerCase().replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '');
/** true when at least two thirds of the tool name's distinctive words appear in the task (singular/plural alike):
 *  network_interfaces 2/2 and docker_fleet_system_df 3/4 count; ssh_exec 0/2 and wb_list_node_types 0/3 do not. */
function taskNamesTool(task, toolName) {
  const words = new Set(String(task || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
  const parts = String(toolName || '').toLowerCase().split('_').filter((w) => w && !GENERIC_TOOL_WORDS.has(w));
  if (!parts.length) return false;
  const hit = parts.filter((w) => words.has(stem(w))).length;
  return hit / parts.length >= 2 / 3;
}

/** -> null (allowed) or { success:false, error, error_code:'wrong_holder', holders } */
function delegationHolderRefusal({ task = '', targetId = '', parentId = 'quox', expectTool = '', orgId = 'guard', userText = '' } = {}) {
  const target = String(targetId || '').toLowerCase();
  const parent = String(parentId || 'quox').toLowerCase();
  if (userNamedTarget(target, userText)) return null;
  const at = require('./agentTools.js');
  // a custom agent (delegated to by id) has no grant in this registry: never judged here
  if (!target || !Array.isArray((at.AGENT_TOOLS || {})[target]) || delegatesOnward(target)) return null;
  let hints = [];
  try {
    const pool = at.getToolsForAgent(parent, { orgId });
    hints = require('./turnToolSelection.js').selectTurnTools({ pool, message: String(task || ''), agent: parent }).delegationHints || [];
  } catch { hints = []; }
  const exp = String(expectTool || '').trim();
  if (exp && !hints.some((h) => h.tool === exp)) {
    const holders = (at.holdersOfTool(exp, parent) || []);
    if (holders.length) hints = [{ tool: exp, holders }, ...hints];
  }
  // Re-runs on 9b6b80877: hints are noisy (wb_list_node_types for a datastore ask, ssh_exec for an interfaces ask).
  // The guard acts only on a hinted tool the task itself names; an expect_tool the model named always counts.
  hints = hints.filter((h) => Array.isArray(h.holders) && h.holders.length && (h.tool === exp || taskNamesTool(task, h.tool)));
  if (!hints.length) return null;
  const tools = hints.map((h) => h.tool);
  if (holdsAny(target, tools)) return null;
  const holders = [...new Set(hints.flatMap((h) => h.holders))];
  const named = at.describeHolders(hints[0].holders).replace(/^Delegate to:\s*/, '').replace(/\.$/, '');
  return {
    success: false,
    error_code: 'wrong_holder',
    holders,
    error: `Not delegated: ${target} holds none of the tools this task needs (${tools.join(', ')}), so nothing ran. `
      + `Delegate to ${named} instead, and in the task tell it to run ${tools[0]}.`,
  };
}

/**
 * ev_mvcqu7lw_c1c6e5 (re-run on 3e98af305): the refusal worked but showed as a failed delegate_to_agent and relied on
 * the model obeying it. When the target holds none of the hinted tools and exactly ONE registry agent holds every one
 * of them, the delegation goes to that agent, visibly. -> { from, to, reason } | null
 */
function delegationReroute({ task = '', targetId = '', parentId = 'quox', expectTool = '', orgId = 'guard', userText = '' } = {}) {
  const refusal = delegationHolderRefusal({ task, targetId, parentId, expectTool, orgId, userText });
  if (!refusal) return null;
  const at = require('./agentTools.js');
  const tools = (String(refusal.error).match(/needs \(([^)]*)\)/) || [])[1];
  const needed = tools ? tools.split(',').map((t) => t.trim()).filter(Boolean) : [];
  if (!needed.length) return null;
  const all = refusal.holders.filter((id) => Array.isArray((at.AGENT_TOOLS || {})[id]) && needed.every((t) => at.AGENT_TOOLS[id].includes(t)));
  if (all.length !== 1) return null;
  const from = String(targetId || '').toLowerCase();
  return { from, to: all[0], reason: `${from} holds none of ${needed.join(', ')}; ${all[0]} holds all of them` };
}

/** The human's own words for this turn (approvalTurnContext, keyed like noteDelegation). '' when unknown. */
function turnUserText(ctx) {
  try {
    const t = require('./approvalTurnContext.js').getTurn((ctx && (ctx.session_id || ctx.conversationId)) || null, ctx && ctx.orgId);
    return (t && t.text) || '';
  } catch { return ''; }
}

/** Wraps the delegate executor: resolve a display name, reroute to the one holder if needed, mark the result. */
async function withHolderReroute(input, ctx, inner) {
  let rr = null;
  try {
    const at = require('./agentTools.js');
    const canon = typeof at.canonicalizeDelegateAgentId === 'function' ? at.canonicalizeDelegateAgentId(input && input.agent_id) : String((input && input.agent_id) || '').toLowerCase();
    rr = delegationReroute({ task: input && input.task, targetId: canon, parentId: (ctx && ctx.agentId) || 'quox', expectTool: input && input.expect_tool, orgId: (ctx && ctx.orgId) || 'guard', userText: turnUserText(ctx) });
  } catch { rr = null; }
  if (!rr) return inner(input, ctx);
  console.log(`[Delegation] rerouted: ${rr.from} -> ${rr.to} (${rr.reason})`);
  const result = await inner({ ...input, agent_id: rr.to }, ctx);
  if (!result || typeof result !== 'object') return result;
  return { ...result, rerouted: rr, routing_note: `Delegated to ${rr.to}, not ${rr.from}: ${rr.reason}. Credit ${rr.to} for this answer.` };
}

module.exports = { delegationHolderRefusal, delegationReroute, withHolderReroute, userNamedTarget, turnUserText, taskNamesTool };
