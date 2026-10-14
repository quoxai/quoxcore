'use strict';
/**
 * CLI-QUOX: translate the Claude CLI's `--output-format stream-json` output
 * into the conversation events of docs/QUOXON_EVENTS_v1.md, for the
 * /chat/stream Claude CLI path (which used to be one-shot).
 *
 *   createStreamJsonParser  NDJSON stdout -> normalized events
 *                           ({kind:'text'|'tool_use'|'tool_result'}) + the
 *                           final `result` object (same shape as
 *                           `--output-format json` prints, so the dispatcher's
 *                           post-processing is unchanged).
 *   createCliTurnBridge     normalized events -> text.delta, tool.started,
 *                           tool.finished, approval.requested. Summaries and
 *                           the approval card reuse conversationToolEvents.js.
 *
 * Tool calls on this path are the CLI's native Bash running
 * `quox tool exec <name> --args '<json>'` (QUOX_TOOL_MODE=cli). The governed
 * tool name and args are read from that command; any other command is
 * reported by its native name only and never echoed.
 */

const { createToolEventBridge, classifyToolStatus, approvalFromResult } = require('./conversationToolEvents.js');
const { scrubEmDashes, guardEmDashZone } = require('./quoxchatVoiceScrub.js');

// Verified against the CLI installed in the collector image (2.1.197):
// stream-json under --print requires --verbose; --include-partial-messages
// adds token-level text deltas (stream_event lines).
const CLI_STREAM_OUTPUT_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

const MAX_LINE = 4 * 1024 * 1024; // a single NDJSON line larger than this is dropped, not buffered forever

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  }
  return '';
}

function createStreamJsonParser({ onEvent } = {}) {
  let buf = '';
  let finalResult = null;
  let sawPartialText = false;
  let lastUsage = null; // usage of the newest top-level assistant message (context size of the last call)
  let eventCount = 0;
  let sessionId = null; // D5: known from the first top-level line, so an interrupted turn can still record continuity
  const seenToolUse = new Set();
  const fire = (e) => { eventCount += 1; if (typeof onEvent === 'function') { try { onEvent(e); } catch { /* a consumer failure never breaks the parse */ } } };

  function handle(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.parent_tool_use_id) return; // sub-agent traffic is not the turn's answer
    if (typeof obj.session_id === 'string' && obj.session_id) sessionId = obj.session_id.slice(0, 80);
    switch (obj.type) {
      case 'stream_event': {
        const ev = obj.event || {};
        if (ev.type === 'message_start') { fire({ kind: 'message_start' }); break; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
          sawPartialText = true;
          fire({ kind: 'text', delta: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        if (obj.message && obj.message.usage && typeof obj.message.usage === 'object') lastUsage = obj.message.usage;
        const content = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_use' && b.id && !seenToolUse.has(b.id)) {
            seenToolUse.add(b.id);
            fire({ kind: 'tool_use', id: b.id, name: String(b.name || 'tool'), input: (b.input && typeof b.input === 'object') ? b.input : {} });
          } else if (b.type === 'text' && !sawPartialText && typeof b.text === 'string' && b.text) {
            // No partial messages from this CLI: the whole block is the delta.
            fire({ kind: 'text', delta: b.text });
          }
        }
        break;
      }
      case 'user': {
        const content = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
        for (const b of content) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            fire({ kind: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error === true, text: blockText(b.content) });
          }
        }
        break;
      }
      case 'result':
        finalResult = obj;
        break;
      default:
        break;
    }
  }

  function processLine(l) {
    const s = l.trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch { return; }
    handle(obj);
  }

  function push(chunk) {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(l);
    }
    if (buf.length > MAX_LINE) buf = '';
  }

  function end() {
    if (buf) { processLine(buf); buf = ''; }
  }

  return { push, end, result: () => finalResult, lastUsage: () => lastUsage, eventCount: () => eventCount, sessionId: () => sessionId };
}

const EXEC_RE = /\bquox\s+tool\s+exec\s+([A-Za-z0-9_.:-]+)/;
const ARGS_RE = /--(?:args|input)(?:\s+|=)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/;

/** Bash(`quox tool exec <name> --args '<json>'`) -> { tool, args }. Never returns the raw command. */
function describeCliToolUse(name, input) {
  const n = String(name || 'tool');
  if (n !== 'Bash') return { tool: n, args: {} };
  const cmd = input && typeof input.command === 'string' ? input.command : '';
  const m = EXEC_RE.exec(cmd);
  if (!m) return { tool: 'Bash', args: {} };
  let args = {};
  const a = ARGS_RE.exec(cmd.slice(m.index + m[0].length));
  if (a) {
    let raw = a[1];
    if (raw === undefined && a[2] !== undefined) raw = a[2].replace(/\\(["\\$`])/g, '$1');
    if (raw === undefined) raw = a[3];
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch { /* unparseable: report no args rather than guess */ }
  }
  return { tool: m[1], args };
}

function parseResultPayload(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { /* fall through */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j <= i) return null;
  try { const o = JSON.parse(s.slice(i, j + 1)); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** -> { status, result, approval } ; an errored tool result is never 'ok'. */
function classifyCliToolResult({ is_error, text }) {
  const parsed = parseResultPayload(text);
  if (is_error) {
    const result = { success: false, error: String(text || 'tool failed').slice(0, 2000) };
    const st = classifyToolStatus(result);
    return { status: st === 'ok' ? 'failed' : st, result, approval: null };
  }
  const approval = parsed && !Array.isArray(parsed) ? approvalFromResult(parsed) : null;
  if (parsed && !Array.isArray(parsed)) return { status: classifyToolStatus(parsed), result: parsed, approval };
  return { status: 'ok', result: { message: String(text || '') }, approval: null };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Real usage from the CLI's result message. Absent or non-numeric = null, never an invented 0.
 * total_cost_usd is the claude CLI's own API-equivalent estimate (on a subscription nothing is billed per
 * call), so a figure is labelled cost_source 'claude-cli': clients show it as that, never as a price.
 */
function cliUsageFrom(resp) {
  const r = resp && typeof resp === 'object' ? resp : {};
  const u = r.usage && typeof r.usage === 'object' ? r.usage : {};
  const cost = num(r.total_cost_usd);
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cost_usd: cost,
    ...(cost != null ? { cost_source: 'claude-cli' } : {}),
  };
}

/**
 * Progressive em-dash scrub for deltas: holds back to the last whitespace and
 * reuses guardEmDashZone so a dash zone is never split across an emit, then
 * scrubEmDashes each piece (the same rules the widget stream applies).
 */
function createEmDashDeltaScrubber(emit) {
  let buf = '';
  const out = (s) => { if (s) emit(s); };
  function push(delta) {
    if (typeof delta !== 'string' || !delta) return;
    buf += delta;
    // Hold back the last token (and any whitespace after it): a dash arriving in
    // the next delta needs the word before it to be rewritten correctly.
    const ws = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
    let end = buf.length;
    while (end > 0 && ws(buf[end - 1])) end--;
    let cut = end;
    while (cut > 0 && !ws(buf[cut - 1])) cut--;
    if (cut <= 0) return;
    cut = guardEmDashZone(buf, cut);
    if (cut <= 0) return;
    const piece = buf.slice(0, cut);
    buf = buf.slice(cut);
    out(scrubEmDashes(piece));
  }
  function flush() {
    if (!buf) return;
    const s = scrubEmDashes(buf);
    buf = '';
    out(s);
  }
  return { push, flush };
}

/**
 * @param {{emit:(type:string, fields:object)=>void, dashboardOrigin?:string, trace?:Function, corr?:string, now?:()=>number}} p
 */
function createCliTurnBridge({ emit, dashboardOrigin = '', trace, corr = '', now = () => Date.now() } = {}) {
  const safeEmit = (type, fields) => { try { emit(type, fields); } catch { /* the socket may be gone; keep parsing */ } };
  const toolBridge = createToolEventBridge({ emit: safeEmit, dashboardOrigin, trace, corr });
  const open = new Map(); // call_id -> { tool, args, startedAt }
  let deltas = 0;
  let streamedChars = 0;
  let sawText = false;
  let needBreak = false; // a new assistant message (or a tool call) separates paragraphs
  const scrubber = createEmDashDeltaScrubber((content) => {
    deltas++;
    streamedChars += content.length;
    safeEmit('text.delta', { content });
  });

  function onParsed(e) {
    if (!e) return;
    try {
      if (e.kind === 'message_start') {
        if (sawText) needBreak = true;
      } else if (e.kind === 'text') {
        if (needBreak) { scrubber.push('\n\n'); needBreak = false; }
        sawText = true;
        scrubber.push(e.delta);
      } else if (e.kind === 'tool_use') {
        if (sawText) needBreak = true;
        // Text before a tool call belongs before its line in the transcript.
        scrubber.flush();
        const { tool, args } = describeCliToolUse(e.name, e.input);
        open.set(e.id, { tool, args, startedAt: now() });
        toolBridge({ type: 'tool.started', call_id: e.id, tool, input: args });
      } else if (e.kind === 'tool_result') {
        const call = open.get(e.tool_use_id) || { tool: 'tool', args: {}, startedAt: now() };
        open.delete(e.tool_use_id);
        const r = classifyCliToolResult({ is_error: e.is_error, text: e.text });
        if (r.approval) {
          // Held for a human: nothing executed, so no tool.finished (it would have to lie).
          const res = r.result || {};
          toolBridge({ type: 'approval.requested', call_id: e.tool_use_id, tool: call.tool, input: call.args, risk: (res._approval && res._approval.risk) || res.risk || res.capabilityRisk || null, ...r.approval });
        } else {
          toolBridge({ type: 'tool.finished', call_id: e.tool_use_id, tool: call.tool, status: r.status, result: r.result, duration_ms: now() - call.startedAt, envelope_id: null });
        }
      }
    } catch { /* event translation is best-effort; the answer still arrives */ }
  }

  /** The CLI process ended with calls still open: their effect is unknown, say so. */
  function closeOpen() {
    for (const [id, call] of open) {
      toolBridge({ type: 'tool.finished', call_id: id, tool: call.tool, status: 'effect_unknown', result: { success: false, error: 'the Claude CLI process ended before this tool reported; its effect is unknown' }, duration_ms: now() - call.startedAt, envelope_id: null });
    }
    open.clear();
  }

  function flush() { try { scrubber.flush(); } catch { /* best-effort */ } }

  return { onParsed, flush, closeOpen, deltaCount: () => deltas, streamedChars: () => streamedChars };
}

/**
 * Context size of the turn's last model call (input + cache read + cache
 * creation of the newest assistant message) and the model's window as the CLI
 * reports it in result.modelUsage. Nulls when the CLI reported neither.
 */
function cliContextFrom(result, lastUsage) {
  const u = lastUsage && typeof lastUsage === 'object' ? lastUsage : null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const tokens = u ? n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) : 0;
  let window = null;
  const mu = result && result.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage : null;
  if (mu) {
    for (const v of Object.values(mu)) {
      if (v && Number.isFinite(v.contextWindow) && v.contextWindow > 0) window = Math.max(window || 0, v.contextWindow);
    }
  }
  return { contextTokens: tokens > 0 ? tokens : null, contextWindow: window };
}

module.exports = {
  cliContextFrom,
  CLI_STREAM_OUTPUT_ARGS, createStreamJsonParser, describeCliToolUse, classifyCliToolResult, cliUsageFrom,
  createEmDashDeltaScrubber, createCliTurnBridge,
};
