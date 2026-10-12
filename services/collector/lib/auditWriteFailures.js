/**
 * QUOXTRUST T3 (D3 durability) — audit-write failure accounting.
 *
 * For an evidence-first product, an audit envelope that fails to persist is a
 * durability breach, not something to console.warn and forget. server.js's
 * storeAuditEnvelope had two silent drop paths (storage unavailable after boot,
 * and a throwing INSERT); pre-fix each dropped the receipt with zero durable
 * trace — the shape of the 30-hour silent-audit outage (a "0 failed" that lied
 * because the dependency was down).
 *
 * This module is the shared, process-wide accounting singleton. It is a
 * deliberately tiny, side-effect-free counter so it can be unit-tested against
 * the REAL code the collector runs (the /health degraded signal + /metrics
 * counter both read getAuditWriteFailures()), rather than re-implemented in a
 * fixture. It intentionally does NOT decide policy: it never blocks an action
 * (you cannot un-send an SMTP message whose provider already accepted it — that
 * recovery belongs to the T3 execution state machine, deferred). It only makes
 * the loss VISIBLE.
 */

const KNOWN_REASONS = ['storage_unavailable', 'insert_failed'];

const state = {
  count: 0,
  by_reason: { storage_unavailable: 0, insert_failed: 0 },
  last_error: null,
  last_reason: null,
  last_ts: null,
  first_ts: null,
};

/**
 * Record one dropped audit-envelope write.
 * @param {string} reason - one of KNOWN_REASONS (unknown reasons still count the total)
 * @param {Error|string} [err] - the underlying error, if any
 * @param {string} [nowIso] - ISO timestamp (injectable for deterministic tests)
 */
function recordAuditWriteFailure(reason, err, nowIso) {
  const ts = nowIso || new Date().toISOString();
  state.count += 1;
  if (state.by_reason[reason] !== undefined) state.by_reason[reason] += 1;
  state.last_error = err ? String(err.message || err) : (reason || null);
  state.last_reason = reason || null;
  state.last_ts = ts;
  if (!state.first_ts) state.first_ts = ts;
}

/** Snapshot of the accounting (deep-copied so callers can't mutate the singleton). */
function getAuditWriteFailures() {
  return { ...state, by_reason: { ...state.by_reason } };
}

/** Test-only: clear the singleton between cases. */
function resetAuditWriteFailures() {
  state.count = 0;
  state.by_reason = { storage_unavailable: 0, insert_failed: 0 };
  state.last_error = null;
  state.last_reason = null;
  state.last_ts = null;
  state.first_ts = null;
}

module.exports = {
  KNOWN_REASONS,
  recordAuditWriteFailure,
  getAuditWriteFailures,
  resetAuditWriteFailures,
};
