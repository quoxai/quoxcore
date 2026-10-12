'use strict';

/**
 * slotSplinter.js - QUOXIDENTITY P10 route logic for the shared slot, kept out
 * of server.js so it is testable. Contract: docs/QUOXIDENTITY_SPLINTER_CONTRACT.md
 * "P10 pinned API". Voice itself is decided ONLY by isSlotVoice
 * (lib/devSlotsStore.js); nothing here re-implements holder logic.
 */

const { isSlotVoice } = require('./devSlotsStore.js');
const { deriveActorType } = require('../utils/actorType.js');

// Caller shape for isSlotVoice. memberKey exists ONLY for an attach-token
// caller (verified attach_lease_id on an agent actor); everyone else is
// identified by the session name they present, as before.
function callerFromReq(req, { session, identity } = {}) {
  const u = (req && req.user) || {};
  // actor_type is DERIVED (deriveActorType), never a req.user field: reading
  // u.actor_type made every live caller a non-member (2026-10-05).
  const attach = deriveActorType(req) === 'agent' && !!u.attach_lease_id;
  return {
    session: session || null,
    identity: identity || null,
    memberKey: attach ? u.attach_lease_id : null,
    agentId: attach ? (u.agent_id || null) : null,
    splinter: attach ? (u.splinter || null) : null,
  };
}

/**
 * Checkout of a slot that is held: may this caller JOIN as a member instead of
 * being refused? Only an attach caller of the agent the slot is BOUND to, while
 * the slot is held by ANOTHER session of that same agent. Anything else: no join
 * (the caller returns the usual 409).
 */
function evaluateMemberJoin({ req, orgId, slot, holderSession, identity, getBindingBySlot, devSlots }) {
  const caller = callerFromReq(req, { session: holderSession, identity });
  if (!caller.memberKey || !caller.agentId || !slot || slot.state !== 'held') return { joined: false };
  const binding = getBindingBySlot({ orgId, slotName: slot.name });
  if (!binding || binding.agent_id !== caller.agentId) return { joined: false };
  if (slot.holder_identity !== `agent:${caller.agentId}`) return { joined: false };
  if (slot.holder_session === holderSession) return { joined: false };
  const r = devSlots.joinMember({
    orgId, name: slot.name, memberKey: caller.memberKey, agentId: caller.agentId,
    splinter: caller.splinter, memberSession: holderSession,
  });
  if (!r.ok) return { joined: false };
  return { joined: true, member: { member_key: r.member.member_key, splinter: r.member.splinter }, slot: r.slot };
}

/** POST /api/v1/slots/:name/messages/:id/claim (voice-gated, CAS, witnessed). */
function createClaimHandler({ devSlots, devSlotMessages, resolveOrgId, deriveCallerIdentity, audit }) {
  return (req, res) => {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    try {
      const slot = devSlots.getSlot({ orgId, name: req.params.name });
      if (!slot) return res.status(404).json({ error: 'unknown slot' });
      const session = (req.body && req.body.holder_session) || null;
      const identity = deriveCallerIdentity(req);
      const caller = callerFromReq(req, { session, identity });
      if (!isSlotVoice(slot, caller)) {
        return res.status(403).json({ error: 'not slot voice', message: `not the holder or a member of slot ${req.params.name}` });
      }
      const claimedBy = caller.splinter || session || identity;
      const r = devSlotMessages.claimMessage({ orgId, slotId: slot.id, messageId: req.params.id, claimedBy });
      if (!r.ok && r.code === 'not_found') return res.status(404).json({ error: 'unknown message' });
      if (!r.ok) return res.status(409).json({ error: 'already claimed', claimed_by: r.claimed_by });
      audit({
        type: 'event', from: `session.${claimedBy}`, to: 'audit.system', intent: 'quox.slot.claim',
        corr: slot.id,
        payload: { org_id: orgId, name: req.params.name, message_id: req.params.id, claimed_by: claimedBy },
      });
      return res.json({ claimed: true, claimed_by: claimedBy });
    } catch (err) {
      console.error('[DevSlots] claim failed:', err.message);
      return res.status(500).json({ error: 'claim failed' });
    }
  };
}

module.exports = { callerFromReq, evaluateMemberJoin, createClaimHandler };
