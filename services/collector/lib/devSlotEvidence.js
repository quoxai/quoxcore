'use strict';

/**
 * devSlotEvidence.js — QUOXIFY PASS 4 (DEVSUITE phase 17): the Slots half of
 * the evidence gap.
 *
 * The quoxification audit (note #2842, S-Q4) scored evidence as "uneven and
 * sometimes mislabeled" across the bundle: QLoop is exemplary (full AEE +
 * VOLT + AOCL + WARD) and is the reference, while "Slots has AEE + WARD but
 * no AOCL or VOLT". This adds the AOCL layer classification so a slot action
 * carries the same shape of receipt a loop turn does.
 *
 * WHY THE CLASSIFICATION IS PER-ACTION, not one constant like QLoop's.
 * QLoop has exactly one risk posture: an unattended agent running real dev
 * commands, so a single frozen HIGH/FULL block is honest for every event it
 * emits. Slots does not. Reading a slot's messages and RETIRING a slot are
 * not the same act, and stamping them with the same risk would make the
 * classification decorative. A classification that does not discriminate is
 * governance theatre, which the house rules name specifically.
 *
 * The layers used here (AOCL is OSI-style, 1-7):
 *   layer 5 (Session)  - checkout/release/assign/claim: who holds an address.
 *   layer 6 (Present)  - say/read/steer: moving a message through it.
 *   layer 4 (Transport)- bridge config: where a slot line is rendered.
 *
 * Risk reflects what the action can DO to someone else's work:
 *   LOW    - reads, and saying something into a thread.
 *   MEDIUM - taking a slot away from a live holder, or repointing where its
 *            messages render (a wrong bridge sends work chatter to the wrong
 *            audience).
 *   HIGH   - retiring a slot: it removes an address other things still send
 *            to, and it cannot be undone.
 *
 * Autonomy is ASSISTED throughout: every slot action today is initiated by a
 * human or by an agent acting on an explicit instruction, and none of them
 * proceeds unattended the way a loop turn does.
 */

const SLOT_AOCL = Object.freeze({
  'quox.slot.create':     Object.freeze({ layer: 5, risk: 'LOW',    autonomy: 'ASSISTED' }),
  'quox.slot.retire':     Object.freeze({ layer: 5, risk: 'HIGH',   autonomy: 'ASSISTED' }),
  'quox.slot.checkout':   Object.freeze({ layer: 5, risk: 'LOW',    autonomy: 'ASSISTED' }),
  'quox.slot.release':    Object.freeze({ layer: 5, risk: 'MEDIUM', autonomy: 'ASSISTED' }),
  'quox.slot.assign':     Object.freeze({ layer: 5, risk: 'LOW',    autonomy: 'ASSISTED' }),
  'quox.slot.claim':      Object.freeze({ layer: 5, risk: 'LOW',    autonomy: 'ASSISTED' }),
  'quox.slot.say':        Object.freeze({ layer: 6, risk: 'LOW',    autonomy: 'ASSISTED' }),
  'quox.slot.steer':      Object.freeze({ layer: 6, risk: 'MEDIUM', autonomy: 'ASSISTED' }),
  'quox.slot.bridge_set': Object.freeze({ layer: 4, risk: 'MEDIUM', autonomy: 'ASSISTED' }),
  // QUOX-CLAUDE-3: remote keystrokes into a live session are HIGH risk.
  'quox.slot.control':     Object.freeze({ layer: 6, risk: 'HIGH',   autonomy: 'ASSISTED' }),
  'quox.slot.control_ack': Object.freeze({ layer: 6, risk: 'LOW',    autonomy: 'ASSISTED' }),
});

// Anything not listed is classified conservatively rather than dropped. An
// unlisted intent is an intent nobody has reasoned about, so it must not
// inherit a LOW risk by default.
const SLOT_AOCL_FALLBACK = Object.freeze({ layer: 5, risk: 'MEDIUM', autonomy: 'ASSISTED' });

/**
 * The AOCL block to stamp on a slot lifecycle event.
 * Returns a fresh copy so a caller cannot mutate the frozen constants.
 *
 * @param {string} intent - e.g. 'quox.slot.say'
 */
function classifySlotAocl(intent) {
  const found = SLOT_AOCL[intent];
  return { ...(found || SLOT_AOCL_FALLBACK) };
}

/**
 * Build the VOLT event for a slot action. Deliberately carries NO message
 * body: a slot thread routinely carries working chatter, and VOLT is a
 * long-lived evidence ledger. It records that a message of a given size was
 * delivered to a given slot by a given actor, which is what an auditor needs,
 * without turning the ledger into a transcript store.
 *
 * @returns {{eventType: string, payload: object}|null} null when unusable
 */
function buildSlotVoltEntry({ intent, orgId, slotId, slotName, actor, textLength } = {}) {
  if (!intent || !slotName) return null;
  return {
    eventType: intent,
    payload: {
      org_id: orgId || null,
      slot_id: slotId || null,
      slot: slotName,
      actor: actor || null,
      ...(Number.isFinite(textLength) ? { text_length: textLength } : {}),
      aocl: classifySlotAocl(intent),
    },
  };
}

module.exports = {
  SLOT_AOCL,
  SLOT_AOCL_FALLBACK,
  classifySlotAocl,
  buildSlotVoltEntry,
};
