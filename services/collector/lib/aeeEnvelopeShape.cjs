'use strict';
/**
 * The SINGLE storability contract for an AEE envelope on the /aee/sync path.
 *
 * QUOXTRUST D3 (2026-09-29): /aee/sync had TWO copies of "is this envelope
 * usable" that drifted. The insert loop skipped any envelope missing one of the
 * 7 required fields (id/v/ts/type/from/to/intent/corr); the witness loop
 * re-checked ONLY `id`, and the VOLT bridge checked nothing. So a
 * malformed-but-id'd envelope was WITNESSED into the append-only WARD chain (and
 * VOLT-ingested) without ever being stored in `envelopes` — an orphan the
 * evidence reconciler later flags as "a source it cannot read". ~7K such
 * within-retention orphans accrued, worsening as /aee/sync volume grew 10x.
 *
 * The fix is to collapse the three checks to ONE predicate: store, witness, and
 * VOLT-ingest an envelope IFF it is storable. Never witness what you did not
 * store — a witness is a promise the source can be reproduced.
 */

/**
 * @param {*} e - a candidate AEE envelope
 * @returns {boolean} true iff the envelope carries every field the store insert
 *   requires (so it will actually be persisted, and is therefore safe to
 *   witness / VOLT-ingest).
 */
function isStorableAeeEnvelope(e) {
  return !!(e && e.id && e.v && e.ts && e.type && e.from && e.to && e.intent && e.corr);
}

module.exports = { isStorableAeeEnvelope };
