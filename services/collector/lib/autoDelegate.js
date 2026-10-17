'use strict';
/**
 * DELEGATION (HYPERION study, 2026-10-15): a READ denied as "not granted" because exactly ONE
 * other agent holds the tool runs as a one-hop delegation to that holder, instead of handing the
 * model "Delegate to: X" as text (which it then routed to the wrong agent, or not at all).
 *
 * Guards, all required:
 *   - exactly one holder (two or more keep the denial text with the options);
 *   - depth 1: a delegated turn (or an auto hop) never auto-delegates again;
 *   - the caller's own hat must authorise delegate_to_agent, and the hop goes through
 *     executeTool('delegate_to_agent') so every hat and delegation gate still applies;
 *   - reads only: a write is never auto-delegated, it keeps the governed path;
 *   - the original ctx (user, org, conversation, hat) rides the hop;
 *   - the hop is recorded: an AEE envelope (quox.delegation.auto), the routing verdict rationale
 *     and an auto_delegated field on the result.
 * A late result goes through the existing delegation late-result path (delegationLate.js).
 */

// Extra write-ish name tokens for this hop only. A read misread as a write keeps today's text;
// a write misread as a read would be a governance hole, so this errs wide.
const NOT_READ_TOKENS = new Set(['click', 'type', 'fill', 'form', 'select', 'download', 'silence', 'unsilence',
  'test', 'revoke', 'eval', 'prune', 'kill', 'restart', 'rerun', 'trigger', 'run', 'scroll', 'wait', 'new',
  'close', 'tab', 'navigate', 'lease', 'release', 'configure', 'rehearse', 'clone', 'snapshot', 'cleanup',
  'action', 'reboot', 'shutdown', 'login', 'send', 'reply', 'publish', 'schedule']);

function isRead(toolName, input) {
  const ts = require('./turnToolSelection.js');
  if (ts.isStateChangingTool({ name: toolName })) return false;
  if (ts.isWriteAction(toolName, input)) return false;
  const toks = String(toolName || '').toLowerCase().split(/[_\-.]+/).filter(Boolean);
  if (toks.some((t) => NOT_READ_TOKENS.has(t))) return false;
  // a multi-action tool called with any action other than a plain read verb is not assumed a read
  const a = input && typeof input === 'object' && input.action ? String(input.action).toLowerCase() : '';
  if (a && !/^(list|get|read|show|status|query|search|describe|inspect|info|view|check|history)$/.test(a)) return false;
  return true;
}

function isOrchestrator(agentId) {
  const id = String(agentId || '').toLowerCase();
  if (id === 'quox') return true;
  try { return require('./entityAssistantLoader').getAssistant(id)?.hierarchy?.role === 'orchestrator'; } catch { return false; }
}

/** -> { auto: true, holder } | { auto: false, reason } */
function decide({ toolName, input, ctx = {}, heldBy = [], authz }) {
  if (!Array.isArray(heldBy) || heldBy.length !== 1) return { auto: false, reason: 'not_single_holder' };
  if (Number(ctx._delegationDepth || 0) > 0 || ctx._autoDelegated) return { auto: false, reason: 'depth' };
  // Depth 1 on every path: the CLI tool gateway does not always carry _delegationDepth into a
  // delegated child's ctx, so only the orchestrator (who is never the delegated party) auto-hops.
  if (!isOrchestrator(ctx.agentId)) return { auto: false, reason: 'depth' };
  if (!authz || typeof authz.has !== 'function' || !authz.has('delegate_to_agent')) return { auto: false, reason: 'hat_no_delegate' };
  if (!isRead(toolName, input)) return { auto: false, reason: 'not_a_read' };
  const holder = String(heldBy[0] || '').toLowerCase();
  if (!holder || holder === String(ctx.agentId || '').toLowerCase()) return { auto: false, reason: 'no_holder' };
  return { auto: true, holder };
}

function taskFor(toolName, input) {
  const args = input && typeof input === 'object' && Object.keys(input).length ? ` with these arguments: ${JSON.stringify(input).slice(0, 1500)}` : '';
  return `Run your ${toolName} tool${args}, and report what it returned, plainly and completely. This is a read: do not change anything.`;
}

/**
 * Run the hop. runDelegate(input, ctx) is executeTool('delegate_to_agent', ...).
 * Returns the delegate result decorated with auto_delegated, or null when no hop applies.
 */
async function maybeAutoDelegateRead({ toolName, input, ctx, heldBy, authz, runDelegate, log = console }) {
  const d = decide({ toolName, input, ctx, heldBy, authz });
  if (!d.auto) return null;
  const from = String(ctx.agentId || 'quox').toLowerCase();
  const record = { tool: toolName, from, to: d.holder, reason: 'single_holder_read', depth: 1 };
  try { log.log?.(`[Delegation] auto: ${from} -> ${d.holder} for read ${toolName} (single holder)`); } catch { /* log only */ }
  if (typeof ctx.emitEnvelope === 'function') {
    try { await ctx.emitEnvelope({ intent: 'quox.delegation.auto', payload: { ...record, conversation: ctx.conversationId || ctx.session_id || null, user: ctx.userId || null } }); } catch { /* evidence never blocks */ }
  }
  const r = await runDelegate(
    { agent_id: d.holder, task: taskFor(toolName, input), task_class: 'auto_delegated_read' },
    { ...ctx, _autoDelegated: record },
  );
  return { ...(r && typeof r === 'object' ? r : { success: false, error: 'auto delegation returned nothing' }), auto_delegated: record };
}

module.exports = { decide, isRead, maybeAutoDelegateRead, taskFor };
