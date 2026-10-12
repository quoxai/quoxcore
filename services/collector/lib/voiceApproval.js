'use strict';

/**
 * QUOXHAT MISSION D2 — the voice on-the-fly approval interface (collector half).
 *
 * A gated tool call does NOT pause the turn: withApprovalGate (approvalGate.js)
 * returns a pending tool_result ({ pending:true, status:'awaiting_approval',
 * approvalId, inbox_item_id, _approval:{id,status} }) that Claude narrates in
 * prose. The voice bridge cannot act on prose. This module extracts that pending
 * state into a structured, machine-readable signal the bridge can detect, so it
 * can collect an on-the-fly keypad re-PIN and resolve the approval server-side
 * instead of telling a phone caller to "go click it in the dashboard".
 *
 * extractPendingApproval scans a turn's toolExecutions and returns the most
 * recent pending approval, or null. It is additive and nullable — existing
 * callers that ignore `needs_approval` are unaffected.
 */

/**
 * @param {Array<{name?:string, result?:object}>} toolExecutions
 * @returns {{approval_id:string, inbox_item_id:string|null, tool:string|null,
 *            summary:string, risk:string|null} | null}
 */
function extractPendingApproval(toolExecutions) {
  if (!Array.isArray(toolExecutions)) return null;
  // The LAST pending approval in the turn is the live ask the caller must act on.
  for (let i = toolExecutions.length - 1; i >= 0; i--) {
    const te = toolExecutions[i];
    const r = te && te.result;
    if (!r || typeof r !== 'object') continue;
    const pending = r.pending === true
      || r.status === 'awaiting_approval'
      || (r._approval && typeof r._approval === 'object' && r._approval.status === 'pending');
    if (!pending) continue;
    const approvalId = r.approvalId
      || (r._approval && r._approval.id)
      || r.inbox_item_id
      || null;
    if (!approvalId) continue; // a pending shape with no id is not actionable
    return {
      approval_id: String(approvalId),
      inbox_item_id: r.inbox_item_id ? String(r.inbox_item_id) : null,
      tool: te.name || null,
      summary: r.summary || r.message || `Approval required to run ${te.name || 'a tool'}`,
      risk: r.risk || (r._approval && r._approval.risk) || null,
    };
  }
  return null;
}

/**
 * QUOXHAT MISSION D2 — delegation propagation.
 *
 * On the phone, CommanderQ under its hat presents no directly-gated write tool,
 * so a risky action is DELEGATED to a specialist and the approval gate fires in
 * the specialist's SUB-turn. The specialist's /chat response carries its own
 * needs_approval (extractPendingApproval ran on ITS toolExecutions). But the
 * ORCHESTRATOR's own toolExecutions for that turn are just [delegate_to_agent],
 * so without help the top-level needs_approval is null and the voice bridge never
 * sees the pending approval.
 *
 * This maps a delegated sub-turn's needs_approval into the pending-result shape
 * extractPendingApproval detects, to be MERGED onto the delegate_to_agent tool
 * result. The surfaced approvalId is the SUB-AGENT's approval id (= that sub-turn's
 * inbox item aee_correlation_id) — the exact id /api/internal/voice/approval/resolve
 * acts on, so re-PIN -> resolve runs the delegated action, witnessed. Returns {}
 * when the sub-turn had no actionable pending approval (so a normal delegation
 * surfaces nothing).
 *
 * @param {{approval_id?:string, inbox_item_id?:string|null, summary?:string, risk?:string|null}|null} needsApproval
 * @returns {object} fields to spread onto the delegate tool result (possibly {})
 */
function pendingApprovalResultFields(needsApproval) {
  if (!needsApproval || !needsApproval.approval_id) return {};
  return {
    status: 'awaiting_approval',
    approvalId: needsApproval.approval_id,
    inbox_item_id: needsApproval.inbox_item_id || null,
    _approval: { id: needsApproval.approval_id, status: 'pending' },
    summary: needsApproval.summary || 'Approval required (delegated to a specialist)',
    risk: needsApproval.risk || null,
    delegated: true,
  };
}

module.exports = { extractPendingApproval, pendingApprovalResultFields };
