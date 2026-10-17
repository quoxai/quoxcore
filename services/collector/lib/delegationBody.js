'use strict';
/**
 * The nested /chat/claude request a delegate_to_agent call sends to the specialist.
 *
 * COMMANDERQ P7 (#3996): the delegator's tenant context (org_id/user_id, the already-verified pair from
 * the server-set tool ctx) rides along; _internal_delegation exempts this system hop from the per-hop
 * membership re-verify. Z2H-R4: the specialist runs on the same provider/model the delegating turn
 * named (an Ollama-only install had every delegation fail on the anthropic default). No provider on
 * the turn = none here = the server default, as before.
 */
function buildDelegationBody(input, ctx, agentId, depth) {
  return JSON.stringify({
    prompt: input.task,
    selected_agent: agentId,
    system_prompt: input.context ? `Context from QUOX: ${input.context}` : undefined,
    _delegation_depth: depth,
    org_id: ctx.orgId || undefined,
    user_id: ctx.userId || undefined,
    _internal_delegation: true,
    provider: ctx.llmProvider || undefined,
    model: ctx.llmProvider && ctx.llmModel ? ctx.llmModel : undefined,
    memory_context: ctx.memory_context || undefined,
    quox_context: ctx.quox_context || undefined,
    conversation_history: ctx.conversation_history || undefined,
    session_id: ctx.session_id || undefined,
    voice_mode: ctx.voice_mode || 'hal'
  });
}

/**
 * QUOXON-ASK J2 (quox#852): the loopback hop's headers. The caller's own bearer rides along
 * (a user JWT for this org; never a service key or a Claude CLI turn token), so the
 * specialist's tools act as the caller instead of with no user identity at all.
 */
function buildDelegationHeaders(ctx = {}) {
  const { isHoldableBearer } = require('./turnBearerStore.js');
  const headers = { 'Content-Type': 'application/json' };
  if (ctx.token && ctx.orgId && isHoldableBearer(String(ctx.token), ctx.orgId)) headers.Authorization = `Bearer ${ctx.token}`;
  return headers;
}

/**
 * On the receiving /chat/claude (service-key org+user branch): keep a forwarded bearer only
 * when it verifies as an ordinary user token for the SAME org and user as the delegation.
 * Anything else is dropped (''), so a specialist never runs as someone else.
 */
function delegatedBearer({ bearer, orgId, userId, verify } = {}) {
  if (!bearer || !orgId || !userId || typeof verify !== 'function') return '';
  const r = verify(bearer);
  if (!r || !r.valid || !r.payload || r.payload.aud) return '';
  if (String(r.payload.org_id || '') !== String(orgId) || String(r.payload.sub || '') !== String(userId)) return '';
  return bearer;
}

module.exports = { buildDelegationBody, buildDelegationHeaders, delegatedBearer };
