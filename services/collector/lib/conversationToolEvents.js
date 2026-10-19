'use strict';
/**
 * CLI-QUOXON Q2: pure helpers that turn the governed tool loop's internal
 * events into the conversation events of docs/QUOXON_EVENTS_v1.md
 * (tool.started / tool.finished / approval.requested).
 *
 * Everything shown to a client is scrubbed to ONE short line. Only an
 * allowlist of argument keys is ever echoed (never "everything except").
 */

const SAFE_ARG_KEYS = ['host', 'action', 'container_id', 'container', 'vmid', 'node', 'target', 'name', 'agent_id'];
const TARGET_KEYS = ['host', 'container_id', 'container', 'vmid', 'node', 'target', 'name'];

const CMD_KEYS = ['command', 'cmd', 'script', 'shell', 'commandline', 'command_line'];
const CMD_MAX = 500;
const TARGET_MAX = 200;

/** Strip terminal control sequences (OSC, CSI, lone ESC, BEL, C0/C1 except \n \t, DEL). */
function stripControl(text) {
  return String(text)
    .replace(/\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\u009b[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\u001b[P^_X][^\u001b]*(?:\u001b\\)?/g, '')
    .replace(/\u001b[@-Z\\-_]?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function redact(s) {
  return s
    // URL userinfo: scheme://user:pass@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '[redacted]') // JWT
    // Key shapes need their separator: a bare `sk` prefix matched the tool names skills_list/skill_view (quox#814).
    .replace(/\b(?:(?:sk|pk)[-_]|(?:ghp|gho|ghs)_|xox[a-z]-)[-_A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{12,}/g, '[redacted]')
    // quoted or bare credential-ish keys, with = or : and a quoted or bare value
    .replace(/(["']?)\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|auth|cookie|session[_-]?id)[A-Za-z0-9_.-]*)\b\1\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1$2$1=[redacted]')
    // CLI flags: --password hunter2 / -p style long flags
    .replace(/(--?(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|auth)[A-Za-z0-9_-]*)\s+(?!-)\S+/gi, '$1 [redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]');
}

/** Control-strip, collapse to one line, redact secret shapes. Not length-bounded. */
function cleanLine(text) {
  return redact(stripControl(text == null ? '' : text).replace(/\s+/g, ' ').trim());
}

/** Like scrubLine but never cuts silently: returns the explicit marker when cut. */
function scrubBounded(text, max) {
  const s = cleanLine(text);
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)} [truncated]`, truncated: true };
}

/** Collapse to one line, strip control sequences, redact secret shapes, bound the length. */
function scrubLine(text, max = 120) {
  const s = cleanLine(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pickSafeArgs(input, keys) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' || typeof v === 'number') out.push([k, scrubLine(v, 40)]);
  }
  return out;
}

/** "docker_status host=docker01" (<= 80 chars, no secrets). */
function summarizeToolCall(tool, input) {
  const args = pickSafeArgs(input, SAFE_ARG_KEYS).map(([k, v]) => `${k}=${v}`).join(' ');
  return scrubLine(args ? `${tool} ${args}` : String(tool), 80);
}

function classifyToolStatus(result) {
  if (!result || typeof result !== 'object') return 'failed';
  const err = String(result.error || result.message || '');
  if (result.status === 'outcome_unknown' || result.status === 'effect_unknown' || /outcome_unknown|effect_unknown/i.test(err)) return 'effect_unknown';
  if (result.status === 'denied') return 'denied';
  if (result.status === 'failed' || result.status === 'error') return 'failed';
  if (result.success !== false && !result.error) return 'ok';
  if (/not authori[sz]ed|denied|forbidden|not permitted|policy/i.test(err)) return 'denied';
  return 'failed';
}

function summarizeToolResult(result) {
  if (!result || typeof result !== 'object') return scrubLine(result, 120);
  if (result.success === false || result.error) return scrubLine(`error: ${result.error || result.message || 'failed'}`, 120);
  if (typeof result.message === 'string' && result.message) return scrubLine(result.message, 120);
  if (Array.isArray(result.logs)) {
    const n = result.logs.length;
    return `${n} log ${n === 1 ? 'line' : 'lines'}`;
  }
  if (result.operation === 'inspect' && result.details && typeof result.details === 'object') {
    const d = result.details, h = d.health;
    const hs = h && h.status ? `, health ${h.status}${h.failing_streak ? ` (failing ${h.failing_streak} times)` : ''}` : '';
    return scrubLine(`inspect: ${d.status || 'ok'}${hs}`, 120);
  }
  const parts = [];
  for (const [k, v] of Object.entries(result)) {
    if (k === 'success') continue;
    if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
    if (parts.length >= 3) break;
  }
  return scrubLine(parts.length ? parts.join(', ') : 'ok', 120);
}

/** QUOXON-FW3: who a delegation targets, by display name, and a scrubbed gist of the task. */
function delegationFields(tool, input) {
  if (tool !== 'delegate_to_agent' || !input || typeof input !== 'object' || typeof input.agent_id !== 'string') return {};
  const id = scrubLine(input.agent_id, 40);
  let name = id;
  try {
    const a = require('./entityAssistantLoader').getAssistant(id);
    if (a && a.identity && typeof a.identity.name === 'string' && a.identity.name) name = scrubLine(a.identity.name, 40);
  } catch { /* display name is best-effort; the id is always true */ }
  const out = { agent_id: id, agent_name: name };
  if (typeof input.task === 'string' && input.task) out.task_gist = scrubLine(input.task, 100);
  return out;
}

const NESTED_TOOL_STATUSES = new Set(['ok', 'failed', 'denied', 'effect_unknown']);
/** terminal_suggest_command: the proposed slash command rides on tool.finished for the TUI to ask y/N. */
function suggestCommandFields(tool, result) {
  if (tool !== 'terminal_suggest_command' || !result || typeof result !== 'object' || result.success === false) return {};
  if (typeof result.suggested_command !== 'string' || !result.suggested_command) return {};
  return {
    suggest_command: result.suggested_command.slice(0, 120),
    ...(typeof result.reason === 'string' && result.reason ? { suggest_reason: scrubLine(result.reason, 160) } : {}),
    ...(result.explicit === true ? { suggest_explicit: true } : {}),
  };
}

// Router tools run exactly one narrow executor and say which (result.routed_tool). That executor is
// reported as a nested tool with the router's own outcome. Allowlisted per router, so no other tool's
// result can claim a nested call.
const ROUTER_TOOLS = {
  quoxchat_read: new Set(['quoxchat_list_widgets', 'quoxchat_list_conversations', 'quoxchat_get_transcript', 'quoxchat_get_availability']),
};

function routedResultFields(tool, result) {
  const allowed = ROUTER_TOOLS[tool];
  if (!allowed || !result || typeof result !== 'object' || !allowed.has(result.routed_tool)) return {};
  return { nested_tools: [{ tool: result.routed_tool, status: result.success === false ? 'failed' : 'ok' }] };
}

function delegationResultFields(tool, result) {
  if (ROUTER_TOOLS[tool]) return routedResultFields(tool, result);
  if (tool !== 'delegate_to_agent' || !result || typeof result !== 'object') return {};
  const out = {};
  const t = result.tools_used;
  if (Array.isArray(t)) out.tools_used = t.length;
  else if (typeof t === 'number') out.tools_used = t;
  // #889: name the specialist's tool calls and how each ended. Without this the turn's evidence
  // showed only "delegate_to_agent ... tools_used: 4", so nobody (user, grader, proof engine)
  // could tell WHICH governed tools ran. Status is the tool runner's own classification; an
  // unrecognised value is reported as 'unknown', never upgraded to ok.
  if (Array.isArray(result.tool_outcomes) && result.tool_outcomes.length) {
    out.nested_tools = result.tool_outcomes.slice(0, 25)
      .filter((o) => o && typeof o.tool === 'string' && o.tool)
      .map((o) => ({ tool: scrubLine(o.tool, 60), status: NESTED_TOOL_STATUSES.has(o.status) ? o.status : 'unknown' }));
  }
  return out;
}

/** The gate's pending shape -> ids. Returns null when the call was not held. */
function approvalFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const held = result.pending === true || result._approval?.status === 'pending';
  if (!held) return null;
  const approvalId = result.approvalId || result._approval?.id || null;
  if (!approvalId) return null;
  return { approval_id: approvalId, inbox_item_id: result.inbox_item_id || null };
}

function dashboardUrlFor(origin, inboxItemId) {
  if (!origin || !inboxItemId) return null;
  return `${String(origin).replace(/\/+$/, '')}/inbox/${encodeURIComponent(inboxItemId)}`;
}

/**
 * @param {{emit:(type:string, fields:object)=>void, dashboardOrigin?:string}} p
 * @returns {(ev:object)=>void} onEvent for executeOpenAICompatibleToolLoop
 */
function createToolEventBridge({ emit, dashboardOrigin = '', trace, corr = '' }) {
  const doTrace = (t) => { if (typeof trace === 'function') { try { trace(t); } catch { /* trace is best-effort */ } } };
  return function onEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'tool.started':
        emit('tool.started', { call_id: ev.call_id, tool: ev.tool, summary: summarizeToolCall(ev.tool, ev.input), ...(ev.cli_command ? { cli_command: ev.cli_command } : {}), ...delegationFields(ev.tool, ev.input) });
        break;
      case 'tool.finished':
        emit('tool.finished', {
          call_id: ev.call_id, tool: ev.tool, status: ev.status,
          result_summary: summarizeToolResult(ev.result), duration_ms: ev.duration_ms,
          envelope_id: ev.envelope_id || null,
          ...(ev.cli_command ? { cli_command: ev.cli_command } : {}),
          ...delegationResultFields(ev.tool, ev.result),
          ...suggestCommandFields(ev.tool, ev.result),
          // WARD witnessing is asynchronous: the seq is not known at response time.
          receipt: null,
        });
        if (ev.envelope_id) {
          doTrace({ protocol: 'aee', label: 'envelope opened', ref: ev.envelope_id, detail: `ops.tool · ${ev.tool} ${ev.status} · corr ${String(corr).slice(0, 8)}` });
        }
        break;
      case 'approval.requested': {
        const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
        const tk = TARGET_KEYS.find((k) => typeof input[k] === 'string' || typeof input[k] === 'number');
        let cliLine = null;
        if (ev.tool === 'quox_cli_write') { try { cliLine = require('./quoxCliTools.js').summarizeWriteCall(input); } catch { cliLine = null; } }
        const target = cliLine ? scrubBounded(cliLine, TARGET_MAX) : (tk ? scrubBounded(input[tk], TARGET_MAX) : null);
        const action = typeof input.action === 'string' ? scrubLine(input.action, 40) : null;
        const ck = CMD_KEYS.find((k) => typeof input[k] === 'string' && input[k]);
        const command = ck ? scrubBounded(input[ck], CMD_MAX) : null;
        // Describable: the card names a concrete command, target, or action, or the call has no arguments at all.
        const describable = !!(command || target || action) || Object.keys(input).length === 0;
        emit('approval.requested', {
          call_id: ev.call_id, inbox_item_id: ev.inbox_item_id || null, approval_id: ev.approval_id, tool: ev.tool,
          target: target ? target.text : null,
          target_truncated: target ? target.truncated : false,
          command: command ? command.text : null,
          command_truncated: command ? command.truncated : false,
          describable,
          scope: action ? `${ev.tool}:${action}` : ev.tool,
          risk: typeof ev.risk === 'string' ? ev.risk : null,
          dashboard_url: dashboardUrlFor(dashboardOrigin, ev.inbox_item_id),
        });
        doTrace({ protocol: 'aee', label: 'approval requested', ref: ev.approval_id, detail: `${ev.tool} held for a human` });
        break;
      }
      case 'steer.applied':
        emit('steer.accepted', { text: scrubLine(ev.text, 500), applied_at: ev.applied_at === 'mid_answer' ? 'mid_answer' : 'model_boundary' });
        break;
      default:
        break;
    }
  };
}

module.exports = { ROUTER_TOOLS, scrubLine, summarizeToolCall, summarizeToolResult, classifyToolStatus, approvalFromResult, dashboardUrlFor, createToolEventBridge, delegationResultFields };
