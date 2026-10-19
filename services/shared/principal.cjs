'use strict';

/**
 * ONE authoritative principal classifier (TRUST-PROOF plugin-frame-c1, F13/F14).
 *
 * A principal is NON-HUMAN if the verified token claims carry ANY of:
 *   agent_id, actor_type === 'agent', agent_ops, attach_lease_id.
 * Fail-closed: a single marker is enough, absence of agent_id proves nothing.
 *
 * Pure (no env, no I/O). Used by services/auth (middleware, HITL decision
 * sinks, MFA) and services/collector (utils/actorType.js). Accepts either raw
 * JWT claims or a req.user built from them (camelCase aliases tolerated).
 */
function isNonHumanClaims(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.agent_id || c.agentId) return true;
  if (c.actor_type === 'agent' || c.actorType === 'agent') return true;
  // SEC-PLUGIN-TRUST C1: a plugin backend acting on behalf of an org is never a human.
  if (c.actor_type === 'plugin' || c.actorType === 'plugin') return true;
  // RunActor slice 2: a workflow/scheduled turn's system actor is never a human.
  if (c.actor_type === 'system' || c.actorType === 'system') return true;
  if (c.agent_ops === true || c.agent_ops === 1 || c.agentOps === true) return true;
  if (c.attach_lease_id || c.attachLeaseId) return true;
  return false;
}

/** True when a request's principal is not a plain human (agent, qmcp token, agent_ops, attach lease). */
function isNonHumanPrincipal(req) {
  if (!req) return false;
  if (req.mcpToken) return true;
  return isNonHumanClaims(req.user);
}

/** The agent identity claims to carry across any re-mint of a token. */
function pickAgentClaims(c) {
  const out = {};
  if (!c || typeof c !== 'object') return out;
  if (c.agent_id) out.agent_id = c.agent_id;
  if (c.actor_type === 'agent') out.actor_type = 'agent';
  if (c.agent_ops === true) out.agent_ops = true;
  if (c.attach_lease_id) out.attach_lease_id = c.attach_lease_id;
  if (c.holder_user_id && (c.attach_lease_id || c.agent_id)) out.holder_user_id = c.holder_user_id;
  if (c.splinter && c.attach_lease_id) out.splinter = c.splinter;
  if (c.resident_host && c.agent_id) out.resident_host = c.resident_host;
  return out;
}

module.exports = { isNonHumanClaims, isNonHumanPrincipal, pickAgentClaims };
