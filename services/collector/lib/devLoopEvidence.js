'use strict';

/**
 * devLoopEvidence.js — DEVSUITE-DEVMODE / QLoop EVIDENCED dimension.
 *
 * Pure helpers that complete the loop's evidence coverage. The loop already
 * emits AEE + WARD (quox.dev.loop.spawned / .turn / .interrupted). These
 * helpers add the missing VOLT run entries and the AOCL layer classification
 * so a loop run carries the same AEE + AOCL + VOLT + WARD quartet the chat
 * path does. Route wiring in server.js consumes these; the emit itself stays
 * best-effort there (a VOLT/AOCL failure must never break spawn/ingest/
 * interrupt).
 *
 * No secret is recorded: a VOLT turn entry references the turn's seq and the
 * SAME content hash the WARD turn envelope already carries, never the raw
 * turn body.
 */

// AOCL classification for a governed autonomous dev loop.
//   layer 7    — Execute/Delegate: the loop delegates execution to an
//                autonomous agent running on a fleet host.
//   risk HIGH  — it runs real development commands unattended.
//   autonomy FULL — it proceeds turn to turn without per-step human approval
//                (the human gate is the spawn approval, not each turn).
const LOOP_AOCL_CLASSIFICATION = Object.freeze({ layer: 7, risk: 'HIGH', autonomy: 'FULL' });

/**
 * The AOCL classification block to stamp on the loop-lifecycle layer events.
 * Returns a fresh copy so a caller cannot mutate the frozen constant's shape
 * through a reference.
 */
function classifyLoopAocl() {
  return { ...LOOP_AOCL_CLASSIFICATION };
}

/**
 * Build the VOLT event for one witnessed loop turn.
 *
 * Lightweight by design: it carries the turn's seq and the same raw_sha256
 * the WARD turn envelope carries, never the raw turn body, so VOLT does not
 * duplicate the durable dev_loop_session_events stream and records no secret.
 *
 * @param {object|null} session - the loop-session row (for its id)
 * @param {object} ev - a newEvents entry: { seq, type, rawSha256 }
 * @returns {{ eventType: string, payload: object }|null} null if ev is unusable
 */
function buildLoopVoltEntry(session, ev) {
  if (!ev || !Number.isInteger(ev.seq)) return null;
  return {
    eventType: 'dev.loop.turn',
    payload: {
      session_id: session && session.id != null ? session.id : null,
      seq: ev.seq,
      event_type: ev.type != null ? ev.type : null,
      raw_sha256: ev.rawSha256 != null ? ev.rawSha256 : null,
    },
  };
}

module.exports = { LOOP_AOCL_CLASSIFICATION, classifyLoopAocl, buildLoopVoltEntry };
