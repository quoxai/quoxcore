'use strict';
/**
 * CLI-QUOXON Q2: per-turn identity and event stamping for POST /chat/stream
 * (contract: docs/QUOXON_EVENTS_v1.md).
 *
 * Additive by construction: `send()` passes every pre-existing event through
 * byte-identical (the dashboard depends on connected/thinking/chunk/done/error)
 * and only OBSERVES it. New event types go through `emit()`, which stamps
 * type + turn_id + ts. `chunk` is mirrored as `text.delta`.
 */

// ULID (26) or the existing query_id shape QXN_<ts>_<rand>; no spaces, no path chars.
const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

/**
 * @param {object} sp stream params (body or query)
 * @returns {{ok:true, turnId:string, explicit:boolean, conversationId:string|null}|{ok:false, error:string}}
 */
function resolveTurnIdentity(sp = {}) {
  const conversationId = firstString(sp.session_id) || firstString(sp.conversation_id) || null;
  if (sp.turn_id !== undefined && sp.turn_id !== null && sp.turn_id !== '') {
    if (typeof sp.turn_id !== 'string' || !TURN_ID_RE.test(sp.turn_id)) {
      return { ok: false, error: 'invalid_turn_id' };
    }
    return { ok: true, turnId: sp.turn_id, explicit: true, conversationId };
  }
  return { ok: true, turnId: String(sp.query_id), explicit: false, conversationId };
}

/**
 * R1 #12-#14: every turn has a conversation id from the first frame. A client
 * that sent none gets a server-generated one (QXC_ prefix, deliberately NOT
 * UUID-shaped so it can never be passed to the Claude CLI as --resume).
 */
function ensureConversationId(identity) {
  if (!identity || !identity.ok || identity.conversationId) return identity && { ...identity, generated: false };
  return { ...identity, conversationId: `QXC_${require('crypto').randomUUID()}`, generated: true };
}

/** Governed tools on the OpenAI stream are opt-in: explicit turn_id AND tools not disabled. */
function wantsGovernedTools(sp, turnIdentity) {
  if (!turnIdentity || !turnIdentity.explicit) return false;
  const t = sp ? sp.tools : undefined;
  return !(t === false || t === 'false' || t === '0' || t === 0);
}

function firstString(v) {
  return typeof v === 'string' && v ? v : null;
}

// timing (QUOXON-LATENCY, optional): a lib/turnTiming.js record; finish() emits its
// summary as turn.timing just before turn.finished and logs it once.
function createTurnStream({ turnId, conversationId = null, write, now = () => new Date().toISOString(), timing = null, log = console }) {
  const state = { started: false, finished: false, failed: false, interrupted: false, startedAt: Date.now(), usage: null };

  const stamp = (type, fields) => ({ type, turn_id: turnId, ts: now(), ...fields });
  const emit = (type, fields = {}) => write(stamp(type, fields));

  function send(data) {
    if (data && data.type === 'error') state.failed = true;
    write(data);
    if (data && data.type === 'chunk' && typeof data.content === 'string') {
      emit('text.delta', { content: data.content });
    }
  }

  // endpoint: the host a self-hosted provider (ollama) was called at; omitted otherwise.
  function started({ agent = null, provider = null, model = null, hat = null, endpoint = null } = {}) {
    if (state.started) return;
    state.started = true;
    emit('turn.started', { conversation_id: conversationId, agent, provider, model, hat, ...(endpoint ? { endpoint: String(endpoint).slice(0, 120) } : {}) });
  }

  // Protocol moments (aee/aocl/volt/ward) for verbose mode. Small, secret-free by construction.
  function trace({ protocol, label, ref = null, detail = '' }) {
    emit('trace', { protocol, label: String(label).slice(0, 80), ref, detail: String(detail).slice(0, 160) });
  }

  function markInterrupted() { state.interrupted = true; }

  // Real provider-reported numbers (tokens, cost) for turn.finished.usage. Callers pass
  // only what the provider reported; null fields stay null.
  function setUsage(u) { if (u && typeof u === 'object') state.usage = { ...u }; }

  // R1 #8: the Claude CLI process was killed mid-turn. A tool it had already dispatched may or
  // may not have landed; say so on the stream instead of leaving the claim only in the audit payload.
  function effectUnknown(message) {
    emit('turn.note', { kind: 'effect_unknown', status: 'effect_unknown', message: String(message || 'The turn was interrupted; effects of any in-flight tool are unknown.').slice(0, 300) });
  }

  // QUOXON handoff offer (2026-10-17): the attached agent lacks the tools this ask needs (lib/handoffSuggest.js).
  // At most once per turn, and only while the turn is open; the TUI shows it as a y/N card.
  function suggestHandoff(h) {
    if (!h || typeof h !== 'object' || state.finished || state.handoff) return;
    state.handoff = true;
    emit('turn.handoff_suggested', { handoff_suggested: h });
  }

  function finish() {
    if (!state.started || state.finished) return;
    state.finished = true;
    const status = state.interrupted ? 'interrupted' : (state.failed ? 'failed' : 'completed');
    if (timing) {
      try {
        emit('turn.timing', timing.summary());
        if (log && typeof log.log === 'function') log.log(timing.logLine(turnId));
      } catch { /* telemetry only */ }
    }
    emit('turn.finished', { status, conversation_id: conversationId, usage: { elapsed_ms: Date.now() - state.startedAt, ...(state.usage || {}) } });
  }

  return { send, emit, trace, started, finish, suggestHandoff, markInterrupted, setUsage, effectUnknown, state, turnId };
}

module.exports = { wantsGovernedTools, resolveTurnIdentity, ensureConversationId, createTurnStream, TURN_ID_RE };
