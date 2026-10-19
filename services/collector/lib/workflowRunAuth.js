'use strict';

/**
 * workflowRunAuth.js — how a chat-started workflow run authenticates to quoxflow (RunActor slice 3 Part A, HYPERION
 * design GO 2026-10-19). quoxflow records the run's initiator from the verified caller: a human access token is
 * user:<id>; the service key is system:api. So:
 *   - a HUMAN bearer (no audience, access type) is sent ALONE, after checking its org claim is the chat's org and its sub
 *     is the turn's user (decode only: verifying the signature is quoxflow's job). A multi-org user's token for another
 *     org is refused, never run in the other org.
 *   - a token that names an audience (the collector's per-turn tool credential) or any non-access type is never
 *     forwarded: refused plainly (quoxflow refuses it too).
 *   - no bearer at all: the service-key path with X-Org-ID, as before (system:api).
 * -> { headers } | { refusal }
 */
const jwt = require('jsonwebtoken');

function workflowRunAuth({ token, orgId, userId } = {}) {
  if (token) {
    const c = jwt.decode(token);
    if (!c || typeof c !== 'object') return { refusal: 'The sign-in on this turn could not be read, so the workflow was not started. Ask again.' };
    if (c.aud !== undefined || (c.type !== undefined && c.type !== 'access')) {
      return { refusal: 'Your sign-in is not held for this turn, so the workflow cannot be started as you. Nothing ran. Ask again to start a new turn.' };
    }
    const tokOrg = c.org_id || c.orgId;
    if (!orgId || tokOrg !== orgId) {
      return { refusal: 'You are signed in to a different organisation than this chat, so the workflow was not started (it would have run in the other organisation). Switch organisation and ask again.' };
    }
    const tokUser = c.sub || c.user_id;
    if (userId && tokUser !== userId) {
      return { refusal: 'The sign-in on this turn is not the person who asked, so the workflow was not started.' };
    }
    return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  }
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  return {
    headers: {
      'Content-Type': 'application/json',
      ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
      ...(orgId ? { 'X-Org-ID': orgId } : {}),
    },
  };
}

module.exports = { workflowRunAuth };
