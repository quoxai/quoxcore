'use strict';

/**
 * commanderQHeldSlotDefer.js — QUOXIDENTITY DEFECT #2 fix.
 *
 * A slot's Matrix room, while `held`, has a live human/agent session as its
 * voice (the "quox slot say"/steer channel). collectorBrain.js (the Matrix
 * appservice) stamps every Matrix-sourced chat turn's session_id as
 * `matrix_<roomId>` — the same convention lib/approvalGate.js:974 already
 * reads to push HITL proposals back into the originating room. Without this
 * guard, CommanderQ (handleCollectorChat) also builds and sends its own LLM
 * reply into that room for the same inbound turn: two voices answering one
 * human. When the room's slot is held, the held session IS the voice, and
 * CommanderQ must defer silently instead.
 *
 * Kept as a pure, DI'd module (mirrors devSlotsStore.js's shape) so the
 * decision is unit-testable without booting handleCollectorChat's full
 * pipeline (Express, LLM clients, tool execution).
 */

const MATRIX_SESSION_PREFIX = 'matrix_';

/**
 * @param {string} sessionId
 * @returns {string|null} the Matrix room id, or null when sessionId is not
 *   a matrix_-prefixed session id.
 */
function extractMatrixRoomIdFromSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(MATRIX_SESSION_PREFIX)) return null;
  return sessionId.slice(MATRIX_SESSION_PREFIX.length);
}

/**
 * @param {object} p
 * @param {string} p.effectiveSessionId - handleCollectorChat's resolved session id.
 * @param {Function} p.findSlotByMatrixRoomId - devSlotsStore's findSlotByMatrixRoomId({roomId}).
 * @returns {{defer: boolean, roomId: string|null, slot: object|null}}
 */
function checkHeldMatrixSlotDefer({ effectiveSessionId, findSlotByMatrixRoomId } = {}) {
  const roomId = extractMatrixRoomIdFromSessionId(effectiveSessionId);
  if (!roomId) return { defer: false, roomId: null, slot: null };
  if (typeof findSlotByMatrixRoomId !== 'function') return { defer: false, roomId, slot: null };

  const slot = findSlotByMatrixRoomId({ roomId }) || null;
  const defer = !!(slot && slot.state === 'held' && slot.holder_session);
  return { defer, roomId, slot };
}

module.exports = {
  MATRIX_SESSION_PREFIX,
  extractMatrixRoomIdFromSessionId,
  checkHeldMatrixSlotDefer,
};
