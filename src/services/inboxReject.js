/**
 * inboxReject — small pure helpers for the "reject with reason" flow.
 *
 * A deny / request-changes resolution should capture a reason; an approve is
 * one-click (no reason needed). Kept pure + exported so the decision is unit
 * tested independently of the (owner-QA'd) modal UI.
 */

/** Outcomes that should prompt the user for a reason before resolving. */
export function denyNeedsReason(outcome) {
    return (
        outcome === 'denied' ||
        outcome === 'deny' ||
        outcome === 'reject' ||
        outcome === 'request_changes'
    );
}
