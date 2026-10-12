'use strict';

/**
 * Blind-index rotation bookkeeping. One row per org:
 *   key_fp   fingerprint of the org's blind-index key at the last COMPLETED reindex
 *   version  bi_version stamped on rows written under that key generation
 *
 * A rotation is "pending" while a previous master is configured and the org's current
 * key has not been reindexed yet. While pending, current-key writes are stamped
 * version+1 (so reindex can tell them from previous-key rows) and norm-based
 * suppressions are double-written (see store.addSuppression).
 */

const cx = require('./crypto.js');

function getState(db, orgId) {
  return db.prepare('SELECT * FROM contactsq_bi_state WHERE org_id = ?').get(orgId) || null;
}

function isPending(db, orgId) {
  if (!cx.previousKeyConfigured()) return false;
  const st = getState(db, orgId);
  return !st || st.key_fp !== cx.biKeyFingerprint(orgId);
}

/** bi_version to stamp on a row indexed under the CURRENT key. */
function stampFor(db, orgId) {
  const st = getState(db, orgId);
  const v = (st && st.version) || 1;
  return isPending(db, orgId) ? v + 1 : v;
}

/** Version of the previous-key generation (what un-reindexed rows carry). */
function previousStamp(db, orgId) {
  const st = getState(db, orgId);
  return (st && st.version) || 1;
}

/** True once the org's CURRENT key has been fully reindexed. */
function reindexComplete(db, orgId) {
  const st = getState(db, orgId);
  return Boolean(st && st.key_fp === cx.biKeyFingerprint(orgId));
}

module.exports = { getState, isPending, stampFor, previousStamp, reindexComplete };
