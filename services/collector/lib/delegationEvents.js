'use strict';
/**
 * GW-P1 — Canonical runtime delegation event protocol.
 *
 * ONE shape for "an orchestrator handed a sub-task to a specialist", emitted
 * from the REAL tool-execution moment (never from model prose). Every channel
 * (command screen first; phone / Discord / CLI next) consumes this same shape,
 * and every emit is witnessed as an AEE envelope reusing the EXISTING
 * quox.agent.delegate{,_result} intent vocabulary (src/lib/aee/intents.js).
 *
 * This module is the spine of GW-P1: the "delegating to X" line a user sees is
 * driven by delegation.accepted, which fires before the specialist runs. It is
 * a runtime fact, not a sentence the model chose to write.
 *
 * Kinds:
 *   delegation.accepted  — parent -> target, task accepted, specialist starting
 *   delegation.completed — target -> parent, result returned (success + tools)
 */

const DELEGATION_KIND = Object.freeze({
  ACCEPTED: 'delegation.accepted',
  COMPLETED: 'delegation.completed',
});

// Map each kind onto the pre-existing AEE agent-to-agent intents so the witness
// trail stays consistent with src/lib/aee/intents.js (AGENT_INTENTS).
const DELEGATION_INTENT = Object.freeze({
  'delegation.accepted': 'quox.agent.delegate',
  'delegation.completed': 'quox.agent.delegate_result',
});

const TASK_MAX = 180;
const ERROR_MAX = 200;

function _s(v) {
  if (typeof v === 'string') return v;
  return v == null ? '' : String(v);
}

function _truncate(v, n) {
  const s = _s(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Build the canonical delegation event object. Pure, no side effects.
 * @param {string} kind - DELEGATION_KIND.ACCEPTED | DELEGATION_KIND.COMPLETED
 * @param {object} fields - { parent, target, task, depth, corr, ts, success?, tools_used?, error? }
 * @returns {object} canonical event
 */
function buildDelegationEvent(kind, fields = {}) {
  if (kind !== DELEGATION_KIND.ACCEPTED && kind !== DELEGATION_KIND.COMPLETED) {
    throw new Error(`buildDelegationEvent: unknown kind "${kind}"`);
  }
  const evt = {
    kind,
    parent: _s(fields.parent) || 'quox',
    target: _s(fields.target) || 'unknown',
    task: _truncate(fields.task, TASK_MAX),
    depth: Number.isFinite(fields.depth) ? fields.depth : 1,
    corr: _s(fields.corr) || null,
    ts: fields.ts || new Date().toISOString(),
  };
  if (kind === DELEGATION_KIND.COMPLETED) {
    evt.success = fields.success !== false;
    evt.tools_used = Array.isArray(fields.tools_used) ? fields.tools_used : [];
    if (fields.error) evt.error = _truncate(fields.error, ERROR_MAX);
  }
  return evt;
}

/**
 * Emit the canonical delegation event across channels + witness it.
 * Never throws on a channel error — telemetry must not break the chat loop.
 * @param {object} deps - { emitAgentEvent?, storeAuditEnvelope? }
 * @param {string} kind - DELEGATION_KIND value
 * @param {object} fields - build fields + optional { sessionId, orgId } for routing
 * @returns {object} the built canonical event
 */
function emitDelegationEvent(deps = {}, kind, fields = {}) {
  const evt = buildDelegationEvent(kind, fields);
  const isDone = kind === DELEGATION_KIND.COMPLETED;

  const data = {
    parent: evt.parent,
    target: evt.target,
    task: evt.task,
    depth: evt.depth,
    ...(isDone ? { success: evt.success, tools_used: evt.tools_used, error: evt.error } : {}),
  };

  // Channel 1 — live agent-event bus (the command screen renders delegation.*).
  if (typeof deps.emitAgentEvent === 'function') {
    try {
      deps.emitAgentEvent({
        session_id: fields.sessionId || evt.corr || undefined,
        org_id: fields.orgId || undefined,
        agent_name: evt.parent,
        type: evt.kind,
        data,
        summary: isDone
          ? `${evt.target} → ${evt.parent} ${evt.success ? '✓' : '✗'}`
          : `${evt.parent} → ${evt.target}: ${evt.task}`,
      });
    } catch (err) {
      try { console.warn('[DelegationEvent] bus emit failed:', err.message); } catch { /* noop */ }
    }
  }

  // Channel 2 — AEE witness (reuse the existing agent-to-agent intents).
  if (typeof deps.storeAuditEnvelope === 'function') {
    try {
      deps.storeAuditEnvelope({
        type: 'event',
        from: `agent.${evt.parent}`,
        to: `agent.${evt.target}`,
        intent: DELEGATION_INTENT[kind],
        corr: evt.corr || undefined,
        payload: data,
      });
    } catch (err) {
      try { console.warn('[DelegationEvent] witness failed:', err.message); } catch { /* noop */ }
    }
  }

  return evt;
}

module.exports = { DELEGATION_KIND, DELEGATION_INTENT, buildDelegationEvent, emitDelegationEvent };
