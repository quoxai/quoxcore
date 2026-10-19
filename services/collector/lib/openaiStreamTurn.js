'use strict';
/**
 * CLI-QUOX B1: per-turn hooks that connect the governed OpenAI tool loop to the
 * conversation stream of POST /chat/stream (docs/QUOXON_EVENTS_v1.md).
 *
 *  - onTextDelta: each provider text fragment becomes one `text.delta` (no
 *    legacy `chunk` mirror; the route writes the single legacy chunk itself).
 *  - onEvent: tool.* / approval.requested go through the existing bridge; an
 *    approval raised in this turn is watched, and its resolution during the
 *    turn streams `approval.resolved` plus, when it ran, the tool result as
 *    `tool.finished` (R1 #30). The model hears about it at the next model
 *    boundary through drainNotes.
 *  - activitySummary: a bounded, scrubbed list of this turn's tool calls and
 *    outcomes, stored with the exchange so the next turn sees what was done.
 */

const { summarizeToolResult, classifyToolStatus } = require('./conversationToolEvents.js');

const { createActivityLog, ACTIVITY_MAX_CHARS } = require('./turnActivityLog.js');
const DECISION = { approved: 'approved', error: 'approved', denied: 'denied', expired: 'expired' };

function createGovernedStreamHooks({ turnStream, bridge, orgId, watchApproval, passthrough = null } = {}) {
  const watch = typeof watchApproval === 'function' ? watchApproval : require('./turnApprovalWatch.js').watchApproval;
  let deltas = 0;
  let streamed = '';
  let closed = false;
  const notes = [];
  const unwatchers = [];
  const activityLog = createActivityLog();
  // #817/#818: what tools actually returned this turn, for lib/answerGrounding.js (bounded).
  const evidence = [];
  const evidenceItems = []; // QUOXON-ENGINE class 2: { tool, text, ok } for the stale check
  let evidenceChars = 0;
  const EVIDENCE_MAX = 200000;
  const addEvidence = (v, tool) => {
    if (evidenceChars >= EVIDENCE_MAX || v == null) return;
    let t;
    try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = String(v); }
    t = String(t).slice(0, EVIDENCE_MAX - evidenceChars);
    evidence.push(t);
    if (tool) evidenceItems.push({ tool, text: t.slice(0, 4000), ok: !(v && typeof v === 'object' && v.success === false) });
    evidenceChars += t.length;
  };

  const emit = (type, fields) => { if (!closed) { try { turnStream.emit(type, fields); } catch { /* client write only */ } } };
  const forward = (ev) => { if (typeof bridge === 'function') { try { bridge(ev); } catch { /* client write only */ } } };
  const record = (callId, tool, input, outcome) => activityLog.record(callId, tool, input, outcome);

  const emitDelta = (content) => {
    if (closed || typeof content !== 'string' || !content) return;
    deltas++;
    streamed += content;
    emit('text.delta', { content });
  };
  // quox#1044: a specialist's list/table answer is shown verbatim (lib/delegatePassthrough.js);
  // the model's own text then goes through the gate (one framing line, the rest cut).
  const gate = passthrough && typeof passthrough.filter === 'function' ? passthrough : null;
  if (gate) gate.attach(emitDelta);

  function onTextDelta(content) {
    if (closed || typeof content !== 'string' || !content) return;
    emitDelta(gate ? gate.filter(content) : content);
  }

  // noteDelta: server-authored text (a grounding note) bypasses the gate; it is not model text.
  /** End of model text: release a buffered framing line. */
  function flush() { if (gate) emitDelta(gate.flush()); }

  function onResolved(ev, outcome) {
    if (closed) return;
    const decision = DECISION[outcome.status] || outcome.status;
    emit('approval.resolved', { call_id: ev.call_id, inbox_item_id: ev.inbox_item_id || null, approval_id: ev.approval_id, decision });
    let outcomeLine = decision === 'denied' ? 'denied by approver' : decision === 'expired' ? 'approval expired, not run' : decision;
    if (outcome.status === 'approved' || outcome.status === 'error') {
      const result = outcome.status === 'error' ? { success: false, ...(outcome.result || {}) } : (outcome.result || { success: true });
      const status = classifyToolStatus(result);
      const resultSummary = summarizeToolResult(result);
      emit('tool.finished', {
        call_id: ev.call_id, tool: ev.tool, status, result_summary: resultSummary,
        duration_ms: null, envelope_id: null, receipt: null, approval_id: ev.approval_id,
      });
      outcomeLine = `approved, ${status} (${resultSummary})`;
      addEvidence(result, ev.tool);
    }
    record(ev.call_id, ev.tool, ev.input, outcomeLine);
    notes.push(`Approval update: the held ${ev.tool} call (approval ${ev.approval_id}) was ${outcomeLine}. Earlier this turn it was reported as pending; use this outcome.`);
  }

  function onEvent(ev) {
    if (gate && ev && ev.type === 'tool.started') gate.onToolStarted();
    forward(ev);
    if (!ev || !ev.type) return;
    if (ev.type === 'tool.finished') {
      record(ev.call_id, ev.tool, ev.input, `${ev.status} (${summarizeToolResult(ev.result)})`);
      addEvidence(ev.result, ev.tool);
    } else if (ev.type === 'approval.requested') {
      record(ev.call_id, ev.tool, ev.input, 'held for approval');
      addEvidence({ approval_id: ev.approval_id, inbox_item_id: ev.inbox_item_id || null, tool: ev.tool });
      if (ev.approval_id && orgId && !closed) {
        unwatchers.push(watch({ approvalId: ev.approval_id, orgId }, (outcome) => onResolved(ev, outcome)));
      }
    }
  }

  function drainNotes() { return notes.splice(0, notes.length); }

  function activitySummary() { return activityLog.summary(); }

  function close() {
    closed = true;
    if (gate) gate.close();
    for (const u of unwatchers.splice(0)) { try { u(); } catch { /* ignore */ } }
  }

  return { onTextDelta, noteDelta: emitDelta, flush, onEvent, drainNotes, activitySummary, evidenceText: () => evidence.join('\n'), evidenceItems: () => evidenceItems.slice(), deltaCount: () => deltas, streamedText: () => streamed, close };
}

module.exports = { createGovernedStreamHooks, ACTIVITY_MAX_CHARS };
