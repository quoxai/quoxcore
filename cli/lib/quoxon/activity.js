/**
 * What is actually happening right now, as one honest word (CLI-QUOX indicator).
 * Pure: the reducer feeds every real event through nextActivity and keeps the result on the turn.
 * Rules: a word exists only because an event said so; between events the last true word stays (never
 * invented, never rotated); unknown tools fall back to "Working" plus the tool name as detail.
 * Words are capitalised present participles; the indicator appends the ellipsis.
 *
 * State: { word, detail, tone: 'work' | 'wait', flash: ms | null, since: ms }
 */

const clipD = (s, n = 40) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Ordered: first match wins, so specific families come before generic ones. [regex, word, detail?]
// Tool names are the real registry names (memory_search, bastion_ssh, quoxplan_set_status, ...).
const TOOL_TABLE = [
  [/^(memory_(save|update)|brain_save|brain_garden_apply)/, 'Remembering'],
  [/^memory_forget/, 'Forgetting'],
  [/^(memory_|brain_|search_wisdom)/, 'Recalling'],
  [/^(fleet_|bastion_).*(exec|ssh|run|restart|command)|^(bastion_ssh|fleet_exec)/, 'Running', 'host'],
  [/^(fleet_|bastion_)/, 'Looking up'],
  [/^(email_send|contacts_send)/, 'Sending'],
  [/^contacts_dial/, 'Dialling'],
  [/^(email_draft|inbox_propose|email_reply)/, 'Drafting'],
  [/^(email_|inbox_)/, 'Checking mail'],
  [/^(qlarity_|browser_(screenshot|lighthouse|pdf|find_element|list_tabs|monitor))/, 'Inspecting'],
  [/^(browser_|http_|fetch_|web_)/, 'Fetching'],
  [/^(seo_|quoxseo)/, 'Analysing'],
  [/^(delegate|agent_handoff|agent_delegate|ask_agent|agent_call)|handoff/, 'Delegating', 'target'],
  [/^(quoxflow_|workflow_)/, 'Orchestrating'],
  [/^(quoxplan_|plan_)/, 'Planning'],
  [/^(ward_|volt_|receipt|verify)/, 'Verifying'],
  [/^approval/, 'Checking approvals'],
  [/^calendar_/, 'Scheduling'],
  [/^(search_|query_)|_search$|_find$/, 'Searching'],
  [/(^|_)(write|edit|create)_(file|doc)|^file_(write|save)|^plan_doc/, 'Writing'],
  [/(^|_)read(_|$)|^file_(read|get|open)/, 'Reading'],
  [/(^|_)(list|get|status)$|^contacts_/, 'Looking up'],
];

/** QUOXON-FW3: "Delegating <Agent> · <task gist>" instead of an anonymous delegate_to_agent. */
function delegateTarget(ev) {
  const id = ev.agent_id || (String(ev.summary || '').match(/\bagent_id=(\S+)/) || [])[1] || '';
  const name = ev.agent_name || id;
  return { ...ev, target: [name, ev.task_gist].filter(Boolean).join(' \u00b7 ') };
}

/** { word, detail } for a tool call. Unknown tools are "Working" with the tool name, never a guess. */
export function toolWord(tool, ev = {}) {
  const name = String(tool || '').toLowerCase();
  for (const [re, word, d] of TOOL_TABLE) {
    if (re.test(name)) return { word, detail: d ? (clipD(ev[d] ?? ev.target ?? ev.host) || null) : null };
  }
  return { word: 'Working', detail: name || null };
}

const mk = (word, detail = null, now = 0, tone = 'work', flash = null, tool = null) => ({ word, detail: detail ? clipD(detail) : null, tone, flash, since: now, ...(tool ? { tool: clipD(tool, 40) } : {}) });
export const initialActivity = (now = 0) => mk('Sending', null, now); // the request was dispatched: true from turn.begin

/** Trace lines from the governance chain. Labels as the server sends them. */
function traceWord(ev) {
  const label = String(ev.label || '').toLowerCase();
  if (ev.protocol === 'aee' && /envelope opened/.test(label)) return ['Recording', 'envelope'];
  if (ev.protocol === 'aocl') {
    if (/\bl1\b|identity/.test(label)) return ['Verifying', 'L1 identity'];
    if (/\bl3\b|policy/.test(label)) return ['Governing', 'L3 policy'];
    return null;
  }
  if (ev.protocol === 'ward' && /witness/.test(label)) return ['Witnessing', null];
  return null;
}

/**
 * Next activity for a stream event. ctx = { hasText } (has any answer text arrived yet).
 * Returns prev unchanged for events that say nothing new.
 */
export function nextActivity(prev, ev, now = 0, ctx = {}) {
  const p = prev || initialActivity(now);
  switch (ev?.type) {
    case 'thinking': {
      const stage = String(ev.stage || ''), msg = String(ev.message || '').replace(/[.…\s]+$/u, '');
      if (stage === 'routing') return mk('Routing', (msg.match(/\bto\s+(.+)$/i) || [])[1] || null, now);
      if (stage === 'routing_detail') return mk('Routing', msg || p.detail, now);
      if (stage === 'processing') return mk('Reading', null, now);
      if (stage === 'api_call') {
        if (ctx.hasText) return p;
        return mk('Thinking', (msg.match(/Calling (.+?) API/i) || [])[1] || null, now);
      }
      if (stage.includes('tool') && msg) { const t = toolWord(msg); return mk(t.word, t.detail, now); }
      return p;
    }
    case 'trace': { const t = traceWord(ev); return t ? mk(t[0], t[1], now) : p; }
    case 'tool.started': { const t = toolWord(ev.tool, ev.tool === 'delegate_to_agent' ? delegateTarget(ev) : ev); return mk(t.word, t.detail, now, 'work', null, ev.tool || null); }
    case 'tool.finished': return ev.status === 'failed' ? { ...p, flash: now } : p; // keep the word, flash the Q only
    case 'approval.requested': return mk('Waiting', 'for your approval', now, 'wait');
    case 'approval.resolved': return mk('Resuming', null, now);
    case 'steer.accepted': return mk('Adjusting', null, now);
    case 'text.delta': case 'chunk': return p.word === 'Writing' && p.tone === 'work' ? p : mk('Writing', null, now);
    case 'retry': case 'reconnecting': return mk('Reconnecting', null, now);
    case 'resumed': return mk('Resuming', 'reattached', now);
    case 'done': return mk('Confirming', 'waiting for the server', now);
    case 'error': return { ...p, flash: now };
    default: return p;
  }
}

/** Client-side actions that are also true events (the human pressed Esc). */
export function actionActivity(prev, action, now = 0) {
  if (action?.type === 'turn.begin') return initialActivity(action.now ?? now);
  if (action?.type === 'interrupt.requested') return mk('Stopping', null, action.now ?? now);
  return prev;
}
