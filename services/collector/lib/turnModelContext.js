'use strict';
/**
 * QUOXON-PROOF (quox#822): what this turn runs on, as turn.started reported it.
 *
 * The stream route records { provider, model, agent, endpoint } when it emits
 * turn.started; read tools (llm_status) look it up by the turn's own org and
 * conversation id, so "which model are you on" is answered from the turn, never
 * guessed from the org's defaults. Keys are org-scoped: one org can never read
 * another org's turn. Bounded (LRU by insertion) with a TTL, in memory only; a miss
 * is reported as unknown, never filled in.
 */

const MAX_ENTRIES = 2000;
const TTL_MS = 6 * 60 * 60 * 1000;

const entries = new Map();

const keyOf = (orgId, conversationId) => `${orgId}\u0000${conversationId}`;
const clip = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));

function recordTurnModel({ orgId, conversationId, provider, model, agent, endpoint, auth } = {}, now = Date.now()) {
  if (!orgId || !conversationId) return false;
  const k = keyOf(orgId, conversationId);
  entries.delete(k);
  entries.set(k, {
    provider: clip(provider, 60),
    model: clip(model, 120),
    agent: clip(agent, 80),
    endpoint: clip(endpoint, 120),
    auth: clip(auth, 30),
    started_at: new Date(now).toISOString(),
    _at: now,
  });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return true;
}

function lookupTurnModel({ orgId, conversationId } = {}, now = Date.now()) {
  if (!orgId || !conversationId) return null;
  const e = entries.get(keyOf(orgId, conversationId));
  if (!e) return null;
  if (now - e._at > TTL_MS) { entries.delete(keyOf(orgId, conversationId)); return null; }
  const { _at, ...out } = e;
  return out;
}

/** The conversation id a tool call belongs to, from the turn ctx only. */
function conversationIdFromCtx(ctx) {
  if (!ctx) return null;
  return ctx.conversationId || ctx.session_id || ctx.effectiveSessionId || null;
}

function _reset() { entries.clear(); }

module.exports = { recordTurnModel, lookupTurnModel, conversationIdFromCtx, _reset, MAX_ENTRIES, TTL_MS };
