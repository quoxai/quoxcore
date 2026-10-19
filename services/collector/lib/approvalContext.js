'use strict';

/**
 * approvalContext.js (HITL-CONTEXT, owner 2026-10-07).
 *
 * Owner, verbatim: approval requests "don't have enough context for me to know
 * what is trying to do what and why upon whose request, especially if the
 * moment passes and I don't get there for a while.... Source: Vulcan, Reason:
 * Access hyp-01 to fix xyz, Method: Bastion, whatever".
 *
 * Builds ONE structured, durable context block at approval-request time
 * (server-side, in createApprovalRequest, the funnel every gated tool passes
 * through) so the card still makes sense hours later:
 *
 *   requested_by  agent + delegation chain + calling identity + surface
 *   on_behalf_of  originating human + their request excerpt + conversation id
 *   reason        WHY: supplied by the caller (`_reason`, CLI --reason) or
 *                 inferred from the parent request, labelled as such
 *   method        tool + transport + target + exact command/args (redacted)
 *   why_approval  the rule that stopped it
 *   target, risk, created_at, expires_at, summary_line
 *
 * Pure (no I/O) apart from the injected turn lookup, so it is unit-testable.
 * Every human-visible string that came from a caller or agent is escaped
 * before it is put into markdown (same forgery concern as
 * escapeCalendarQMarkdown in approvalGate.js).
 */

const { redactSensitive } = require('./contentRedactor.js');

const SURFACE_LABELS = {
  cli: 'CLI',
  dashboard: 'dashboard chat',
  voice: 'voice call',
  matrix: 'Matrix room',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  webhook: 'webhook',
  scheduler: 'scheduler',
  workflow: 'workflow',
  mcp: 'MCP',
  attached: 'attached session',
  api: 'API',
};

const SESSION_PREFIX_SURFACE = [
  ['tel_', 'voice'],
  ['matrix_', 'matrix'],
  ['discord_', 'discord'],
  ['slack_', 'slack'],
  ['telegram_', 'telegram'],
  ['webhook_', 'webhook'],
  ['sched_', 'scheduler'],
  ['wf_', 'workflow'],
  ['quoxflow_', 'workflow'],
  ['MCP_', 'mcp'],
  ['mcp-', 'mcp'],
];

const TRANSPORTS = {
  ssh_exec: 'Bastion SSH',
  remote_ssh: 'direct SSH (vault key)',
  db_query: 'database (vault credential)',
  email_send: 'org mailbox',
  bob_dispatch_build: 'QuoxBuild queue',
};

const WHY_LABELS = {
  'agent-propose-only-gate': 'Agent-proposed action: a human must confirm before it runs',
  'proxmox-destructive-actions': 'Destructive Proxmox action',
  'entity-metadata-requires-approval': 'This tool is marked requires-approval',
};

const MAX_REASON = 400;
const MAX_COMMAND = 1200;

function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Single-line, markdown-inert rendering of caller/agent-supplied text. */
function escapeMd(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[`*_~#[\]>|]/g, (c) => `\\${c}`)
    .replace(/\r\n|\r|\n/g, ' ');
}

/** Short, safe label for a caller-supplied session name (CLI header/body). */
function sanitizeLabel(value, n = 48) {
  if (value == null) return null;
  const s = String(value).replace(/[^\w .:@+\-/]/g, '').trim();
  return s ? s.slice(0, n) : null;
}

function inferSurface(ctx = {}) {
  if (ctx.surface && SURFACE_LABELS[ctx.surface]) return ctx.surface;
  if (ctx.callerClient === 'cli') return 'cli';
  const sid = String(ctx.conversationId || ctx.session_id || ctx.sessionId || '');
  for (const [prefix, surface] of SESSION_PREFIX_SURFACE) {
    if (sid.startsWith(prefix)) return surface;
  }
  if (ctx.attachLeaseId) return 'attached';
  if (sid && ctx.userId) return 'dashboard';
  return 'api';
}

function extractCommand(toolName, input = {}) {
  if (toolName === 'ssh_exec' || toolName === 'remote_ssh') return input.command;
  if (toolName === 'db_query') return input.query || input.sql;
  if (typeof input.command === 'string') return input.command;
  return null;
}

function argsPreview(input = {}) {
  const shown = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (k.startsWith('_')) continue;
    if (['reason', 'related_to', 'context'].includes(k)) continue;
    shown[k] = v;
  }
  if (Object.keys(shown).length === 0) return null;
  let json;
  try { json = JSON.stringify(shown); } catch { return null; }
  return json;
}

function suppliedReason(input = {}, ctx = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return pick(input._reason) || pick(ctx.reason) || pick(input.reason)
    || pick(input.related_to) || pick(input.context) || '';
}

function upper(s) { return String(s || '').toUpperCase(); }

/**
 * @param {object} p
 * @param {string} p.toolName
 * @param {object} p.input            the tool input (control fields allowed)
 * @param {object} [p.pendingApproval] the gate's proposal (trigger/title/targetId/timeout_ms/risk)
 * @param {object} [p.ctx]            the tool-call ctx
 * @param {object|null} [p.turn]      approvalTurnContext.getTurn() result for this conversation
 * @param {Function} [p.delegationChainFor] approvalTurnContext.delegationChainFor
 * @param {object|null} [p.reach]     blast-radius summary, if computed
 * @param {string|null} [p.fallbackAsk] the human's own message on this conversation (directRequestRegistry.askFor), used for
 *                                    request_excerpt when the turn registry has none (APPROVAL-WWWH)
 * @param {number} [p.now]
 */
function buildApprovalContext({ toolName, input = {}, pendingApproval = null, ctx = {}, turn = null, delegationChainFor = null, reach = null, fallbackAsk = null, now = Date.now() } = {}) {
  input = input && typeof input === 'object' ? input : {};
  const agentId = String(ctx.agentId || 'quox').toLowerCase();
  const surface = inferSurface(ctx);
  const sessionLabel = sanitizeLabel(ctx.sessionLabel);
  const profile = sanitizeLabel(ctx.callerProfile, 32);

  // Actor chain: who actually asked, through which agents.
  const del = typeof delegationChainFor === 'function' ? delegationChainFor(turn, agentId) : { chain: [agentId], task: null };
  const chain = (del.chain && del.chain.length ? del.chain : [agentId]).map(upper);

  let caller;
  if (ctx.attachLeaseId) {
    caller = { kind: 'attached_agent', name: sessionLabel || upper(agentId) + (ctx.splinter ? `/${sanitizeLabel(ctx.splinter, 24)}` : ''), user_id: ctx.holderUserId || ctx.userId || null };
  } else if (sessionLabel) {
    caller = { kind: 'session', name: sessionLabel, user_id: ctx.userId || null };
  } else if (turn && turn.userId) {
    caller = { kind: 'human', name: turn.userName || ctx.userName || turn.userId, user_id: turn.userId };
  } else if (ctx.userId) {
    caller = { kind: 'human', name: ctx.userName || ctx.userId, user_id: ctx.userId };
  } else {
    caller = { kind: 'service', name: upper(agentId), user_id: null };
  }

  const requested_by = {
    agent_id: agentId,
    agent_label: upper(agentId),
    delegation_chain: chain,
    caller,
    session_label: sessionLabel,
    profile,
    surface,
    surface_label: SURFACE_LABELS[surface] || surface,
  };

  const conversationId = ctx.conversationId || ctx.session_id || ctx.sessionId || null;
  const on_behalf_of = (turn && (turn.userId || turn.text)) ? {
    user_id: turn.userId || null,
    user_name: turn.userName || null,
    request_excerpt: turn.text ? clip(turn.text, 300) : (fallbackAsk ? clip(redactSensitive(String(fallbackAsk)), 300) : null),
    conversation_id: conversationId,
    surface: turn.surface || null,
  } : (ctx.userId && caller.kind !== 'human' ? {
    user_id: ctx.holderUserId || ctx.userId,
    user_name: ctx.userName || null,
    request_excerpt: fallbackAsk ? clip(redactSensitive(String(fallbackAsk)), 300) : null,
    conversation_id: conversationId,
    surface: null,
  } : null);

  // Reason: supplied beats inferred; inferred names where it came from.
  let reason;
  const given = suppliedReason(input, ctx);
  if (given) {
    reason = { text: clip(redactSensitive(given), MAX_REASON), source: 'supplied' };
  } else if (del.task) {
    reason = { text: clip(redactSensitive(del.task), MAX_REASON), source: 'inferred', inferred_from: 'delegation_task' };
  } else if (turn && turn.text) {
    reason = { text: clip(redactSensitive(turn.text), MAX_REASON), source: 'inferred', inferred_from: 'user_request' };
  } else if (surface === 'cli' && extractCommand(toolName, input) != null) {
    // The CLI caller gave no --reason: summarise what it ran, clearly labelled
    // inferred so the human does not mistake it for a stated intent.
    const cmd = clip(redactSensitive(String(extractCommand(toolName, input))), 60);
    reason = { text: `ran: ${cmd}`, source: 'inferred', inferred_from: 'command' };
  } else {
    reason = { text: null, source: 'none' };
  }

  const target = approvalTarget(input, pendingApproval);

  const rawCommand = extractCommand(toolName, input);
  const command = rawCommand != null
    ? clip(redactSensitive(String(rawCommand)), MAX_COMMAND)
    : null;
  const args = command ? null : (() => { const a = argsPreview(input); return a ? clip(redactSensitive(a), MAX_COMMAND) : null; })();

  const method = {
    tool: toolName,
    transport: TRANSPORTS[toolName] || (input.action ? `${toolName} (${input.action})` : toolName),
    target,
    command,
    args,
  };

  const trig = pendingApproval?.trigger || {};
  const policyId = trig.policyId || null;
  let whyLabel = WHY_LABELS[policyId] || (policyId ? `Policy ${policyId}${trig.ruleId ? ` (rule ${trig.ruleId})` : ''}` : 'Approval required');
  if ((toolName === 'ssh_exec' || toolName === 'remote_ssh') && policyId === 'agent-propose-only-gate') {
    whyLabel = 'Shell command is not on the read-only allowlist, so an agent cannot run it without a human';
  }
  const why_approval = {
    policy_id: policyId,
    rule_id: trig.ruleId || null,
    condition: trig.condition ? clip(trig.condition, 300) : null,
    label: whyLabel,
  };

  const timeoutMs = Number(pendingApproval?.timeout_ms || pendingApproval?.timeoutMs || 3600000);
  const risk = pendingApproval?.risk || (reach && (reach.band || reach.level || reach.risk)) || null;

  const context = {
    v: 1,
    requested_by,
    on_behalf_of,
    reason,
    method,
    why_approval,
    target,
    risk: risk ? String(risk) : null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (Number.isFinite(timeoutMs) ? timeoutMs : 3600000)).toISOString(),
  };
  context.source_label = sourceLabel(context);
  context.summary_line = summaryLine(context);
  return context;
}

/** What an approval acts on: host, vm, credential, repo, recipient, path or id. Null when the input names none. */
function approvalTarget(input = {}, pendingApproval = null) {
  const pick = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : '';
  const to = Array.isArray(input.to) ? input.to.filter(Boolean).join(', ') : input.to;
  return pick(input.host) || pick(input.host_id) || pick(pendingApproval?.targetId)
    || (input.vmid ? `vm ${input.vmid}${input.node ? ` on ${input.node}` : ''}` : '')
    || pick(input.credential_id) || pick(input.repo) || pick(to) || pick(input.recipient) || pick(input.email)
    || pick(input.container_id) || pick(input.container) || pick(input.service) || pick(input.path) || pick(input.url)
    || null;
}

/**
 * APPROVAL-WHAT: { action, target | target_none, summary } for a gated tool call, so the item says
 * what will happen and to what. Built from the tool input alone: it never fails while a tool name
 * exists, and refuses (throws) when it does not.
 */
function describeApprovalWhat({ toolName, input = {}, pendingApproval = null } = {}) {
  if (!toolName || typeof toolName !== 'string') throw new Error('approval_undescribed: no tool name, so the approval cannot say what will happen');
  input = input && typeof input === 'object' ? input : {};
  const explicit = pendingApproval && pendingApproval.what && typeof pendingApproval.what === 'object' ? pendingApproval.what : null;
  const action = (explicit && explicit.action) || (input.action ? `${toolName} ${input.action}` : `run ${toolName}`);
  const target = (explicit && explicit.target) || approvalTarget(input, pendingApproval);
  const raw = extractCommand(toolName, input);
  const detail = raw != null ? clip(redactSensitive(String(raw)).replace(/\s+/g, ' '), 120) : (() => {
    const a = argsPreview(input); if (!a) return null;
    let o; try { o = JSON.parse(a); } catch { return clip(redactSensitive(a), 120); }
    const parts = Object.entries(o).filter(([k, v]) => v != null && v !== '' && !['host', 'host_id', 'action', 'vmid', 'node'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    return parts.length ? clip(redactSensitive(parts.join(' ')).replace(/\s+/g, ' '), 120) : null;
  })();
  const proposed = pendingApproval?.title ? actionFromTitle(pendingApproval.title, toolName) : '';
  const summary = (explicit && explicit.summary)
    || (proposed && !/^approval (?:required|needed)\b/i.test(proposed) ? proposed : '')
    || `${action}${target ? ` on ${target}` : ''}${detail ? `: ${detail}` : ''}`;
  const out = { action: clip(String(action), 120), target: target ? clip(String(target), 200) : null, summary: clip(String(summary), 280) };
  if (!out.target) out.target_none = (explicit && (explicit.target_none || explicit.targetNone)) || `no target: ${toolName} names no host, recipient or id in its arguments`;
  return out;
}

/** "VULCAN (CLI)"", "ADAM via QUOX → NOVA (dashboard chat)". */
function sourceLabel(c) {
  const rb = c.requested_by;
  const who = rb.caller.kind === 'service' ? rb.agent_label : rb.caller.name;
  const chain = rb.delegation_chain.length > 1 ? ` via ${rb.delegation_chain.join(' → ')}` : '';
  const viaAgent = !chain && rb.caller.kind !== 'service' && rb.agent_id !== 'quox' && rb.caller.name !== rb.agent_label ? ` via ${rb.agent_label}` : '';
  const prof = rb.caller.kind === 'human' && rb.profile && rb.surface === 'cli' ? `, profile ${rb.profile}` : '';
  return `${who}${chain}${viaAgent} (${rb.surface_label}${prof})`;
}

function methodLabel(m) {
  return `${m.tool} via ${m.transport}${m.target ? ` on ${m.target}` : ''}`;
}

function summaryLine(c) {
  const reason = c.reason.text
    ? `${clip(c.reason.text, 140)}${c.reason.source === 'inferred' ? ' (inferred)' : ''}`
    : 'none given';
  return `Source: ${c.source_label} · Reason: ${reason} · Method: ${methodLabel(c.method)}`;
}

/** Strip the legacy "<AGENT> proposes: " prefix so the action reads on its own. */
function actionFromTitle(baseTitle, toolName) {
  const t = String(baseTitle || '').replace(/^[A-Z0-9_\-]+ proposes:\s*/i, '').trim();
  return t || `run ${toolName}`;
}

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

/**
 * Title that leads with source + intent, e.g.
 *   "VULCAN (CLI) wants to read hyp-01 backup config: run a shell command on hyp-01"
 * Only a SUPPLIED reason becomes the intent; an inferred one stays in the body
 * (a user's whole sentence makes a poor title and could mislead).
 */
function buildContextTitle(context, baseTitle, toolName) {
  const action = actionFromTitle(baseTitle, toolName);
  const src = context.source_label;
  if (context.reason.source === 'supplied' && context.reason.text) {
    const intent = lowerFirst(clip(context.reason.text.replace(/[.\s]+$/, ''), 70));
    return clip(`${src} wants to ${intent}: ${action}`, 180);
  }
  return clip(`${src} wants to: ${action}`, 180);
}

/** Labelled markdown block prepended to the item body (all caller text escaped). */
function renderContextMarkdown(c) {
  const lines = ['**Approval context**', ''];
  const rb = c.requested_by;
  let src = escapeMd(c.source_label);
  if (rb.profile) src += ` · profile ${escapeMd(rb.profile)}`;
  lines.push(`- **Source:** ${src}`);
  if (c.on_behalf_of) {
    const ob = c.on_behalf_of;
    let who = escapeMd(ob.user_name || ob.user_id || 'unknown user');
    if (ob.request_excerpt) who += `, asked: "${escapeMd(ob.request_excerpt)}"`;
    if (ob.conversation_id) who += ` (conversation ${escapeMd(String(ob.conversation_id).slice(0, 64))})`;
    lines.push(`- **On behalf of:** ${who}`);
  }
  lines.push(`- **Reason:** ${c.reason.text ? escapeMd(c.reason.text) + (c.reason.source === 'inferred' ? ' _(inferred, not stated by the caller)_' : '') : '_none given_'}`);
  lines.push(`- **Method:** ${escapeMd(methodLabel(c.method))}`);
  if (c.method.command) lines.push(`- **Command:** \`${String(c.method.command).replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``);
  else if (c.method.args) lines.push(`- **Args:** \`${String(c.method.args).replace(/`/g, "'")}\``);
  lines.push(`- **Why approval:** ${escapeMd(c.why_approval.label)}`);
  if (c.risk) lines.push(`- **Risk:** ${escapeMd(c.risk)}`);
  lines.push(`- **Expires:** ${c.expires_at}`);
  return `${lines.join('\n')}\n\n---\n\n`;
}

module.exports = {
  buildApprovalContext,
  describeApprovalWhat,
  approvalTarget,
  buildContextTitle,
  renderContextMarkdown,
  inferSurface,
  sanitizeLabel,
  escapeMd,
  SURFACE_LABELS,
};
