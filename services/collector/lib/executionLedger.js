'use strict';
/**
 * QUOXTRUST T3 (D3 durability) — durable execution ledger for external effects.
 *
 * The codex worthiness audit's durability finding was that an action could
 * complete while its record silently vanished (audit skipped on DB-down). D3
 * iteration 3 made that loss VISIBLE (auditWriteFailures accounting). This module
 * is the next, more-ambitious step: it makes a consequential external effect
 * UN-LOSEABLE and UN-AMBIGUOUS, which is what actually makes the platform's
 * "catching everything, lands here without asking" promise true THROUGH a crash.
 *
 * The contract (the execution half of the T3 state machine; the proposed→
 * authorized half lives in the approval store):
 *   claimed → dispatched → confirmed | failed | outcome_unknown
 *
 *   1. NO DISPATCH WITHOUT DURABLE INTENT. A caller writes a durable 'claimed'
 *      row BEFORE firing the effect and flips it to 'dispatched' immediately
 *      before the irreversible call. If that durable write throws, the caller
 *      MUST refuse to dispatch (fail closed) — an effect that cannot be recorded
 *      must not happen. (The caller enforces fail-closed; this module surfaces
 *      the throw so it can.)
 *   2. NO SILENT UNCERTAINTY, NO BLIND RETRY. If the process dies between
 *      dispatch and resolve, reconcileOnBoot marks the orphan 'outcome_unknown'
 *      (the external call MAY have landed — you cannot un-send an accepted SMTP
 *      message, so it is NEVER auto-retried) and a 'claimed'-but-never-dispatched
 *      orphan 'failed'/aborted (the effect provably did not fire). Both are then
 *      visible via getExecutionLedgerStatus → /health + /metrics.
 *
 * Durable by construction: the count of outcome_unknown / in_flight is read from
 * the SQLite table itself, NOT an in-memory singleton, so a crash's unknowns are
 * still visible AFTER the restart that discovered them. That is the whole point.
 *
 * db-passed-in pattern (mirrors lib/acceptanceStore.js). A null db is a no-op
 * that returns null/zeroes: a deployment that did not configure the store is a
 * deliberate choice (like AEE_STORAGE_CONFIGURED), not an outage, and must not
 * block effects. The caller distinguishes "not configured" (no-op) from
 * "configured but the write threw" (fail closed).
 */

const crypto = require('crypto');

// C2 (docs/trust/C2-EXECUTION-STATE-MACHINE.md): rejected_before_dispatch is the
// terminal state for a claim whose execution path stopped BEFORE any effect
// adapter fired (an approval card was raised, a binding refused, a policy
// re-check denied) — provably no effect, distinct from 'failed' (adapter said no)
// and from 'outcome_unknown' (adapter may have landed). 'partial' records a
// multi-effect action that landed some child effects (X thread N-of-M).
const STATES = ['claimed', 'dispatched', 'confirmed', 'failed', 'partial', 'outcome_unknown', 'rejected_before_dispatch'];

/**
 * Idempotent safety-net table creation. The real schema is owned by
 * migrations/aee/034-execution-intents.sql (runMigrations); this mirrors the
 * dual pattern server.js uses so a fresh/underneath-migration db still works.
 */
function initExecutionLedger(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_intents (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      tool          TEXT NOT NULL,
      action_digest TEXT,
      corr          TEXT,
      state         TEXT NOT NULL,
      outcome       TEXT,
      error         TEXT,
      created_ts    TEXT NOT NULL,
      dispatched_ts TEXT,
      resolved_ts   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_execution_intents_state ON execution_intents(state);
    CREATE INDEX IF NOT EXISTS idx_execution_intents_org_created ON execution_intents(org_id, created_ts);
    CREATE TABLE IF NOT EXISTS evidence_obligations (
      intent_id     TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      tool          TEXT NOT NULL,
      corr          TEXT,
      ctx_json      TEXT,
      action_commit TEXT,
      state         TEXT NOT NULL DEFAULT 'owed',
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_ts    TEXT NOT NULL,
      delivered_ts  TEXT,
      delivered_envelope_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_obligations_state ON evidence_obligations(state);
  `);
}

/** sha256 of the action input — binds WHAT was dispatched (ties to D1). Best
 * effort; the full canonical-action representation is the D1 follow-up. */
function actionDigest(input) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Write a durable 'claimed' intent BEFORE the effect fires. Returns the intent
 * id. Throws if db write fails (so the caller can fail closed). Null db → null
 * (not configured; caller proceeds without durability by deliberate deployment
 * choice).
 */
function claim(db, { orgId, tool, actionDigest: digest = null, corr = null } = {}, nowIso) {
  if (!db) return null;
  const id = crypto.randomUUID();
  const ts = nowIso || new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_intents (id, org_id, tool, action_digest, corr, state, created_ts)
     VALUES (?, ?, ?, ?, ?, 'claimed', ?)`
  ).run(id, String(orgId || 'default'), String(tool || 'unknown'), digest, corr, ts);
  return id;
}

/** Flip 'claimed' → 'dispatched' immediately before the irreversible call. */
function markDispatched(db, id, nowIso) {
  if (!db || !id) return;
  const ts = nowIso || new Date().toISOString();
  db.prepare(
    `UPDATE execution_intents SET state='dispatched', dispatched_ts=? WHERE id=? AND state='claimed'`
  ).run(ts, id);
}

/** Settle the intent after the effect returns. ok=true → confirmed, else failed. */
function resolve(db, id, ok, err = null, nowIso) {
  if (!db || !id) return;
  const ts = nowIso || new Date().toISOString();
  const errStr = err ? String(err.message || err).slice(0, 500) : null;
  db.prepare(
    `UPDATE execution_intents
       SET state=?, outcome=?, error=?, resolved_ts=?
     WHERE id=? AND state IN ('claimed','dispatched')`
  ).run(ok ? 'confirmed' : 'failed', ok ? 'success' : 'failed', errStr, ts, id);
}

/**
 * C2 — terminal-settle a claim that never reached the effect boundary
 * (awaiting_approval return, pre-dispatch refusal). Only from 'claimed': a
 * 'dispatched' row must never be rewritten as if nothing fired. Returns true
 * when the row was settled (caller can detect the misclassified-gating case).
 */
function rejectBeforeDispatch(db, id, reason = null, nowIso) {
  if (!db || !id) return false;
  const ts = nowIso || new Date().toISOString();
  const r = db.prepare(
    `UPDATE execution_intents
       SET state='rejected_before_dispatch', outcome='no_dispatch', error=?, resolved_ts=?
     WHERE id=? AND state='claimed'`
  ).run(reason ? String(reason).slice(0, 500) : null, ts, id);
  return r.changes > 0;
}

/**
 * C2 — settle a THROW honestly: if the effect boundary was crossed
 * ('dispatched'), the provider MAY have accepted → outcome_unknown, NEVER
 * 'failed' (no blind retry). If still 'claimed', the throw provably preceded
 * any effect → failed. Returns the state written ('outcome_unknown'|'failed'|null).
 */
function resolveThrow(db, id, err = null, nowIso) {
  if (!db || !id) return null;
  const ts = nowIso || new Date().toISOString();
  const errStr = err ? String(err.message || err).slice(0, 500) : null;
  const unk = db.prepare(
    `UPDATE execution_intents
       SET state='outcome_unknown', outcome='unknown', error=?, resolved_ts=?
     WHERE id=? AND state='dispatched'`
  ).run(errStr, ts, id);
  if (unk.changes > 0) return 'outcome_unknown';
  const failed = db.prepare(
    `UPDATE execution_intents
       SET state='failed', outcome='threw_before_dispatch', error=?, resolved_ts=?
     WHERE id=? AND state='claimed'`
  ).run(errStr, ts, id);
  return failed.changes > 0 ? 'failed' : null;
}

/** C2 — durable partial outcome for multi-effect actions (X thread N-of-M). */
function resolvePartial(db, id, detail = null, nowIso) {
  if (!db || !id) return;
  const ts = nowIso || new Date().toISOString();
  db.prepare(
    `UPDATE execution_intents
       SET state='partial', outcome='partial', error=?, resolved_ts=?
     WHERE id=? AND state IN ('claimed','dispatched')`
  ).run(detail ? String(detail).slice(0, 500) : null, ts, id);
}

/**
 * On-boot recovery. The one thing none of the existing collector precedents do.
 * A 'dispatched' orphan (crash after the effect was initiated) → outcome_unknown:
 * it MAY have landed, so it is flagged, never auto-retried. A 'claimed' orphan
 * (crash before dispatch) → failed/aborted: the effect provably did not fire.
 * Returns the counts so the boot log can report them. NEVER re-invokes anything.
 */
function reconcileOnBoot(db, nowIso) {
  if (!db) return { dispatched_unknown: 0, claimed_aborted: 0 };
  const ts = nowIso || new Date().toISOString();
  const unknown = db.prepare(
    `UPDATE execution_intents SET state='outcome_unknown', outcome='unknown', resolved_ts=? WHERE state='dispatched'`
  ).run(ts);
  const aborted = db.prepare(
    `UPDATE execution_intents SET state='failed', outcome='aborted_before_dispatch', resolved_ts=? WHERE state='claimed'`
  ).run(ts);
  return { dispatched_unknown: unknown.changes, claimed_aborted: aborted.changes };
}

/**
 * WP4.1b EVIDENCE OUTBOX — a receipt owed is a durable debt beside the intent.
 *
 * The choke's post-execution evidence emit was best-effort: a crash between
 * execute and emit (or a down sink) lost the receipt while the intent said
 * confirmed. Now claim-time records the obligation ('owed'), confirmed receipt
 * storage settles it ('delivered'), and reconcile-on-boot RE-EMITS owed
 * receipts from a CONTENT-FREE snapshot — ctx identifiers + the canonical
 * action COMMITMENT (digest/field_hashes/effect_id), never plaintext input —
 * without replaying the effect (reEmitOwedObligations receives an emit
 * callback and nothing capable of dispatch, so replay is impossible by
 * construction).
 */
function recordObligation(db, intentId, { orgId, tool, corr = null, ctx = null, actionCommit = null } = {}, nowIso) {
  if (!db || !intentId) return;
  const ts = nowIso || new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO evidence_obligations (intent_id, org_id, tool, corr, ctx_json, action_commit, state, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, 'owed', ?)`
  ).run(
    intentId,
    String(orgId || 'default'),
    String(tool || 'unknown'),
    corr,
    ctx ? JSON.stringify(ctx) : null,
    actionCommit ? JSON.stringify(actionCommit) : null,
    ts
  );
}

function markObligationDelivered(db, intentId, envelopeId = null, nowIso) {
  if (!db || !intentId) return;
  const ts = nowIso || new Date().toISOString();
  // delivered_envelope_id is the tag-independent join key the WP4.2 reconciler
  // uses for direction-1 completeness (obligation -> receipt -> WARD entry via
  // verifyReceipt) — candidate discovery never depends on the tags under test.
  db.prepare(
    `UPDATE evidence_obligations SET state='delivered', delivered_ts=?, delivered_envelope_id=? WHERE intent_id=? AND state='owed'`
  ).run(ts, envelopeId ? String(envelopeId) : null, intentId);
}

/**
 * Boot-time (and reconciler-tick) recovery of owed receipts. TERMINAL intents
 * only — an in-flight intent's outcome is not known yet, so its receipt cannot
 * honestly be written. emitFn(snapshot) returns truthy when the sink accepted;
 * false/throw keeps the debt owed with the attempt counted (triad: failure is
 * accounted, never disguised as empty). Bounded by `limit` so a backlog cannot
 * wedge boot. NEVER re-invokes any tool — emit-only.
 */
function reEmitOwedObligations(db, emitFn, { limit = 200 } = {}, nowIso) {
  if (!db || typeof emitFn !== 'function') return { reEmitted: 0, delivered: 0, stillOwed: 0 };
  const ts = nowIso || new Date().toISOString();
  const owed = db.prepare(
    `SELECT o.*, i.state AS intent_state, i.outcome AS intent_outcome, i.error AS intent_error, i.dispatched_ts
       FROM evidence_obligations o
       JOIN execution_intents i ON i.id = o.intent_id
      WHERE o.state = 'owed'
        AND i.state IN ('confirmed','failed','partial','outcome_unknown','rejected_before_dispatch')
      ORDER BY o.created_ts ASC
      LIMIT ?`
  ).all(limit);
  let delivered = 0;
  for (const row of owed) {
    let ok = false;
    let envId = null;
    let err = null;
    try {
      const r = emitFn({
        recovery: true,
        intent_id: row.intent_id,
        tool: row.tool,
        org_id: row.org_id,
        corr: row.corr,
        ctx: row.ctx_json ? JSON.parse(row.ctx_json) : null,
        actionCommit: row.action_commit ? JSON.parse(row.action_commit) : null,
        intent_state: row.intent_state,
        intent_outcome: row.intent_outcome,
        intent_error: row.intent_error,
      });
      ok = !!(r && typeof r === 'object' ? r.delivered : r);
      envId = (r && typeof r === 'object' && r.envelopeId) ? String(r.envelopeId) : null;
    } catch (e) {
      err = String(e && e.message || e).slice(0, 300);
    }
    if (ok) {
      db.prepare(`UPDATE evidence_obligations SET state='delivered', delivered_ts=?, delivered_envelope_id=? WHERE intent_id=?`).run(ts, envId, row.intent_id);
      delivered++;
    } else {
      db.prepare(`UPDATE evidence_obligations SET attempts=attempts+1, last_error=? WHERE intent_id=?`).run(err || 'emit refused', row.intent_id);
    }
  }
  const stillOwed = db.prepare(`SELECT COUNT(*) c FROM evidence_obligations WHERE state='owed'`).get().c;
  return { reEmitted: owed.length, delivered, stillOwed };
}

/**
 * Durable status for /health + /metrics. Read from the table (survives restart),
 * NOT an in-memory counter. outcome_unknown > 0 means a past crash left an
 * ambiguous external effect that a human must reconcile. receipts_owed > 0
 * means an effect ran (or terminally settled) whose witnessed receipt has not
 * landed yet — the outbox debt the boot re-emit / reconciler is working off.
 */
function getExecutionLedgerStatus(db) {
  if (!db) return { configured: false, outcome_unknown: 0, in_flight: 0, receipts_owed: 0 };
  const unknown = db.prepare(`SELECT COUNT(*) c FROM execution_intents WHERE state='outcome_unknown'`).get().c;
  const inFlight = db.prepare(`SELECT COUNT(*) c FROM execution_intents WHERE state IN ('claimed','dispatched')`).get().c;
  let owed = 0;
  try { owed = db.prepare(`SELECT COUNT(*) c FROM evidence_obligations WHERE state='owed'`).get().c; }
  catch { owed = 0; /* pre-035 db without the table: no debt recorded there */ }
  return { configured: true, outcome_unknown: unknown, in_flight: inFlight, receipts_owed: owed };
}

module.exports = {
  STATES,
  initExecutionLedger,
  actionDigest,
  claim,
  markDispatched,
  resolve,
  rejectBeforeDispatch,
  resolveThrow,
  resolvePartial,
  reconcileOnBoot,
  getExecutionLedgerStatus,
  recordObligation,
  markObligationDelivered,
  reEmitOwedObligations,
};
