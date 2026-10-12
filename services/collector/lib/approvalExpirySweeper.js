'use strict';

/**
 * approvalExpirySweeper.js — APPROVAL-SPAM 3/6 (owner yes, 2026-10-03).
 *
 * "Do it now" execution approvals (a shell command, a restart, a VM action)
 * that nobody decided within the hour are meaningless later, yet they piled up:
 * 20 stale cards in the owner's inbox and ~1000 orphaned pending rows (a
 * Discord bridge poller blocked on approval every minute for 12 hours). This
 * sweeper expires them and closes their human-facing card through the governed
 * auth route.
 *
 * 2026-10-10: it now closes EVERY tool's card at APPROVAL_MAX_AGE_MS, the same
 * age at which toolResume.js refuses to run it. It used to skip "meant to wait"
 * tools (x_post, email_send, notesq_update), but the resume path refused those
 * after an hour anyway, so their cards sat approvable and a late Approve did
 * nothing while the card said approved. A card must never outlive its ability
 * to run. If drafts should wait longer, raise the shared lifetime for them in
 * approvalTtl.js so both sides move together.
 *
 * Loop hygiene (CLAUDE.md): bounded batch per tick; card-close failures are
 * counted distinctly from expiries; the row is expired first (CAS), so it is
 * durably retired and never picked again even if closing the card failed. An
 * expired approval cannot be resumed (claimForResume only claims 'pending').
 */

const { APPROVAL_MAX_AGE_MS } = require('./approvalTtl.js');

const DEFAULT_TTL_MS = APPROVAL_MAX_AGE_MS;
const BATCH = 200;

function createApprovalExpirySweeper({ store, cancelCard, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, log = console.log } = {}) {
  if (!store || typeof cancelCard !== 'function') throw new Error('approvalExpirySweeper: store and cancelCard are required');

  async function closeCard(r) {
    if (!r.org_id) { store.setExpiryCloseState(r.approval_id, true); return true; }
    let ok = false;
    try {
      ok = (await cancelCard(r.org_id, r.approval_id, `expired: no decision within ${Math.round(ttlMs / 60000)} minutes`)) !== false;
    } catch { ok = false; }
    // A failed close parks the row in a non-resumable retry state instead of
    // leaving a card nobody can act on (live 2026-10-03: the first sweep ran
    // while auth was restarting and every close failed).
    store.setExpiryCloseState(r.approval_id, ok);
    return ok;
  }

  async function tick() {
    let cardsRetried = 0; let cardFailures = 0;
    for (const r of store.listCloseRetries({ limit: BATCH })) {
      if (await closeCard(r)) cardsRetried += 1; else cardFailures += 1;
    }
    const rows = store.listStalePending({ olderThan: now() - ttlMs, limit: BATCH });
    let expired = 0;
    for (const r of rows) {
      if (!store.expirePending(r.approval_id)) continue; // someone decided it meanwhile
      expired += 1;
      if (!(await closeCard(r))) cardFailures += 1;
    }
    if (expired || cardFailures || cardsRetried) {
      log(`[ApprovalExpiry] expired ${expired}; card closes retried ok ${cardsRetried}; card-close failures ${cardFailures}`);
    }
    return { expired, cardFailures, cardsRetried, scanned: rows.length };
  }

  return { tick };
}

module.exports = { createApprovalExpirySweeper, DEFAULT_TTL_MS };
