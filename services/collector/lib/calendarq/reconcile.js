'use strict';

/**
 * Calendar-Q reconcile (L2-C2 U3) — resolves an 'attempted' or
 * 'outcome_unknown' operation once provider evidence is (or still is not)
 * in hand. NEVER creates, updates, or deletes anything on the provider —
 * events.get is the only call this module ever makes.
 *
 * Three provider-evidenced outcomes:
 *   - events.get 404            -> 'failed' (never committed). A fresh
 *     attempt needs a brand NEW proposal + approval; the old approval is
 *     consumed and is never reissued here.
 *   - events.get 200, matching  -> 'confirmed' + receipt.
 *   - events.get 200, MISMATCH  -> 'partial' + receipt flagging the
 *     divergence for a human (never silently treated as success).
 *   - provider unreachable      -> stays 'outcome_unknown'; a durable,
 *     capped backoff (via reconcile_attempt receipts, same accounting shape
 *     as syncWorker.js's failure streak) prevents hammering it forever.
 */

const store = require('./store');
const { resolveGoogleCredential, getAccessToken, getEvent } = require('./providers/google');

const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120];
const RECONCILE_STUCK_THRESHOLD_MS = 5 * 60 * 1000;

function lastAttemptReceipt(orgId, opId) {
  const receipts = store.listReceipts(orgId, opId).filter((r) => r.kind === 'reconcile_attempt');
  return receipts.length > 0 ? receipts[receipts.length - 1] : null;
}

function applyBackoff(orgId, opId, nowMs, reasonCode) {
  const prior = store.listReceipts(orgId, opId).filter((r) => r.kind === 'reconcile_attempt').length;
  const attempt = prior + 1;
  const idx = Math.min(attempt - 1, BACKOFF_MINUTES.length - 1);
  const nextEligibleAt = nowMs + BACKOFF_MINUTES[idx] * 60 * 1000;
  store.insertReceipt({ orgId, opId, kind: 'reconcile_attempt', body: { outcome: 'outcome_unknown', reason: reasonCode, attempt, nextEligibleAt } });
  // Keep the op durably marked outcome_unknown (never silently reverts to
  // 'attempted') — a no-op transition if it is already there.
  try {
    const op = store.getOperationByOpId(orgId, opId);
    if (op && op.state === 'attempted') store.transitionOperation(orgId, opId, 'outcome_unknown');
  } catch { /* best effort */ }
  return { success: false, pending: true, error: 'provider_unreachable', opId, attempt, nextEligibleAt, capped: attempt >= BACKOFF_MINUTES.length };
}

/**
 * Compare a provider event resource against the proposal it should match.
 * Deliberately simple field-by-field equality — this is a divergence flag
 * for a human, not a merge/patch decision.
 */
function eventMatchesProposal(providerEvent, proposal) {
  if (!providerEvent || providerEvent.id !== proposal.opId) return false;
  if ((providerEvent.summary || '') !== proposal.title) return false;
  const start = providerEvent.start || {};
  const end = providerEvent.end || {};
  if (proposal.allDay) {
    const wantStart = new Date(proposal.startTs).toISOString().slice(0, 10);
    const wantEnd = new Date(proposal.endTs).toISOString().slice(0, 10);
    if (start.date !== wantStart || end.date !== wantEnd) return false;
  } else {
    if (!start.dateTime || Date.parse(start.dateTime) !== proposal.startTs) return false;
    if (!end.dateTime || Date.parse(end.dateTime) !== proposal.endTs) return false;
  }
  return true;
}

/**
 * @param {string} orgId
 * @param {string} opId
 * @param {object} [opts] { nowMs, fetchImpl, audit, agentId }
 */
async function reconcileOperation(orgId, opId, { nowMs = Date.now(), fetchImpl = fetch, audit = () => {}, agentId = null } = {}) {
  if (!orgId) throw new Error('reconcileOperation requires orgId');
  if (!opId) return { success: false, error: 'opId is required' };

  const op = store.getOperationByOpId(orgId, opId);
  if (!op) return { success: false, error: 'operation_not_found' };

  if (!['attempted', 'outcome_unknown'].includes(op.state)) {
    return { success: false, error: `operation is in state '${op.state}'; nothing to reconcile`, opId, state: op.state };
  }

  // Bounded retry eligibility — never hammer an unreachable provider.
  const last = lastAttemptReceipt(orgId, opId);
  if (last && last.body && last.body.nextEligibleAt && nowMs < last.body.nextEligibleAt) {
    return { success: false, pending: true, error: 'reconcile_backoff', opId, nextEligibleAt: last.body.nextEligibleAt };
  }

  const proposal = op.proposal;
  const connection = store.getConnection(orgId, proposal.connectionId);
  if (!connection) return applyBackoff(orgId, opId, nowMs, 'connection_unavailable');

  let cred;
  try {
    cred = await resolveGoogleCredential(orgId, connection.credentialRef, { agentId, fetchImpl });
  } catch (e) {
    return applyBackoff(orgId, opId, nowMs, e.code || 'credential_unavailable');
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(cred, { fetchImpl, nowMs });
  } catch (e) {
    return applyBackoff(orgId, opId, nowMs, e.code || 'token_refresh_failed');
  }

  let providerEvent;
  try {
    providerEvent = await getEvent({ accessToken, calendarId: connection.resourceId, eventId: opId, fetchImpl });
  } catch (e) {
    if (e.code === 'not_found') {
      store.transitionOperation(orgId, opId, 'failed');
      store.insertReceipt({ orgId, opId, kind: 'reconcile', body: { outcome: 'failed', reason: 'provider_never_committed' } });
      try { audit({ type: 'action', intent: 'quox.calendar.reconcile', corr: opId, payload: { orgId, opId, outcome: 'failed' } }); } catch { /* non-fatal */ }
      return { success: true, opId, outcome: 'failed', reason: 'provider_never_committed' };
    }
    return applyBackoff(orgId, opId, nowMs, e.code || 'provider_unreachable');
  }

  if (eventMatchesProposal(providerEvent, proposal)) {
    store.transitionOperation(orgId, opId, 'confirmed', { providerResult: providerEvent });
    store.insertReceipt({ orgId, opId, kind: 'reconcile', body: { outcome: 'confirmed', providerEventId: providerEvent.id, htmlLink: providerEvent.htmlLink || null } });
    try { audit({ type: 'action', intent: 'quox.calendar.reconcile', corr: opId, payload: { orgId, opId, outcome: 'confirmed' } }); } catch { /* non-fatal */ }
    return { success: true, opId, outcome: 'confirmed', providerEventId: providerEvent.id, htmlLink: providerEvent.htmlLink || null };
  }

  store.transitionOperation(orgId, opId, 'partial', { providerResult: providerEvent });
  store.insertReceipt({ orgId, opId, kind: 'reconcile', body: { outcome: 'partial', reason: 'provider_event_diverges_from_proposal', providerEvent } });
  try { audit({ type: 'action', intent: 'quox.calendar.reconcile', corr: opId, payload: { orgId, opId, outcome: 'partial' } }); } catch { /* non-fatal */ }
  return { success: true, opId, outcome: 'partial', reason: 'provider_event_diverges_from_proposal' };
}

/**
 * Restart sweep: every operation stuck in 'attempted' older than the
 * threshold, across every org, gets a reconcile attempt — durable (the
 * backoff bookkeeping above still applies per-op) and capped (BACKOFF_
 * MINUTES is finite; a permanently-unreachable provider stops being retried
 * every tick forever once capped). Never throws on one op's failure — a
 * sweep must survive a single bad op.
 */
async function sweepStuckAttempted({ nowMs = Date.now(), fetchImpl = fetch, audit = () => {}, thresholdMs = RECONCILE_STUCK_THRESHOLD_MS } = {}) {
  let stuck = [];
  try {
    stuck = store.listAllOperationsByState('attempted').filter((op) => (nowMs - new Date(op.updatedAt).getTime()) >= thresholdMs);
  } catch {
    return { swept: 0 };
  }
  let swept = 0;
  for (const op of stuck) {
    try {
      await reconcileOperation(op.orgId, op.opId, { nowMs, fetchImpl, audit });
      swept += 1;
    } catch {
      // One stuck op's reconcile failure must never stop the sweep.
    }
  }
  return { swept, found: stuck.length };
}

module.exports = { reconcileOperation, sweepStuckAttempted, eventMatchesProposal, BACKOFF_MINUTES, RECONCILE_STUCK_THRESHOLD_MS };
