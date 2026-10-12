/**
 * Inbox Response Classifier — HITL-DENY-FIX
 *
 * Classifies a human's inbox `respond` action as an explicit denial. This is
 * the single source of truth for "does this action mean the human said no",
 * used by routes/inbox.js's respond handler to decide:
 *   - the VOLT witness decision ('denied' vs 'granted')
 *   - whether a paused QuoxFlow execution resumes with approved:false
 *   - whether a pending credential lease is denied vs approved
 *
 * QuoxCLI's `inbox respond --action <action>` documents and accepts
 * approve/reject/defer/resolve and passes the raw string straight through
 * (cli/lib/commands/inbox.js), so this must tolerate case and surrounding
 * whitespace rather than only matching an exact literal.
 *
 * Pure, side-effect-free — safe to unit test in isolation.
 */

// Every action string that means the human explicitly denied/rejected the
// request. Keep this as the ONLY list — do not re-hardcode these literals
// elsewhere; call isDenyAction() instead so the set cannot drift out of sync.
const DENY_ACTIONS = new Set(['deny', 'denied', 'dismissed', 'reject', 'rejected']);

/**
 * @param {string} action - raw action string from the request body
 * @returns {boolean} true if the action is an explicit denial
 */
export function isDenyAction(action) {
  if (typeof action !== 'string') return false;
  return DENY_ACTIONS.has(action.trim().toLowerCase());
}

// Every action string that means the human EXPLICITLY approved/granted the
// request. This is the allowlist counterpart to DENY_ACTIONS. A privileged
// approval side effect (granting a credential lease, resuming a paused
// workflow as approved) may fire ONLY when isApproveAction() is true. An
// action that is neither an approve nor a deny (a typo, an empty string,
// "defer", "resolve") must perform no approval side effect at all, so an
// unrecognised action can never be read as consent. The real approve surfaces
// send 'approve' (InboxItemDetailView generic buttons) and 'approved' (the
// detail view resolution control); accept/grant variants are included for
// custom action sets and the CLI. Keep this as the ONLY approve list; call
// isApproveAction() rather than re-hardcoding these literals.
const APPROVE_ACTIONS = new Set(['approve', 'approved', 'accept', 'accepted', 'grant', 'granted']);

/**
 * @param {string} action - raw action string from the request body
 * @returns {boolean} true if the action is an explicit approval
 */
export function isApproveAction(action) {
  if (typeof action !== 'string') return false;
  return APPROVE_ACTIONS.has(action.trim().toLowerCase());
}
