'use strict';

/**
 * Calendar-Q gated event creation (L2-C2 U2) — the trust-critical write path.
 *
 * executeCreateEvent is called from INSIDE withApprovalGate's executeAction
 * closure (see calendarqTools.js's calendar_event_create), i.e. it only ever
 * runs once a human has approved, or (never, in this phase — calendar_event_
 * create is unconditionally agent-gated, see approvalGate.js's
 * AGENT_ALWAYS_PROPOSE_TOOLS) when no approval was required at all. This
 * module owns NO approval logic of its own — withApprovalGate is the only
 * approval gate, consumed exactly like every other gated tool (bobTools.js's
 * bob_mark_build_outcome). What this module DOES own is the revalidation a
 * human's earlier approval cannot itself express: is the thing we are about
 * to create still the thing that was approved, right now, moments before we
 * tell a real calendar provider to create it.
 *
 * Order of operations (phase brief, verbatim):
 *   1. load op; legal states proposed/awaiting_approval; expired -> fail
 *   2. revalidate: connection ok, same resource identity, credential
 *      resolvable, effect digest unchanged since approval was sought
 *   3. FRESH conflict check (bounded sync if the published data is stale)
 *   4. transition -> 'attempted' DURABLY + pre-write AEE envelope, BEFORE
 *      the provider call; an audit-emit failure fails closed, provider
 *      never called
 *   5. the provider call itself, with exactly three possible outcomes
 *   6. persist provider_result_json + a receipt + a post-write AEE envelope
 */

const store = require('./store');
const { runSync } = require('./syncWorker');
const { resolveGoogleCredential, getAccessToken, insertEvent } = require('./providers/google');
const { computeEffectDigest, findOverlaps, findOperationByProposalId } = require('./proposals');

// How stale the latest published generation's watermark may be, relative to
// the proposal's own conflictCheckedAt, before execute triggers a bounded
// re-sync rather than trusting the disclosed-at-propose-time conflict set.
const CONFLICT_RECHECK_TOLERANCE_MS = 5 * 60 * 1000;

function recordReceipt(orgId, opId, kind, body) {
  try { store.insertReceipt({ orgId, opId, kind, body }); } catch { /* receipt-write failure must never mask the real outcome below */ }
}

function failOp(orgId, opId, reason, extra = {}) {
  try { store.transitionOperation(orgId, opId, 'failed'); } catch { /* already terminal/race-lost; outcome below still reports the reason */ }
  recordReceipt(orgId, opId, 'create', { outcome: 'failed', reason, ...extra });
  return { success: false, error: reason, opId, ...extra };
}

/** Map our internal visibility enum to Google's. Inverse of providers/
 * google.js's VISIBILITY_MAP (which maps Google -> ours on read). */
const OUTGOING_VISIBILITY = { default: 'default', private: 'private', 'busy-only': 'confidential' };

function buildEventBody(proposal) {
  const body = {
    summary: proposal.title,
    description: proposal.description || undefined,
    visibility: OUTGOING_VISIBILITY[proposal.visibility] || 'default',
  };
  if (proposal.allDay) {
    body.start = { date: new Date(proposal.startTs).toISOString().slice(0, 10) };
    body.end = { date: new Date(proposal.endTs).toISOString().slice(0, 10) };
  } else {
    body.start = { dateTime: new Date(proposal.startTs).toISOString(), timeZone: proposal.timezone };
    body.end = { dateTime: new Date(proposal.endTs).toISOString(), timeZone: proposal.timezone };
  }
  if (proposal.attendees.length > 0) body.attendees = proposal.attendees.map((a) => ({ email: a.email }));
  return body;
}

/**
 * @param {string} orgId
 * @param {{proposalId:string}} input
 * @param {object} [opts] { nowMs, fetchImpl, audit, agentId }
 * @returns {Promise<object>} never throws for an expected outcome; only a
 *   programmer error (bad orgId/missing proposalId) throws.
 */
async function executeCreateEvent(orgId, { proposalId } = {}, { nowMs = Date.now(), fetchImpl = fetch, audit = () => {}, agentId = null } = {}) {
  if (!orgId) throw new Error('executeCreateEvent requires orgId');
  if (!proposalId) return { success: false, error: 'proposalId is required' };

  const op = findOperationByProposalId(orgId, proposalId);
  if (!op) return { success: false, error: 'proposal_not_found' };

  // Sequential double-execute: a SECOND call arriving after the first has
  // already moved the op past awaiting_approval refuses immediately, before
  // any revalidation work. (The CONCURRENT race — both calls reading
  // 'awaiting_approval' before either writes — is caught later, at the
  // 'attempted' transition itself; see the try/catch around it below.)
  if (op.state === 'attempted' || op.state === 'outcome_unknown') {
    return { success: false, error: 'reconcile_first', opId: op.opId, state: op.state };
  }
  if (op.state !== 'proposed' && op.state !== 'awaiting_approval') {
    return { success: false, error: `operation is in terminal state '${op.state}'`, opId: op.opId, state: op.state };
  }

  const proposal = op.proposal;

  if (proposal.expiresAt <= nowMs) {
    return failOp(orgId, op.opId, 'proposal_expired');
  }

  // Capture the digest the approval process is bound to the FIRST time we
  // see this op post-propose — idempotent, never re-stamped on a resumed
  // call (see store.js's approval_bound_digest doc comment for why this is
  // a SEPARATE field from proposal.effectDigest, not just a re-read of it).
  let current = op;
  if (current.state === 'proposed') {
    try {
      current = store.transitionOperation(orgId, op.opId, 'awaiting_approval', { approvalBoundDigest: proposal.effectDigest });
    } catch {
      // Another concurrent call already made this hop — re-read and proceed
      // with whatever is actually there now.
      current = store.getOperationByOpId(orgId, op.opId);
    }
  }

  // --- (2) revalidate -------------------------------------------------------

  const connection = store.getConnection(orgId, proposal.connectionId);
  if (!connection || connection.status !== 'active') {
    return failOp(orgId, op.opId, 'connection_unavailable');
  }
  if (connection.resourceId !== proposal.resourceId) {
    return failOp(orgId, op.opId, 'resource_identity_changed');
  }

  // Self-consistency: did proposal_json's content fields drift out of step
  // with its own stored effectDigest (a stale-digest bug, or a direct tamper
  // of the stored row)?
  const recomputedDigest = computeEffectDigest(proposal);
  if (recomputedDigest !== proposal.effectDigest) {
    return failOp(orgId, op.opId, 'effect_drift', { detail: 'proposal content no longer matches its own stored effectDigest' });
  }
  // The TOCTOU check: did the effect change at all since the approval was
  // sought, even if the stored proposal is (now) internally self-consistent
  // at a NEW digest? approvalBoundDigest is written exactly once, never
  // touched by anything that also rewrites proposal_json.
  if (current.approvalBoundDigest && current.approvalBoundDigest !== recomputedDigest) {
    return failOp(orgId, op.opId, 'effect_drift', { detail: 'the effect changed after a human was asked to approve it' });
  }

  let cred;
  try {
    cred = await resolveGoogleCredential(orgId, connection.credentialRef, { agentId, fetchImpl });
  } catch (e) {
    return failOp(orgId, op.opId, 'credential_unavailable', { detail: e.code || e.message });
  }

  // --- (3) fresh conflict check ----------------------------------------------

  let published = store.readPublishedOccurrences(orgId, proposal.connectionId);
  const watermarkTs = published ? (published.generation.watermarkTs || 0) : 0;
  if (watermarkTs < proposal.preconditions.conflictCheckedAt - CONFLICT_RECHECK_TOLERANCE_MS) {
    let syncResult;
    try {
      syncResult = await runSync(orgId, proposal.connectionId, { fetchImpl, nowMs, agentId });
    } catch (e) {
      return failOp(orgId, op.opId, 'conflict_recheck_failed', { detail: e.message });
    }
    if (syncResult && syncResult.failed) {
      return failOp(orgId, op.opId, 'conflict_recheck_failed', { detail: syncResult.error });
    }
    published = store.readPublishedOccurrences(orgId, proposal.connectionId);
  }

  const currentOverlaps = findOverlaps(published ? published.occurrences : [], proposal);
  const knownKeys = new Set(proposal.preconditions.knownOverlapKeys || []);
  const newOverlapKeys = currentOverlaps.map((o) => o.occurrenceKey).filter((k) => !knownKeys.has(k));
  if (newOverlapKeys.length > 0) {
    return failOp(orgId, op.opId, 'stale_conflict_evidence', { newOverlapKeys });
  }

  // --- (4) transition -> attempted, THEN the pre-write audit envelope -------
  //
  // The transitionOperation call itself is the durable attempted-claim lock
  // for a genuinely concurrent double-execute: better-sqlite3 never yields
  // mid-call, so whichever caller's JS turn reaches this line first commits
  // it; the loser's own call reaches this same line later, re-reads the
  // now-'attempted' row, and gets an illegal-transition throw here — caught
  // below and reported as reconcile_first, never a second provider call.

  try {
    store.transitionOperation(orgId, op.opId, 'attempted');
  } catch {
    return { success: false, error: 'reconcile_first', opId: op.opId, state: 'attempted' };
  }

  try {
    audit({ type: 'action', intent: 'quox.calendar.create', corr: op.opId, payload: { orgId, opId: op.opId, proposalId, phase: 'pre_write' } });
  } catch (e) {
    return failOp(orgId, op.opId, 'audit_emit_failed', { detail: e.message });
  }

  // --- (5) the provider call ---------------------------------------------------

  let accessToken;
  try {
    accessToken = await getAccessToken(cred, { fetchImpl, nowMs });
  } catch (e) {
    return failOp(orgId, op.opId, 'token_refresh_failed', { detail: e.code || e.message });
  }

  const sendUpdates = proposal.notifyPolicy === 'attendees' ? 'all' : 'none';
  const eventBody = buildEventBody(proposal);

  let providerResult;
  try {
    providerResult = await insertEvent({ accessToken, calendarId: connection.resourceId, eventId: op.opId, eventBody, sendUpdates, fetchImpl });
  } catch (e) {
    if (e.code === 'network_lost') {
      try { store.transitionOperation(orgId, op.opId, 'outcome_unknown'); } catch { /* best effort */ }
      recordReceipt(orgId, op.opId, 'create', { outcome: 'outcome_unknown', reason: 'network_lost' });
      return {
        success: false, pending: true, error: 'outcome_unknown', opId: op.opId,
        message: 'The request was dispatched to the provider but the response was lost. Use calendar_reconcile before attempting again.',
      };
    }
    return failOp(orgId, op.opId, 'provider_error', { detail: e.message, status: e.status, providerBody: e.body });
  }

  if (!providerResult || providerResult.id !== op.opId) {
    try { store.transitionOperation(orgId, op.opId, 'partial', { providerResult }); } catch { /* best effort */ }
    recordReceipt(orgId, op.opId, 'create', { outcome: 'partial', reason: 'provider_identity_mismatch', providerResult });
    return { success: false, error: 'provider_identity_mismatch', opId: op.opId };
  }

  // AQ-9B audit fix 4: reconcile.js's restart sweep can independently resolve
  // THIS SAME op straight to 'confirmed' (its own events.get call found the
  // provider already committed it) in the window between our insertEvent
  // call returning above and this transition landing — ALLOWED_TRANSITIONS
  // forbids confirmed -> confirmed, so that race throws here rather than
  // silently double-writing. Re-read on catch: if the op already landed on
  // 'confirmed' with the SAME provider identity we just created, this is
  // that exact benign race (reconcile won, not a real conflict) and the
  // genuine success shape is returned rather than leaking the transition
  // error; any other re-read state is a real, unexplained loss of the race.
  try {
    store.transitionOperation(orgId, op.opId, 'confirmed', { providerResult });
  } catch (transitionErr) {
    const reReadOp = store.getOperationByOpId(orgId, op.opId);
    if (reReadOp && reReadOp.state === 'confirmed' && reReadOp.providerResult && reReadOp.providerResult.id === providerResult.id) {
      return { success: true, opId: op.opId, providerEventId: reReadOp.providerResult.id, htmlLink: reReadOp.providerResult.htmlLink || null, state: 'confirmed' };
    }
    return failOp(orgId, op.opId, 'transition_race_lost', { detail: transitionErr.message });
  }

  recordReceipt(orgId, op.opId, 'create', {
    outcome: 'confirmed',
    effect: { title: proposal.title, startTs: proposal.startTs, endTs: proposal.endTs, timezone: proposal.timezone, attendees: proposal.attendees, notifyPolicy: proposal.notifyPolicy },
    providerEventId: providerResult.id,
    htmlLink: providerResult.htmlLink || null,
    etag: providerResult.etag || null,
  });
  try {
    audit({ type: 'action', intent: 'quox.calendar.create', corr: op.opId, payload: { orgId, opId: op.opId, proposalId, phase: 'confirmed' } });
  } catch { /* post-write audit failure does not undo a confirmed, provider-evidenced create */ }

  return { success: true, opId: op.opId, providerEventId: providerResult.id, htmlLink: providerResult.htmlLink || null, state: 'confirmed' };
}

module.exports = { executeCreateEvent, buildEventBody, CONFLICT_RECHECK_TOLERANCE_MS };
