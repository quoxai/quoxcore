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

const { summarizeToolCall, summarizeToolResult, classifyToolStatus } = require('./conversationToolEvents.js');

const ACTIVITY_MAX_ITEMS = 10;
const ACTIVITY_MAX_CHARS = 1500;
const DECISION = { approved: 'approved', error: 'approved', denied: 'denied', expired: 'expired' };

function createGovernedStreamHooks({ turnStream, bridge, orgId, watchApproval } = {}) {
  const watch = typeof watchApproval === 'function' ? watchApproval : require('./turnApprovalWatch.js').watchApproval;
  let deltas = 0;
  let streamed = '';
  let closed = false;
  const notes = [];
  const unwatchers = [];
  const activity = []; // { call_id, line, outcome }
  // #817/#818: what tools actually returned this turn, for lib/answerGrounding.js (bounded).
  const evidence = [];
  let evidenceChars = 0;
  const EVIDENCE_MAX = 200000;
  const addEvidence = (v) => {
    if (evidenceChars >= EVIDENCE_MAX || v == null) return;
    let t;
    try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = String(v); }
    t = String(t).slice(0, EVIDENCE_MAX - evidenceChars);
    evidence.push(t);
    evidenceChars += t.length;
  };

  const emit = (type, fields) => { if (!closed) { try { turnStream.emit(type, fields); } catch { /* client write only */ } } };
  const forward = (ev) => { if (typeof bridge === 'function') { try { bridge(ev); } catch { /* client write only */ } } };
  const record = (callId, tool, input, outcome) => {
    const existing = activity.find((a) => a.call_id === callId);
    if (existing) { existing.outcome = outcome; return; }
    activity.push({ call_id: callId, line: summarizeToolCall(tool, input), outcome });
  };

  function onTextDelta(content) {
    if (closed || typeof content !== 'string' || !content) return;
    deltas++;
    streamed += content;
    emit('text.delta', { content });
  }

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
      addEvidence(result);
    }
    record(ev.call_id, ev.tool, ev.input, outcomeLine);
    notes.push(`Approval update: the held ${ev.tool} call (approval ${ev.approval_id}) was ${outcomeLine}. Earlier this turn it was reported as pending; use this outcome.`);
  }

  function onEvent(ev) {
    forward(ev);
    if (!ev || !ev.type) return;
    if (ev.type === 'tool.finished') {
      record(ev.call_id, ev.tool, ev.input, `${ev.status} (${summarizeToolResult(ev.result)})`);
      addEvidence(ev.result);
    } else if (ev.type === 'approval.requested') {
      record(ev.call_id, ev.tool, ev.input, 'held for approval');
      addEvidence({ approval_id: ev.approval_id, inbox_item_id: ev.inbox_item_id || null, tool: ev.tool });
      if (ev.approval_id && orgId && !closed) {
        unwatchers.push(watch({ approvalId: ev.approval_id, orgId }, (outcome) => onResolved(ev, outcome)));
      }
    }
  }

  function drainNotes() { return notes.splice(0, notes.length); }

  function activitySummary() {
    if (activity.length === 0) return '';
    let out = 'Tools used in this turn:';
    let shown = 0;
    for (const a of activity) {
      if (shown >= ACTIVITY_MAX_ITEMS) break;
      const line = `\n- ${a.line}: ${a.outcome}`.slice(0, 220);
      if (out.length + line.length > ACTIVITY_MAX_CHARS - 40) break;
      out += line;
      shown++;
    }
    if (shown < activity.length) out += `\n- and ${activity.length - shown} more`;
    return out;
  }

  function close() {
    closed = true;
    for (const u of unwatchers.splice(0)) { try { u(); } catch { /* ignore */ } }
  }

  return { onTextDelta, onEvent, drainNotes, activitySummary, evidenceText: () => evidence.join('\n'), deltaCount: () => deltas, streamedText: () => streamed, close };
}

module.exports = { createGovernedStreamHooks, ACTIVITY_MAX_CHARS };
