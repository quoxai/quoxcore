'use strict';
/**
 * QUOXON-MESH: is anyone listening on a slot? Pure derivation from data the collector already holds:
 * open SSE streams and in-progress waits (message-store listeners), the holder, last heartbeat / last read.
 * states: listening | not_listening | nobody_holds
 */
function slotPresence({ slot, listeners = 0 } = {}) {
  const held = !!slot && (slot.state === 'held' || slot.state === 'stale') && !!slot.holder_session;
  const seen = [slot && slot.last_heartbeat_at, slot && slot.last_read_at].filter(Boolean).sort();
  const last = seen.length ? seen[seen.length - 1] : null;
  if (!held) return { state: 'nobody_holds', holder_session: null, last_checked_in_at: last };
  return { state: listeners > 0 && slot.state === 'held' ? 'listening' : 'not_listening', holder_session: slot.holder_session, last_checked_in_at: last };
}
module.exports = { slotPresence };
