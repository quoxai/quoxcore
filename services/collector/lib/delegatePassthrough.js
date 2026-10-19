'use strict';
/**
 * quox#1044: pass a specialist's list or table answer through to the user verbatim.
 *
 * A delegated "list every container" hop spent ~75 s writing a 115-row table, then the outer
 * turn spent as long again re-writing the same table. Ruling: when a delegate_to_agent answer is
 * a table or a list, the outer turn passes it through verbatim with at most one framing line and
 * never regenerates it.
 *
 * How (the same for every provider):
 *  1. A live streaming turn registers here (org + conversation + the outer agent) with a show()
 *     callback into its own stream. The registry is process-local: delegate_to_agent runs in this
 *     collector both on the API loops (in process) and on the Claude CLI path (via
 *     POST /api/v1/tools/execute, whose turn token pins the same conversation id).
 *  2. delegate_to_agent, on a successful list/table answer at depth 0, publishes the text: the
 *     turn streams it to the user the moment the specialist returns. Only when that succeeded is
 *     the tool result marked shown_to_user:'verbatim' with an answer_guidance telling the outer
 *     model to add at most one framing line. No live turn = nothing marked = the old behaviour.
 *  3. Enforcement is server-side, not trust in the model: the turn's passthrough gate lets ONE
 *     framing line of outer model text through after a passthrough and cuts the rest (a frame
 *     line that is itself a table row or list item is cut too). A later tool call re-opens the
 *     model's text, since that is new work, not the table again. The stored answer and the
 *     done frame are composed from exactly what the user was shown.
 *
 * Why cut rather than skip the outer generation: the Claude CLI path cannot be stopped mid-turn
 * without killing the process (an interrupt, with effect-unknown semantics), and the API loops
 * may still have later tool rounds to run. Cutting is identical on every provider and never
 * loses a later tool's result; the guidance keeps the model from spending the time at all.
 */

const FRAME_MAX = 240;
const LIST_MIN_LINES = 5;
// A GFM separator row: cells of dashes with optional alignment colons, at least one pipe.
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;
const LIST_LINE_RE = /^\s*(?:[-*+]|\d{1,4}[.)])\s+\S/;
const FRAME_REJECT_RE = /^\s*(?:\||[-*+]\s|\d{1,4}[.)]\s)/;
// QUOXON 2026-10-17: a frame line that only points back at the answer just shown ("HYPERION's
// read is above.", "See above.") repeats it; it is dropped like a re-written table row.
const FRAME_BACKREF_RE = /\b(?:is|are|see|shown|listed|as)\s+above\b|\babove\s*[.!\u2026]*\s*$/i;
// Live 2026-10-17 21:40: a frame line re-citing two or more figures from the answer just shown is a
// recap of it ("dev at 97%, siem at 97% and pool at 96%"), not framing: dropped.
const FIGURE_RE = /\d+(?:\.\d+)?%|\d+\.\d+/g;
function recapsShown(line, shown) {
  if (!shown) return false;
  // By value at the frame's own precision: "97%" re-cites a shown "96.7%".
  const have = (String(shown).match(FIGURE_RE) || []).map((x) => parseFloat(x));
  let hits = 0;
  for (const f of String(line).match(FIGURE_RE) || []) {
    const d = (f.replace('%', '').split('.')[1] || '').length;
    const v = parseFloat(f);
    if (have.some((h) => Number(h.toFixed(d)) === v)) hits += 1;
  }
  return hits >= 2;
}
const rejectFrame = (line, shown = '') => FRAME_REJECT_RE.test(line) || FRAME_BACKREF_RE.test(line) || recapsShown(line, shown);

const ANSWER_GUIDANCE = 'This specialist answer has already been shown to the user verbatim, in full. '
  + 'Reply with at most ONE short framing line (for example what it is, or a count). '
  + 'Do not repeat, reformat, summarise or re-list it, and do not point back at it ("see above"); anything past one line is cut.';

// quox#1044 honesty: in a PARTIAL turn (a delegation breached), the outer text must not claim
// completeness. The rule rides on the breach tool result; rewriteCompleteness enforces it.
const PARTIAL_WORDING_RULE = 'Do not call it complete, full, entire or whole, and do not say all, every or total: '
  + "say 'N found so far, of an unknown total'.";
const KEEP_LINE_RE = /^\s*\||still (coming|working|running|in progress)|will (be posted|arrive|follow)|\bpending\b/i;

/** Rewrite completeness claims in one line of a partial turn's text (table rows untouched). */
function rewriteLine(line) {
  if (!line || KEEP_LINE_RE.test(line)) return line;
  let out = line;
  // "all 90 containers" / "all of the 90 hosts" -> "90 containers found so far (partial)"
  out = out.replace(/\b(all)\s+(?:of\s+(?:the\s+)?)?(\d[\d,]*)\s+([A-Za-z][\w-]*)/gi, '$2 $3 found so far (partial)');
  // "a total of 90 containers" / "total of 90" -> "90 ... found so far"
  out = out.replace(/\b(?:a\s+)?total\s+of\s+(\d[\d,]*)(\s+[A-Za-z][\w-]*)?/gi, (m, n, noun) => `${n}${noun || ''} found so far`);
  // "Total: 90" -> "Found so far: 90"; "in total" -> "so far"
  out = out.replace(/\b(T|t)otal(\s*:)/g, (m, t, c) => `${t === 'T' ? 'F' : 'f'}ound so far${c}`);
  out = out.replace(/\bin total\b/gi, 'so far');
  // "every container" -> "each container found so far"
  out = out.replace(/\b(E|e)very\s+([A-Za-z][\w-]*)/g, (m, e, noun) => `${e === 'E' ? 'Each' : 'each'} ${noun} found so far`);
  // "the complete / full / entire / whole / comprehensive X" -> "the partial X" (not after "not")
  out = out.replace(/(?<!\bnot\s)(?<!\bnot yet\s)\b(C|c)omplete\b|\b(F|f)ull\b(?=\s+(?:inventory|list|fleet|set|picture|view|count|table|result|report))|\b(E|e)ntire\b|\b(W|w)hole\b|\b(C|c)omprehensive\b/g,
    (m) => (m[0] === m[0].toUpperCase() ? 'Partial' : 'partial'));
  // A leading lowercase result of "All 90 ..." at the start of a sentence stays readable as is.
  return out;
}

function rewriteCompleteness(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.split('\n').map(rewriteLine).join('\n');
}

/** A markdown table (a row followed by a separator row), or LIST_MIN_LINES+ list lines. */
function isListOrTable(text) {
  if (typeof text !== 'string' || !text) return false;
  const lines = text.split(/\r?\n/);
  let listLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && TABLE_SEP_RE.test(lines[i]) && lines[i - 1].includes('|')) return true;
    if (LIST_LINE_RE.test(lines[i])) listLines++;
  }
  return listLines >= LIST_MIN_LINES;
}

// ---------------------------------------------------------------------------
// Live-turn registry
// ---------------------------------------------------------------------------
const live = new Map(); // `${org}\0${conv}` -> { agentId, show }
const keyOf = (orgId, conv) => `${orgId}\u0000${conv}`;
const norm = (s) => String(s || '').trim().toLowerCase();

/** @returns {() => void} unregister */
function registerLiveTurn({ orgId, agentId, conversationIds = [], show, breach = null, progress = null } = {}) {
  if (!orgId || !agentId || typeof show !== 'function') return () => {};
  const entry = { agentId: norm(agentId), show, breach: typeof breach === 'function' ? breach : null, progress: typeof progress === 'function' ? progress : null };
  const keys = [...new Set((conversationIds || []).filter((c) => typeof c === 'string' && c))].map((c) => keyOf(orgId, c));
  for (const k of keys) live.set(k, entry);
  return () => { for (const k of keys) if (live.get(k) === entry) live.delete(k); };
}

/** Stream text to the live outer turn. True only when the turn accepted it. */
function publish({ orgId, conversationId, agentId, depth = 0, text } = {}) {
  if (!orgId || !conversationId || !agentId || (Number(depth) || 0) > 0) return false;
  if (typeof text !== 'string' || !text.trim()) return false;
  const entry = live.get(keyOf(orgId, conversationId));
  if (!entry || entry.agentId !== norm(agentId)) return false;
  try { return entry.show(text) === true; } catch { return false; }
}

/**
 * A delegation at depth 0 breached its wait: tell the live outer turn, so its answer is flagged
 * partial when it does not say so, and (late:true) the late specialist answer is held for it.
 * True only when a live turn took it.
 */
function notifyBreach({ orgId, conversationId, agentId, depth = 0, breach } = {}) {
  if (!orgId || !conversationId || !agentId || (Number(depth) || 0) > 0 || !breach) return false;
  const entry = live.get(keyOf(orgId, conversationId));
  if (!entry || !entry.breach || entry.agentId !== norm(agentId)) return false;
  try { return entry.breach(breach) === true; } catch { return false; }
}

// QUOXON 2026-10-17: a specialist runs in a nested loopback turn, so the live outer turn saw nothing
// for the whole delegation (70 s of silence on a 3-call proxmox read). Each REAL tool call made on the
// live turn's conversation by an agent other than the turn's own is forwarded as progress. The outer
// agent's own calls already stream as tool.started, so they are not forwarded.
const PROGRESS_DETAIL_RE = /^[A-Za-z0-9][\w.:-]{0,23}$/;
function agentDisplayName(id) {
  try {
    const a = require('./entityAssistantLoader').getAssistant(id);
    if (a && a.identity && typeof a.identity.name === 'string' && a.identity.name) return a.identity.name.slice(0, 40);
  } catch { /* display name is best-effort; the id is always true */ }
  return id;
}
/** executeTool hook. True only when a live outer turn took the progress event. */
function forwardDelegateProgress(toolName, input, ctx = {}) {
  const orgId = ctx && ctx.orgId;
  const conv = ctx && (ctx.session_id || ctx.conversationId);
  const agent = norm(ctx && ctx.agentId);
  if (!orgId || !conv || !agent || typeof toolName !== 'string' || !toolName) return false;
  const entry = live.get(keyOf(orgId, conv));
  if (!entry || !entry.progress || entry.agentId === agent) return false;
  const i = input && typeof input === 'object' ? input : {};
  const raw = [i.view, i.action, i.host, i.node, i.name].find((v) => typeof v === 'string' && v);
  const ev = { agent_id: agent, agent_name: agentDisplayName(agent), tool: toolName.slice(0, 64) };
  if (raw && PROGRESS_DETAIL_RE.test(raw)) ev.detail = raw;
  try { return entry.progress(ev) === true; } catch { return false; }
}

/** delegate_to_agent hook: publish a list/table answer; mark the result only if it was shown. */
function passthroughDelegateResult(result, ctx = {}) {
  if (!result || typeof result !== 'object' || result.success !== true || result.error) return result;
  // A held approval rides on this result: leave it exactly as the approval path expects.
  if (result.pending || result.needs_approval || result.approvalId || result.approval_id || result._approval) return result;
  if (!isListOrTable(result.response)) return result;
  const shown = publish({
    orgId: ctx.orgId, conversationId: ctx.session_id || ctx.conversationId, agentId: ctx.agentId,
    depth: ctx._delegationDepth || 0, text: result.response,
  });
  if (!shown) return result;
  return { ...result, shown_to_user: 'verbatim', answer_guidance: ANSWER_GUIDANCE };
}

// ---------------------------------------------------------------------------
// Per-turn gate
// ---------------------------------------------------------------------------
/**
 * One per streaming turn. attach(emit) wires it to the bridge's raw text.delta writer.
 * filter(delta) -> the part of a model delta the user may see. show(text) -> the passthrough.
 */
function createPassthroughGate() {
  let emitRaw = null;
  let closed = false;
  let used = false;
  let phase = 'open'; // open | lead | frame | done
  let frame = '';
  let shown = '';
  let suppressed = 0;

  const record = (s) => { if (s) shown += s; return s; };
  const sep = () => (shown && !/\n\n$/.test(shown) ? (shown.endsWith('\n') ? '\n' : '\n\n') : '');

  function attach(fn) { emitRaw = typeof fn === 'function' ? fn : null; }

  function show(text) {
    if (closed || !emitRaw || typeof text !== 'string' || !text) return false;
    // A line or frame line still buffered is released first.
    const pending = releaseLine() + releaseFrame();
    if (pending) emitRaw(pending);
    const out = sep() + text;
    try { emitRaw(out); } catch { return false; }
    record(out);
    used = true;
    phase = 'lead';
    frame = '';
    return true;
  }

  function releaseFrame() {
    if (phase !== 'frame' || !frame) return '';
    const line = frame.trim();
    frame = '';
    phase = 'done';
    if (!line || rejectFrame(line, shown)) { suppressed += line.length; return ''; }
    return record(`\n\n${partial() ? rewriteLine(line.slice(0, FRAME_MAX)) : line.slice(0, FRAME_MAX)}`);
  }

  // Partial turn: model text is released a line at a time, with completeness claims rewritten.
  let lineBuf = '';
  let rewrote = false;
  const partial = () => breaches.length > 0;
  function releaseLine() {
    if (!lineBuf) return '';
    const t = rewriteCompleteness(lineBuf);
    lineBuf = '';
    return record(t);
  }
  function filter(delta) {
    if (typeof delta !== 'string' || !delta) return '';
    // The late specialist answer was shown and the turn asked to stop: nothing the outer model
    // writes after that (a re-derivation of the same answer) reaches the user.
    if (lateEnded) { suppressed += delta.length; return ''; }
    if (phase === 'open') {
      if (!partial()) return record(delta);
      rewrote = true;
      lineBuf += delta;
      const cut = lineBuf.lastIndexOf('\n');
      if (cut === -1) return '';
      const done = lineBuf.slice(0, cut + 1);
      lineBuf = lineBuf.slice(cut + 1);
      return record(rewriteCompleteness(done));
    }
    if (phase === 'done') { suppressed += delta.length; return ''; }
    let out = '';
    for (let i = 0; i < delta.length; i++) {
      const ch = delta[i];
      if (phase === 'done') { suppressed += delta.length - i; break; }
      if (phase === 'lead') {
        if (/\s/.test(ch)) continue;
        phase = 'frame';
      }
      if (ch === '\n') {
        const line = frame.trim();
        frame = '';
        phase = 'done';
        if (line && !rejectFrame(line, shown)) out += record(`\n\n${partial() ? rewriteLine(line.slice(0, FRAME_MAX)) : line.slice(0, FRAME_MAX)}\n`);
        else suppressed += line.length;
        continue;
      }
      frame += ch;
      if (frame.length >= FRAME_MAX) out += releaseFrame();
    }
    return out;
  }

  /** End of model text: release a buffered line or an unterminated frame line. */
  function flush() {
    if (lateEnded) { suppressed += lineBuf.length + frame.length; lineBuf = ''; frame = ''; return ''; }
    return releaseLine() + releaseFrame();
  }

  /** A new tool call after a passthrough is new work: its later text is not cut. */
  function onToolStarted() {
    if (lateEnded) return;
    if (phase === 'open') {
      const held = releaseLine();
      if (held && emitRaw) { try { emitRaw(held); } catch { /* client write only */ } }
      return;
    }
    const pending = releaseFrame();
    if (pending && emitRaw) { try { emitRaw(pending); } catch { /* client write only */ } }
    phase = 'open';
    frame = '';
  }

  /** The answer to store: what the user was shown, when a passthrough happened. */
  function composeFinal(modelText) { return used || rewrote ? shown : modelText; }

  /** Non-streamed clients: run the whole final model text through the same one-frame-line rule. */
  function composeBatch(modelText) {
    if (!used) return partial() ? rewriteCompleteness(modelText) : modelText;
    filter(String(modelText || ''));
    flush();
    return shown;
  }

  // ---- breach (quox#1044 follow-up) --------------------------------------------------------
  const breaches = []; // { agent, waited_ms, handle, late }
  const lates = new Map(); // handle -> { agent, waited_ms, state: 'waiting'|'held'|'shown'|'released', s, fallback }
  let awaiting = null; // { wake } while awaitLate runs
  let lateEnded = false; // a late answer was shown mid-turn and the outer turn asked to stop
  const stopListeners = [];
  const lateListeners = [];
  function onLate(fn) { if (typeof fn === 'function') lateListeners.push(fn); }
  // The specialist's own tool calls ride on a delegation.late event when its late answer is shown,
  // built by the same rules as an on-time delegation's nested_tools (conversationToolEvents).
  function announceLate(l) {
    if (!lateListeners.length) return;
    let ev;
    try {
      const s = l.s || {};
      const nested = require('./conversationToolEvents.js').delegationResultFields('delegate_to_agent', { tool_outcomes: (s.result || {}).tool_outcomes });
      ev = { call_id: l.call_id || null, agent: l.agent, status: s.ok === true ? 'ok' : 'failed', nested_tools: nested.nested_tools || [] };
    } catch { return; }
    for (const fn of lateListeners) { try { fn(ev); } catch { /* a listener never breaks delivery */ } }
  }
  function onStop(fn) { if (typeof fn === 'function') stopListeners.push(fn); }
  function requestStop(why) {
    if (lateEnded) return;
    lateEnded = true;
    for (const fn of stopListeners) { try { fn(why); } catch { /* a listener never breaks delivery */ } }
  }

  function noteBreach(b) {
    if (closed || !b || !b.agent) return false;
    const rec = { agent: String(b.agent), waited_ms: Number(b.waited_ms) || 0, handle: b.handle || null, late: b.late === true, call_id: b.call_id || null };
    breaches.push(rec);
    if (rec.late && rec.handle && b.rec && typeof b.rec === 'object') {
      lates.set(rec.handle, { agent: rec.agent, waited_ms: rec.waited_ms, call_id: rec.call_id, state: 'waiting', s: null, fallback: null });
      b.rec.inlineDeliver = (settledValue, fallback) => deliverLate(rec.handle, settledValue, fallback);
    }
    return true;
  }

  // Called by lib/delegationLate.js when the specialist finishes. True = this turn owns showing it.
  function deliverLate(handle, settledValue, fallback) {
    const l = lates.get(handle);
    if (closed || !l || l.state !== 'waiting') return false;
    l.state = 'held';
    l.s = settledValue || null;
    l.fallback = typeof fallback === 'function' ? fallback : null;
    if (awaiting) { awaiting.wake(); return true; }
    // quox#1044 (WORKER1 CLI_1792137143765_3szs6r): landed while the outer model is still working.
    // Holding it until the turn's end let QUOX re-derive the same answer into the 285 s CLI kill.
    // Show it now, verbatim, and ask the outer turn to stop.
    if (emitRaw) {
      const pending = releaseLine() + releaseFrame();
      if (pending) { try { emitRaw(pending); } catch { /* client write only */ } }
      const t = lateText(handle, l);
      l.state = 'shown';
      used = true;
      announceLate(l);
      record(t);
      try { emitRaw(t); } catch { /* client write only */ }
      phase = 'done';
      requestStop('late_answer');
    }
    return true;
  }

  const secs = (ms) => `${Math.round((Number(ms) || 0) / 1000)} s`;
  const DISCLOSED_RE = /\b(partial|incomplete|not (yet )?(complete|finished|all|covered)|still (coming|working|running|in progress)|missing|\d+\s+of\s+\d+)\b/i;

  /** '' or a note that the answer is partial, when a delegation breached and the text does not say so. */
  function partialFlag(text) {
    if (!breaches.length || DISCLOSED_RE.test(String(text || ''))) return '';
    // Every breached specialist's full answer was shown in this turn: the answer is not partial.
    if (breaches.every((b) => b.late && b.handle && lates.get(b.handle) && lates.get(b.handle).state === 'shown')) return '';
    const b = breaches[0];
    const who = breaches.length > 1 ? `${b.agent} and ${breaches.length - 1} other specialist${breaches.length > 2 ? 's' : ''}` : b.agent;
    const coming = breaches.some((x) => x.late) ? ` Its full answer is still coming.` : ' Its full answer did not arrive.';
    return `\n\nPartial answer: ${who} did not answer within ${secs(b.waited_ms)}, so the answer above is not its full result and may be missing items (for example hosts it did not cover).${coming}`;
  }

  function lateText(handle, l) {
    const s = l.s || {};
    const r = s.result || {};
    if (s.ok && typeof r.response === 'string' && r.response.trim()) {
      return `\n\n${l.agent}'s full answer (it finished after the ${secs(l.waited_ms)} wait):\n\n${r.response}`;
    }
    const err = (s && (s.error || r.error)) || 'no result';
    return `\n\n${l.agent} finished but did NOT confirm success: ${String(err).slice(0, 300)}`;
  }

  /**
   * After the model's answer: wait (bounded) for late specialist answers and show them verbatim.
   * emit(text) writes to the user's stream. Returns all text appended (for the stored answer).
   */
  async function awaitLate({ ms = 60000, conversationId = null, emit = () => {}, signal = null } = {}) {
    if (closed) return '';
    const pendingOf = () => [...lates.entries()].filter(([, l]) => l.state === 'waiting' || l.state === 'held');
    if (!pendingOf().length) return '';
    let appended = '';
    const out = (t) => { if (!t) return; appended += t; shown += t; try { emit(t); } catch { /* client write only */ } };
    const showHeld = () => {
      for (const [h, l] of lates) if (l.state === 'held') { l.state = 'shown'; used = true; announceLate(l); out(lateText(h, l)); }
    };
    showHeld();
    if (lates.size && [...lates.values()].some((l) => l.state === 'waiting')) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); awaiting = null; if (signal) signal.removeEventListener?.('abort', onAbort); resolve(); };
        const onAbort = () => finish();
        const timer = setTimeout(finish, Math.max(0, Number(ms) || 0));
        awaiting = { wake: () => { showHeld(); if (![...lates.values()].some((l) => l.state === 'waiting')) finish(); } };
        if (signal) { if (signal.aborted) finish(); else signal.addEventListener?.('abort', onAbort, { once: true }); }
      });
    }
    if (signal && signal.aborted) return appended;
    for (const [h, l] of lates) {
      if (l.state !== 'waiting') continue;
      l.state = 'released';
      out(`\n\n${l.agent} is still working. Its full answer will be posted to this conversation when it finishes${conversationId ? `: read it with \`quox conversation get ${conversationId}\`` : ''} (handle ${h}).`);
    }
    return appended;
  }

  // The turn stored its final answer (which includes every shown late answer): no follow-up post needed.
  let committed = false;
  function commit() { committed = true; }

  function close() {
    closed = true;
    for (const l of lates.values()) {
      // Held, or shown but never stored with the turn (aborted): the conversation post still happens.
      if (l.state === 'held' || (l.state === 'shown' && !committed)) {
        l.state = 'released';
        if (l.fallback) { try { l.fallback(); } catch { /* best-effort */ } }
      } else if (l.state === 'waiting') l.state = 'released';
    }
    if (awaiting) awaiting.wake();
  }

  return {
    attach, show, filter, flush, onToolStarted, composeFinal, composeBatch, close,
    noteBreach, partialFlag, awaitLate, commit, onStop, onLate, stopRequested: () => lateEnded, breached: () => breaches.length > 0, lateWaiting: () => [...lates.values()].some((l) => l.state === 'waiting' || l.state === 'held'),
    used: () => used, shownText: () => shown, suppressedChars: () => suppressed,
  };
}

module.exports = {
  isListOrTable, rewriteCompleteness, PARTIAL_WORDING_RULE, registerLiveTurn, publish, notifyBreach, forwardDelegateProgress, passthroughDelegateResult, createPassthroughGate,
  ANSWER_GUIDANCE, FRAME_MAX,
};
