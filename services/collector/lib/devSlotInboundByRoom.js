'use strict';

/**
 * devSlotInboundByRoom.js — QUOXIDENTITY DEFECT #1: Matrix inbound was never
 * ingested into a slot's message cache. POST /api/internal/slots/inbound-by-
 * room (server.js) is the appservice's delivery point for every message that
 * lands in a slot's Matrix room; this resolves the room to its slot
 * (org-agnostic — a Matrix room id is globally unique, see
 * devSlotsStore.js's findSlotByMatrixRoomId) and appends it via the SAME
 * devSlotMessages.appendMessage shape POST /api/v1/slots/:name/inbound uses.
 *
 * Kept as a DI'd, framework-free function (same shape as devSlotsStore.js /
 * devSlotMatrixProvision.js) so server.js's route is a thin Express wrapper
 * and this logic is directly unit-testable — server.js is a monolith not
 * exported for import (see test/aeeEndpointAuth.test.js's precedent).
 *
 * @param {object} p
 * @param {object} p.body - { room_id, sender, text }
 * @param {Function} p.findSlotByMatrixRoomId - devSlotsStore's findSlotByMatrixRoomId({roomId}).
 * @param {Function} p.appendMessage - devSlotMessagesStore's appendMessage({...}).
 * @param {Function} [p.isSlotsOwnPuppetSender] - devSlotMatrixProvision's
 *   isSlotsOwnPuppetSender(sender, slotId); when it returns true the message
 *   is our own outbound say/steer post echoed back by the room-wide webhook
 *   subscription, and must NOT be re-ingested as a new inbound message.
 * @returns {{status: number, body: object}}
 */
function handleInboundByRoom({ body, findSlotByMatrixRoomId, appendMessage, isSlotsOwnPuppetSender } = {}) {
  const { room_id: roomId, sender, text } = body || {};
  if (!roomId || !text) {
    return { status: 400, body: { error: 'room_id and text are required' } };
  }

  const slot = findSlotByMatrixRoomId({ roomId });
  if (!slot) return { status: 200, body: { matched: false } };

  if (typeof isSlotsOwnPuppetSender === 'function' && isSlotsOwnPuppetSender(sender, slot.id)) {
    return { status: 200, body: { matched: true, slot_name: slot.name, ignored: 'own_echo' } };
  }

  appendMessage({
    orgId: slot.org_id, slotId: slot.id, slotName: slot.name, from: sender || null, text, source: 'matrix',
  });

  return { status: 200, body: { matched: true, slot_name: slot.name } };
}

module.exports = { handleInboundByRoom };
