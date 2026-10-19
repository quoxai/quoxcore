/**
 * QUOXON conversation state reducer. Consumes BOTH the legacy /chat/stream
 * events (connected, thinking, chunk, done, error) and the v1 contract
 * (docs/QUOXON_EVENTS_v1.md): turn.*, text.delta, tool.*, approval.*, trace,
 * steer.accepted. Pure: no I/O, no clocks (time comes in on actions).
 *
 * Shape
 *   history  : settled items, rendered once via <Static>
 *   blocks   : the live turn's ordered blocks; a settled PREFIX is flushed to
 *              history (text followed by something, tools that finished)
 *   turn     : null | { id, status: running|interrupting, startedAt, stage, activity }
 */

import { isConsentError, consentErrorText } from './consent.js';
import { splitSettled } from './markdown.js';
import { nextActivity, actionActivity } from './activity.js';
import { normUsage, turnTokens, fmtTokens, fmtCost } from './indicator.js';
import { isLayerTrace, normaliseSummary, summaryFromTraces, verdictNote } from './aocl.js';

export const TOOL_STATUSES = ['ok', 'failed', 'denied', 'effect_unknown'];
export const APPROVAL_ARM_MS = 300;
export const KEY_REPEAT_MS = 400;
export const HELD_KEY_MS = 1500;

export const initialState = (over = {}) => ({
  history: [],
  blocks: [],
  turn: null,
  ctx: { agent: null, model: null, provider: null, endpoint: null, hat: null, conversationId: null },
  pending: [],      // client-side queue (Tab)
  steering: [],     // steer messages not yet accepted
  lastTurnId: null, // the newest turn begun here: a card from an older turn is stale
  lastAocl: null,  // QUOXON-AOCL: the last turn's normalised aocl.summary (for /aocl)
  waiting: [],      // approvals raised by ANOTHER conversation/session: a notice only, never a focused card (answered via /approvals)
  approvals: [],    // approval cards waiting for a human, first is shown; survive the turn that raised them
  running: [],      // approved from this terminal, result arrives asynchronously (polled)
  inbox: [],        // last /approvals listing
  verbose: 'on',
  doneCalls: {},
  background: 0,
  notify: { approvals: null, error: null },
  seenInbox: {},    // inbox item ids already shown as a card (event or poll), so a poll never re-raises one
  autoDrain: false,
  seq: 0,
  ...over
});

/**
 * The server mirrors every legacy `chunk` as a `text.delta` (chunk first). Per turn, text comes from
 * text.delta once the stream is known to be v1 (turn.started or any text.delta); legacy-only
 * streams keep using `chunk`. Returns { append, st } where st is { v1, lastChunk }.
 */
export function textGate(st, ev) {
  const g = st || { v1: false, lastChunk: null };
  if (ev.type === 'turn.started') return { append: false, st: { ...g, v1: true } };
  if (ev.type === 'chunk') {
    if (g.v1) return { append: false, st: g };
    return { append: Boolean(ev.content), st: { ...g, lastChunk: ev.content ?? null } };
  }
  if (ev.type === 'text.delta') {
    const mirrored = !g.v1 && g.lastChunk != null && g.lastChunk === ev.content;
    return { append: Boolean(ev.content) && !mirrored, st: { v1: true, lastChunk: null } };
  }
  return { append: false, st: g };
}

const tms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

/**
 * A pending inbox approval found by polling -> approval card, or null when it does not qualify.
 * Qualifies when created after `since` (the turn start, else app start), or raised on behalf of this
 * user, or in this conversation. The inbox list is already scoped to the signed-in user and org.
 */
export function cardFromInboxItem(it, { since = 0, userId = null, conversationId = null, now = 0 } = {}) {
  if (!it || !it.id) return null;
  const c = it.payload?.approval_context || {};
  const m = c.method || {};
  const created = tms(it.created_at ?? it.createdAt);
  const mine = Boolean(userId && c.on_behalf_of?.user_id && String(c.on_behalf_of.user_id) === String(userId));
  const here = Boolean(conversationId && c.on_behalf_of?.conversation_id === conversationId);
  if (!(created != null && created >= since) && !mine && !here) return null;
  // QUOXON-REVIEW: collector tool approvals mint the inbox item with aee_correlation_id = the approval id;
  // without it the card had no id, polling was skipped and every terminal approve read "timeout".
  const toolApproval = it.payload?.type === 'native_tool_approval';
  const approvalId = it.payload?.approval_id || it.approval_id || it.approvalId
    || (toolApproval ? (it.aee_correlation_id || it.aeeCorrelationId || null) : null) || null;
  const ob = c.on_behalf_of || {};
  const tool = m.tool || String(it.title || it.id);
  return {
    callId: `inbox:${it.id}`, inboxItemId: it.id, approvalId,
    tool, target: m.target || null, scope: null, risk: c.risk || null,
    url: it.dashboard_url || null, shownAt: now, undescribable: !m.tool || !m.target,
    // only an item that names THIS conversation is ours; anything else came from another session and must not take the keyboard
    foreign: !here,
    origin: String(ob.agent || ob.agent_id || ob.session_name || ob.session || (ob.conversation_id ? `conversation ${String(ob.conversation_id).slice(0, 8)}` : 'another session')),
    privileged: isPrivileged({ tool, risk: c.risk, flag: c.privileged === true || c.elevated === true || it.payload?.privileged === true, title: it.title })
  };
}

/** Where an inbox approval came from: its source label, else the payload source, else its type. */
export function approvalSourceLabel(it) {
  const c = it?.payload?.approval_context || {};
  return String(c.source_label || it?.payload?.source || it?.source || (c.requested_by && c.requested_by.agent_label) || it?.payload?.type || 'plugin or workflow');
}

/**
 * QUOXON-FW7: every open inbox approval, grouped for /approvals. 'this conversation' (names this conversation,
 * or already a card here), 'other sessions' (raised on behalf of another conversation or agent), and
 * 'plugins and workflows' (everything else, labelled by source). Empty groups are dropped.
 */
export function groupApprovals(items, { conversationId = null, cardIds = [] } = {}) {
  const g = { 'this conversation': [], 'other sessions': [], 'plugins and workflows': [] };
  for (const item of items || []) {
    const ob = item?.payload?.approval_context?.on_behalf_of || {};
    const label = approvalSourceLabel(item);
    // A card that names a conversation belongs here only when it is THIS one (a card shown in this window for another
    // conversation, e.g. a privileged hat.switch, is still "other sessions"). No conversation named: a card here counts.
    const mine = ob.conversation_id ? Boolean(conversationId) && ob.conversation_id === conversationId : cardIds.includes(item.id);
    if (mine) g['this conversation'].push({ item, label });
    else if (ob.conversation_id || ob.agent || ob.agent_id || ob.session_name || ob.session) g['other sessions'].push({ item, label: String(ob.session_name || ob.session || ob.agent || ob.agent_id || `conversation ${String(ob.conversation_id).slice(0, 8)}`) });
    else g['plugins and workflows'].push({ item, label });
  }
  return Object.entries(g).filter(([, v]) => v.length).map(([group, v]) => ({ group, items: v }));
}

/** Privileged/elevated grants (hat switches and anything the server marks privileged or elevated) need an explicit confirm. */
export function isPrivileged({ tool = '', risk = null, flag = false, title = '' } = {}) {
  if (flag === true) return true;
  if (String(tool) === 'hat.switch' || /^hat[ .]switch/i.test(String(title))) return true;
  return /privileged|elevated|critical/i.test(String(risk || ''));
}

let uid = 0;
const nid = () => ++uid;

const settled = (b) => b.kind === 'tool' ? b.status !== 'running' : b.kind !== 'text';

/** Move the settled prefix of live blocks into history. */
function flush(s, force = false) {
  const blocks = [...s.blocks];
  const out = [];
  while (blocks.length) {
    const b = blocks[0];
    const done = force || settled(b) || (b.kind === 'text' && blocks.length > 1);
    if (!done) break;
    blocks.shift();
    if (b.kind === 'text' && !b.text.trim()) continue;
    out.push(b);
  }
  return out.length || blocks.length !== s.blocks.length ? { ...s, history: [...s.history, ...out], blocks } : s;
}

/** Fold the turn's VOLT tool count and list into its AOCL summary (footer count, /aocl list). */
function withTools(sum, turn) {
  const t = turn?.toolsOffer;
  return t && t.offered != null ? { ...sum, toolsOffered: t.offered, toolsTotal: t.total, toolsList: t.list } : sum;
}
function note(s, text, tone = 'dim') {
  return { ...s, history: [...s.history, { id: nid(), kind: 'note', text, tone }] };
}

function addBlock(s, b) { return flush({ ...s, blocks: [...s.blocks, { id: nid(), ...b }] }); }

// Raw markdown of each answer, kept for /copy (history holds only the split, rendered blocks).
function recordRaw(s, content) {
  const id = s.turn?.id ?? '_';
  const a = s.answers || [];
  const last = a[a.length - 1];
  const next = last && last.id === id ? a.slice(0, -1).concat({ id, text: last.text + content }) : a.concat({ id, text: String(content) }).slice(-20);
  return { ...s, answers: next };
}

function appendText(s00, content) {
  const s0 = recordRaw(s00, content);
  const s = s0.turn && !s0.turn.sawText ? { ...s0, turn: { ...s0.turn, sawText: true } } : s0;
  const last = s.blocks[s.blocks.length - 1];
  if (last && last.kind === 'text') {
    let text = last.text + content;
    let history = s.history;
    // Completed markdown blocks leave the live region (-> <Static>); only the unfinished tail re-renders.
    if (s.blocks.length === 1 && text.length > 1) {
      const { settled, rest } = splitSettled(text);
      if (settled.trim()) { history = [...history, { id: nid(), kind: 'text', text: settled }]; text = rest; }
    }
    return { ...s, history, blocks: s.blocks.slice(0, -1).concat({ ...last, text }) };
  }
  return addBlock(s, { kind: 'text', text: content });
}

/** QUOXON-FW3: who a delegation targets. Server fields first; older servers only put agent_id=<id> in the summary. */
export function delegateInfo(ev) {
  if (ev.tool !== 'delegate_to_agent') return {};
  const id = ev.agent_id || (String(ev.summary || '').match(/\bagent_id=(\S+)/) || [])[1] || null;
  if (!id) return {};
  return { agentId: id, agentName: ev.agent_name || id, ...(ev.task_gist ? { taskGist: ev.task_gist } : {}) };
}

function upsertTool(s, ev, patch) {
  const i = s.blocks.findIndex(b => b.kind === 'tool' && b.callId === ev.call_id);
  if (i >= 0) {
    const cur = s.blocks[i];
    // started after finished (out of order): never downgrade a settled row
    const p = cur.status !== 'running' && patch.status === 'running' ? { summary: cur.summary || patch.summary, tool: cur.tool || patch.tool } : patch;
    const blocks = s.blocks.slice();
    blocks[i] = { ...cur, ...p };
    const done = p.status && p.status !== 'running' ? { ...s.doneCalls, [ev.call_id]: true } : s.doneCalls;
    return flush({ ...s, blocks, doneCalls: done });
  }
  // A row that already settled and left the live region: a late tool.started (out of order) or a duplicate finish is dropped.
  if (s.doneCalls[ev.call_id]) return s;
  let n = patch.status !== 'running' ? { ...s, doneCalls: { ...s.doneCalls, [ev.call_id]: true } } : s;
  if (n.turn) n = { ...n, turn: { ...n.turn, tools: n.turn.tools + 1 } };
  return addBlock(n, { kind: 'tool', callId: ev.call_id, tool: ev.tool, ...patch });
}

function finishRunning(s, status, detail) {
  const blocks = s.blocks.map(b => b.kind === 'tool' && b.status === 'running'
    ? { ...b, status, resultSummary: detail } : b);
  return { ...s, blocks };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One grey closing line from facts only (durations, counts, receipt ids). */
export function summarizeTurn(s, status, now) {
  const t = s.turn;
  const secs = t && now != null && t.startedAt != null ? Math.max(0, Math.round((now - t.startedAt) / 1000)) : null;
  const finished = t?.finishedTools || 0;
  const unknown = s.blocks.filter(b => b.kind === 'tool' && (b.status === 'running' || b.status === 'effect_unknown')).length;
  if (status === 'unconfirmed') return 'Ended without confirmation from the server';
  const head = status === 'interrupted' ? 'Interrupted' : status === 'failed' ? 'Failed' : 'Thought';
  const parts = [secs == null ? head : `${head} ${status === 'completed' ? 'for' : 'after'} ${secs}s`];
  if (t?.model) parts.push(t.model.length > 32 ? t.model.slice(0, 31) + '…' : t.model); // which model answered, as reported
  // Real server usage when it arrived; otherwise the estimate from streamed text; nothing when neither exists.
  const tk = turnTokens(t);
  if (tk > 0) parts.push(`${fmtTokens(tk)} tokens`);
  // A labelled estimate (cost_source, e.g. the claude CLI's own figure) is never shown as this turn's price; /cost explains it.
  const cost = t?.usage?.costSource || t?.viaCli ? null : fmtCost(t?.usage?.cost ?? normUsage(null, t?.doneCost).cost);
  if (cost) parts.push(cost);
  if (status === 'interrupted' || status === 'failed') {
    if (t?.tools) parts.push(`${plural(finished, 'tool')} finished`);
    if (unknown) parts.push(`${unknown} effect unknown`);
  } else if (t?.tools) parts.push(plural(t.tools, 'tool'));
  if (t?.approvals) parts.push(plural(t.approvals, 'approval'));
  const r = t?.receipts || [];
  if (r.length === 1) parts.push(`receipt ward:${r[0]}`);
  else if (r.length > 1) parts.push(`${r.length} receipts, last ward:${r[r.length - 1]}`);
  return parts.join(' · ');
}

function endTurn(s, status, now) {
  let n = s;
  if (status === 'interrupted' || status === 'failed' || status === 'unconfirmed') {
    n = finishRunning(n, 'effect_unknown', 'dispatched, no result received; verify before retrying');
  } else {
    n = finishRunning(n, 'effect_unknown', 'no result reported');
  }
  n = flush(n, true);
  const summary = summarizeTurn(s, status, now);
  if (status === 'interrupted') n = note(n, 'Interrupted. Nothing completed was undone.', 'warn');
  // unaccepted steers become queued items, in front
  let pending = n.pending;
  let steering = n.steering;
  if (steering.length) {
    pending = [...steering.map(x => ({ id: x.id, text: x.text })), ...pending];
    steering = [];
    n = note(n, 'Steering was not applied before the turn ended; queued instead.', 'warn');
  }
  n = { ...n, history: [...n.history, { id: nid(), kind: 'summary', text: summary }] };
  return {
    ...n, turn: null, pending, steering,
    // Only a confirmed-completed turn drains the queue; failed, interrupted or unconfirmed turns leave
    // the pending items visible for the human to send.
    autoDrain: status === 'completed' && pending.length > 0
  };
}

function reduceInner(s, a) {
  switch (a.type) {
    case 'user': // a submitted prompt
      return { ...s, history: [...s.history, { id: nid(), kind: 'user', text: a.text, queued: !!a.queued }] };
    case 'turn.begin':
      return { ...s, lastTurnId: a.turnId, turn: { id: a.turnId, status: 'running', startedAt: a.now, stage: null, activity: null, tools: 0, finishedTools: 0, approvals: 0, receipts: [], chars: 0, usage: null }, blocks: [], autoDrain: false };
    case 'note':
      return note(s, a.text, a.tone);
    case 'bang.out': // QUOXON-FW8: command output, shown as is (not note-painted); the transcript records only the action name
      return { ...s, history: [...s.history, { id: nid(), kind: 'bang', text: a.text }] };
    case 'tip': // a "did you know" tip (tips.js); text + the command to try
      return { ...s, history: [...s.history, { id: nid(), kind: 'tip', text: a.text, cmd: a.cmd }] };
    case 'notify':
      return { ...s, notify: { ...s.notify, ...a.patch } };
    case 'welcome':
      return { ...s, history: [...s.history, { id: nid(), kind: 'welcome', version: a.version }] };
    case 'help':
      return { ...s, history: [...s.history, { id: nid(), kind: 'help', model: a.model }] };
    case 'object': // inline object view (objects/): pure data, rebuilt at render width
      return { ...s, history: [...s.history, { id: nid(), kind: 'object', obj: a.obj }] };
    case 'error':
      return flush(addBlock(s, { kind: 'error', text: a.text }), false);
    case 'verbose':
      return { ...s, verbose: a.mode };
    case 'aocl.table': // /aocl: the last turn's per-layer table, on demand
      return { ...s, history: [...s.history, { id: nid(), kind: 'aocl', table: true, sum: s.lastAocl || null }] };
    case 'history.add': // restored turns (/resume): ordinary history items, plus their answers for /copy
      return { ...s, history: [...s.history, ...(a.items || []).map(i => ({ id: nid(), ...i }))], answers: [...(s.answers || []), ...(a.answers || [])].slice(-20) };
    case 'history.reset': // /clear: a fresh screen; nothing on the server is touched
      return s.turn ? s : { ...s, history: [], blocks: [], answers: [] };
    case 'ctx':
      return { ...s, ctx: { ...s.ctx, ...a.ctx } };
    case 'resume': { // QUOXON J2: open an existing conversation; its saved turns become the visible history
      const items = [];
      for (const t of a.turns || []) {
        if (t.role === 'user') items.push({ id: nid(), kind: 'user', text: String(t.content ?? ''), queued: false });
        else if (t.role === 'assistant') items.push({ id: nid(), kind: 'text', text: String(t.content ?? '') });
      }
      const n = items.filter((x) => x.kind === 'user').length;
      const s2 = { ...s, ctx: { ...s.ctx, conversationId: a.conversationId }, history: [...s.history, ...items] };
      return note(s2, `Resumed conversation ${a.conversationId} (${n} earlier turn${n === 1 ? '' : 's'}). New messages continue it.`);
    }
    case 'inbox':
      return { ...s, inbox: a.items };
    case 'queue.add':
      return { ...s, pending: [...s.pending, { id: nid(), text: a.text }] };
    case 'queue.remove':
      return { ...s, pending: s.pending.filter(p => p.id !== a.id) };
    case 'queue.shift':
      return { ...s, pending: s.pending.slice(1), autoDrain: false };
    case 'queue.pop': // Up pulls the last item back to the composer
      return { ...s, pending: s.pending.slice(0, -1) };
    case 'steer.add':
      return { ...s, steering: [...s.steering, { id: a.id, text: a.text }] };
    case 'steer.converted': {
      const item = s.steering.find(x => x.id === a.id);
      if (!item) return s;
      const n = note({ ...s, steering: s.steering.filter(x => x.id !== a.id), pending: [...s.pending, { id: item.id, text: item.text }] },
        a.reason || 'Steering is not available for this turn; queued instead.', 'warn');
      return { ...n, autoDrain: !n.turn };
    }
    case 'steer.failed': { // ambiguous or denied: never auto-queued; the text goes back to the draft (the app does that)
      if (!s.steering.some(x => x.id === a.id)) return s;
      return note({ ...s, steering: s.steering.filter(x => x.id !== a.id) }, a.reason, 'warn');
    }
    case 'interrupt.requested':
      return s.turn ? { ...s, turn: { ...s.turn, status: 'interrupting' } } : s;
    case 'turn.deferred': // QUOXON-FW3: the send never reached the server; end the turn quietly (no failure summary, nothing ran)
      return { ...s, turn: null, blocks: [], autoDrain: false };
    case 'stopped.local': { // SSE aborted by us because the server has no interrupt route
      let n = note(s, 'Stopped locally; work already sent may still finish. Verify before retrying.', 'warn');
      return endTurn(n, 'interrupted', a.now);
    }
    case 'approval.found': { // pending approval seen by polling (covers provider paths that emit no approval.requested)
      const card = cardFromInboxItem(a.item, { since: s.turn?.startedAt ?? a.since ?? 0, userId: a.userId, conversationId: s.ctx.conversationId, now: a.now || 0 });
      if (!card || s.seenInbox[card.inboxItemId] || s.approvals.some(x => x.inboxItemId === card.inboxItemId || (card.approvalId && x.approvalId === card.approvalId))) return s;
      if (card.foreign) { // another conversation's card: a compact notice, never the focused card
        if (s.waiting.some(x => x.inboxItemId === card.inboxItemId)) return s;
        return { ...s, waiting: [...s.waiting, card] };
      }
      return { ...s, approvals: [...s.approvals, { ...card, turnId: s.turn?.id ?? null }], seenInbox: { ...s.seenInbox, [card.inboxItemId]: true }, turn: s.turn ? { ...s.turn, approvals: s.turn.approvals + 1 } : s.turn };
    }
    case 'approval.dismiss':
      return { ...s, approvals: s.approvals.filter(x => x.callId !== a.callId) };
    case 'approval.sent': { // the human answered from this terminal
      const rest = { ...s, approvals: s.approvals.filter(x => x.callId !== a.callId), waiting: s.waiting.filter(x => x.callId !== a.callId && x.inboxItemId !== a.callId) };
      if (a.quiet && a.action === 'approve') return rest;
      if (a.action !== 'approve') return note(rest, `denied: ${a.tool || 'approval'}${a.target ? ` on ${a.target}` : ''}`, 'warn');
      if (a.tool === 'hat.switch') { // applied server-side by the inbox approve; nothing to wait for
        const to = String(a.target || '').split('\u2192').pop().replace(/\(privileged\)/, '').trim() || 'the new hat';
        return note(rest, `Hat switched to ${to}. Ask again and I'll carry on.`, 'ok');
      }
      const run = { callId: a.callId, approvalId: a.approvalId || null, tool: a.tool, target: a.target };
      return note({ ...rest, running: [...rest.running.filter(x => x.callId !== a.callId), run] },
        `approved; running (result arrives asynchronously)${a.tool ? `: ${a.tool}${a.target ? ` on ${a.target}` : ''}` : ''}`, 'ok');
    }
    case 'approval.result': { // outcome of polling GET /api/v1/approvals/:id/result
      const run = s.running.find(x => x.callId === a.callId);
      const n = { ...s, running: s.running.filter(x => x.callId !== a.callId) };
      const what = run ? `${run.tool || 'approval'}${run.target ? ` on ${run.target}` : ''}` : 'approval';
      if (a.outcome === 'done') return note(n, `result: ${what}: ${a.text || 'completed'}`, 'ok');
      if (a.outcome === 'failed') return note(n, `failed: ${what}: ${a.text || 'error'}`, 'warn');
      if (a.outcome === 'denied') return note(n, `denied: ${what}`, 'warn');
      // FW4: never silent and never a guess. Say what is unknown and where the authoritative answer is.
      const check = run && run.approvalId ? `quox approvals result ${run.approvalId} (or /approvals)` : '/approvals (no approval id was returned, so it cannot be tracked from here)';
      return note(n, `result not known yet: ${what}; approved, but the server has not said whether it ran. It may still be running or may have run. Check: ${check}`, 'warn');
    }
    case 'inbox.sync': { // open approval ids from a successful inbox refresh
      const ids = new Set(a.ids);
      const approvals = s.approvals.filter(x => !x.inboxItemId || ids.has(x.inboxItemId) || (a.now || 0) - x.shownAt < 5000);
      const waiting = s.waiting.filter(x => ids.has(x.inboxItemId));
      return approvals.length === s.approvals.length && waiting.length === s.waiting.length ? s : { ...s, approvals, waiting };
    }
    case 'event':
      return reduceEvent(s, a.ev, a.now || 0);
    default:
      return s;
  }
}

/** The first card is armed from the moment it is actually SHOWN, not from when it was received. */
export function reduce(s, a) {
  let n = reduceInner(s, a);
  // The honest activity word: only real events move it (see activity.js).
  if (n.turn) {
    const act = a.type === 'event' ? nextActivity(s.turn?.act, a.ev, a.now || 0, { hasText: Boolean(n.turn.chars) })
      : actionActivity(n.turn.act, a, a.now || 0);
    if (act !== n.turn.act) n = { ...n, turn: { ...n.turn, act } };
  }
  const first = n.approvals[0];
  if (first && first.displayedAt == null) {
    return { ...n, approvals: [{ ...first, displayedAt: a.now || 0 }, ...n.approvals.slice(1)] };
  }
  return n;
}

function reduceEvent(s, ev, now) {
  switch (ev.type) {
    case 'connected': return s;
    // TODO(contract v2): background.status is not in events v1; wire here once the server defines it.
    case 'turn.started': {
      const ctx = {
        agent: ev.agent ?? s.ctx.agent, model: ev.model ?? s.ctx.model, provider: ev.provider ?? s.ctx.provider,
        // B3: the host a self-hosted provider ran at; cleared when the server names none.
        endpoint: ev.provider ? (ev.endpoint ?? null) : (s.ctx.endpoint ?? null),
        // QUOXON-PARITY: which Claude path ran (subscription CLI vs API key); cleared like endpoint.
        auth: ev.provider ? (ev.auth ?? null) : (s.ctx.auth ?? null),
        hat: ev.hat ?? s.ctx.hat, conversationId: ev.conversation_id ?? s.ctx.conversationId
      };
      // The model THIS turn actually used, as the server reported it (never the profile's default).
      const used = ev.model || ev.provider || null;
      return { ...s, ctx, turn: s.turn ? { ...s.turn, gate: textGate(s.turn.gate, ev).st, ...(used ? { model: String(used) } : {}) } : s.turn };
    }
    case 'thinking': {
      const stage = ev.stage || '';
      const msg = String(ev.message || '');
      if (!s.turn) return s;
      const turn = { ...s.turn, stage: msg || stage, activity: stage.includes('tool') && !s.blocks.some(b => b.kind === 'tool' && b.status === 'running') ? msg : s.turn.activity };
      let n = { ...s, turn };
      // B3: a provider fact the user should see (e.g. "this model does not support tools"), always, dim.
      if (stage === 'provider_note' && msg) return addBlock(n, { kind: 'note', text: msg, tone: 'dim' });
      // QUOXON: the model's own reasoning text: one dim, collapsed line (size only); verbose full
      // expands it. It is never answer text.
      if (stage === 'model_reasoning') {
        const why = String(ev.reasoning || '').trim();
        const text = s.verbose === 'full' && why ? `thinking: ${why}` : (msg || 'thinking');
        return addBlock(n, { kind: 'note', text, tone: 'dim', collapsed: !(s.verbose === 'full' && why) });
      }
      // Legacy servers report tool use only as a thinking stage: show it honestly, with no result claimed.
      if (stage.includes('tool') && msg) n = addBlock(n, { kind: 'note', text: `working: ${msg}`, tone: 'dim', legacyTool: true });
      if (s.verbose === 'full' && msg && !stage.includes('tool')) n = addBlock(n, { kind: 'note', text: `thinking: ${msg}`, tone: 'dim' });
      return n;
    }
    case 'chunk': case 'text.delta': {
      const g = textGate(s.turn?.gate, ev);
      const n = s.turn ? { ...s, turn: { ...s.turn, gate: g.st } } : s;
      if (!g.append) return n;
      const counted = n.turn ? { ...n, turn: { ...n.turn, chars: (n.turn.chars || 0) + String(ev.content).length } } : n;
      return appendText(counted, ev.content);
    }
    // QUOXON C5 (events v1.1): the client's own reconnect facts around a dropped durable turn.
    case 'reconnecting':
      return ev.attempt === 1 && s.turn ? addBlock(s, { kind: 'note', text: 'Connection to the server dropped; reconnecting. Quox keeps working on the turn meanwhile.', tone: 'warn' }) : s;
    case 'resumed':
      return s.turn ? addBlock(s, { kind: 'note', text: ev.after ? `Reconnected; picking up after event ${ev.after}.` : 'Reattached to the running turn.', tone: 'dim' }) : s;
    case 'replay.gap':
      return addBlock(s, { kind: 'note', text: `Events ${ev.from} to ${ev.to} of this turn were not kept on the server (size cap); the rest follows.`, tone: 'warn' });
    case 'tool.started':
      return upsertTool(s, ev, { status: 'running', summary: ev.summary || ev.tool, startedAt: now, ...delegateInfo(ev) });
    case 'tool.finished': {
      const status = TOOL_STATUSES.includes(ev.status) ? ev.status : 'unknown'; // never green for a status we do not know
      const first = !s.doneCalls[ev.call_id] && ['ok', 'failed', 'denied'].includes(status);
      let withTool = upsertTool(s, ev, {
        status, resultSummary: ev.result_summary, durationMs: ev.duration_ms,
        envelopeId: ev.envelope_id, receipt: ev.receipt || null,
        ...(Number.isFinite(ev.tools_used) ? { toolsUsed: ev.tools_used } : {})
      });
      if (first && withTool.turn) withTool = { ...withTool, turn: { ...withTool.turn, finishedTools: withTool.turn.finishedTools + 1 } };
      if (ev.receipt && ev.receipt.verified === true && withTool.turn && ev.receipt.ward_seq != null) {
        return { ...withTool, turn: { ...withTool.turn, receipts: [...withTool.turn.receipts, ev.receipt.ward_seq] } };
      }
      return withTool;
    }
    case 'approval.requested': {
      const card = {
        callId: ev.call_id, inboxItemId: ev.inbox_item_id, approvalId: ev.approval_id, tool: ev.tool,
        target: ev.target, scope: ev.scope, risk: ev.risk, url: ev.dashboard_url, shownAt: now,
        undescribable: ev.describable === false || !ev.target,
        turnId: s.turn?.id ?? ev.turn_id ?? null, // the turn this card arrived in (a stream event is always this conversation)
        privileged: isPrivileged({ tool: ev.tool, risk: ev.risk, flag: ev.privileged === true || ev.elevated === true })
      };
      if (s.approvals.some(x => x.callId === card.callId)) return s;
      const dup = s.approvals.findIndex(x => (card.inboxItemId && x.inboxItemId === card.inboxItemId) || (card.approvalId && x.approvalId === card.approvalId));
      if (dup >= 0) { // already raised by the poll: adopt the event's call id so approval.resolved finds it
        const approvals = s.approvals.slice(); approvals[dup] = { ...approvals[dup], callId: card.callId };
        return { ...s, approvals };
      }
      const wi = card.inboxItemId ? s.waiting.findIndex(x => x.inboxItemId === card.inboxItemId) : -1;
      if (wi >= 0) s = { ...s, waiting: s.waiting.filter((_, i) => i !== wi) }; // the stream says it is ours after all
      if (card.inboxItemId && s.seenInbox[card.inboxItemId]) return s; // already shown and answered
      return { ...s, seenInbox: card.inboxItemId ? { ...s.seenInbox, [card.inboxItemId]: true } : s.seenInbox, approvals: [...s.approvals, card], turn: s.turn ? { ...s.turn, approvals: s.turn.approvals + 1 } : s.turn };
    }
    case 'approval.resolved': {
      const card = s.approvals.find(x => x.callId === ev.call_id);
      const n = { ...s, approvals: s.approvals.filter(x => x.callId !== ev.call_id) };
      return card || ev.decision ? note(n, `${ev.decision === 'approved' ? '✔ approved by you' : `approval ${ev.decision || 'resolved'}`}${card ? `: ${card.tool} on ${card.target}` : ''}`, ev.decision === 'approved' ? 'ok' : 'warn') : n;
    }
    case 'steer.accepted': {
      const i = s.steering.findIndex(x => x.text === ev.text);
      const steering = i >= 0 ? s.steering.filter((_, k) => k !== i) : s.steering.slice(1);
      return addBlock({ ...s, steering }, { kind: 'note', text: `steered: ${ev.text}`, tone: 'accent' });
    }
    case 'trace':
      // QUOXON-AOCL: per-layer AOCL rows fold into ONE line per turn (aocl.summary); /aocl shows the table.
      if (ev.protocol === 'volt' && /tools offered/i.test(ev.label || '')) { // kept for the footer count and /aocl, shown only in verbose
        const m = String(ev.label).match(/(\d+)\s+of\s+(\d+)/);
        const list = String(ev.detail || '');
        const toolsOffered = m ? Number(m[1]) : (list ? list.split(/,\s*/).filter(Boolean).length : null);
        if (s.turn) s = { ...s, turn: { ...s.turn, toolsOffer: { offered: toolsOffered, total: m ? Number(m[2]) : null, list } } };
      }
      if (isLayerTrace(ev)) return s.turn ? { ...s, turn: { ...s.turn, aoclTraces: [...(s.turn.aoclTraces || []), { label: ev.label, detail: ev.detail }] } } : s;
      if (s.verbose === 'off') return s;
      return addBlock(s, { kind: 'trace', protocol: ev.protocol, label: ev.label, ref: ev.ref, detail: ev.detail });
    case 'aocl.summary': {
      const sum = withTools(normaliseSummary(ev), s.turn);
      const n = { ...s, lastAocl: sum, turn: s.turn ? { ...s.turn, aoclSummary: true } : s.turn };
      return addBlock(n, { kind: 'aocl', sum }); // the one-line footer shows at every verbosity
    }
    case 'aocl.verdict': {
      const v = verdictNote(ev);
      return v.tone === 'error' ? addBlock(s, { kind: 'error', text: v.text }) : addBlock(s, { kind: 'note', text: v.text, tone: v.tone });
    }
    case 'error': {
      const n = addBlock(s, { kind: 'error', text: isConsentError(ev) ? consentErrorText(ev) : String(ev.error || 'stream error') });
      return n;
    }
    case 'turn.finished': case 'done': {
      if (!s.turn) return s; // dedupe: done after turn.finished
      let n = s;
      const convo = ev.conversation_id || ev.session_id;
      if (convo) n = { ...n, ctx: { ...n.ctx, conversationId: convo } };
      if (ev.type === 'done' && !n.turn.sawText && ev.full_response) {
        n = appendText(n, ev.full_response);
      }
      // `done` only carries text/session; turn.finished (sent just after it) ends the turn. A legacy
      // server never sends turn.finished: the app synthesises one when the stream closes.
      // usage: `done` may carry cost_usd; turn.finished carries `usage` (input/output tokens, maybe cost_usd).
      // cli_session_id on `done` = the claude CLI path: its cost is that CLI's own estimate even from a server that
      // does not label it yet (cost_source 'claude-cli', R3 D5).
      if (ev.type === 'done') return { ...n, turn: { ...n.turn, doneCost: ev.cost_usd, viaCli: Boolean(ev.cli_session_id) } };
      // An older server sends per-layer AOCL traces and no aocl.summary: fold them into the one line here.
      if (!n.turn.aoclSummary && n.turn.aoclTraces?.length) {
        const sum = withTools(summaryFromTraces(n.turn.aoclTraces), n.turn);
        n = { ...n, lastAocl: sum };
        n = addBlock(n, { kind: 'aocl', sum });
      }
      n = { ...n, turn: { ...n.turn, usage: normUsage(n.turn.viaCli && ev.usage && !ev.usage.cost_source ? { ...ev.usage, cost_source: 'claude-cli' } : ev.usage, n.turn.doneCost) } };
      return endTurn(n, ev.status || 'completed', now);
    }
    default:
      return s;
  }
}

/**
 * Approval key guard: dialog arms after 300 ms, ignores held keys (any key
 * seen within KEY_REPEAT_MS), and the caller must never map Enter to approve.
 */
export function approvalKeyAllowed({ now, shownAt, lastKeyAt, heldKey = null, ch = null }) {
  if (now - shownAt < APPROVAL_ARM_MS) return false;
  // a fresh press needs a release gap: any key within KEY_REPEAT_MS is a held/repeat sequence
  if (lastKeyAt != null && now - lastKeyAt < KEY_REPEAT_MS) return false;
  // the key that was already down when the card appeared stays dead until another key or a long gap
  if (heldKey != null && ch === heldKey && (lastKeyAt == null || now - lastKeyAt < HELD_KEY_MS)) return false;
  return true;
}
