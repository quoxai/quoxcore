'use strict';

/**
 * QUOXHAT MISSION D2 — turn-scoped pending-approval registry (collector, in-process).
 *
 * The problem it solves: the voice bridge detects on-the-fly approvals by reading
 * needs_approval off a /chat response, and the response builders derive that from
 * extractPendingApproval(toolExecutions). But on the OAuth/CLI executor path the
 * dispatcher records toolExecutions with result:null (claudeCliDispatcher.js:539
 * /:1055 — the claude subprocess only returns tool NAMES, not result objects), so
 * the pending-approval shape is simply absent from toolExecutions. And on the
 * phone CommanderQ never calls a gated tool directly — it DELEGATES, and the gate
 * fires in the specialist's sub-turn.
 *
 * withApprovalGate records the approval HERE the moment it is created. That runs
 * in the collector process on EVERY path (direct, CLI/MCP via /api/v1/tools/execute,
 * and delegated sub-turns — which carry the orchestrator's own session_id, see
 * delegate_to_agent buildBody). The response builders then read it back keyed by
 * the turn's session, PATH- and DELEGATION-independently.
 *
 * peek (not consume) + TTL: the delegated sub-turn's builder and the orchestrator's
 * builder both read the same entry, so consuming would starve the second reader.
 * A still-pending approval re-surfacing on a later same-session turn is safe — the
 * resolve endpoint (/api/internal/voice/approval/resolve) is idempotent. The entry
 * self-expires so it cannot linger indefinitely. Follow-up (not here): clear on
 * resolve so a resolved approval stops re-surfacing before its TTL.
 *
 * Date.now() is used for the default clock (collector runtime; the Date.now()
 * restriction is specific to Workflow scripts). now is injectable for tests.
 */

const TTL_MS = 90_000;  // a pending approval is relevant only around the turn that created it
const MAX = 2_000;      // backstop against unbounded growth (Loop Hygiene)

const _byKey = new Map(); // sessionKey -> { approval, ts }

function _key(k) { return (k === 0 || k) ? String(k) : null; }

function _sweep(now) {
  if (_byKey.size === 0) return;
  for (const [k, v] of _byKey) {
    if (now - v.ts > TTL_MS) _byKey.delete(k);
  }
  if (_byKey.size > MAX) {
    // Evict oldest first down to the cap.
    const entries = [..._byKey.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const over = _byKey.size - MAX;
    for (let i = 0; i < over; i++) _byKey.delete(entries[i][0]);
  }
}

/**
 * Record a pending approval created during a turn.
 * @param {string} sessionKey - ctx.conversationId || ctx.session_id of the gated turn
 * @param {{approval_id:string, inbox_item_id?:string|null, tool?:string|null, summary?:string, risk?:string|null}} approval
 * @param {number} [now]
 */
function recordPendingApproval(sessionKey, approval, now) {
  const k = _key(sessionKey);
  if (!k || !approval || !approval.approval_id) return;
  const t = typeof now === 'number' ? now : Date.now();
  _byKey.set(k, { approval, ts: t });
  _sweep(t); // after the set, so the result is always <= MAX (not MAX+1)
}

/**
 * Read (without consuming) the pending approval for a session, honouring the TTL.
 * @returns {object|null} the recorded approval, or null if none / expired.
 */
function peekPendingApproval(sessionKey, now) {
  const k = _key(sessionKey);
  if (!k) return null;
  const v = _byKey.get(k);
  if (!v) return null;
  const t = typeof now === 'number' ? now : Date.now();
  if (t - v.ts > TTL_MS) { _byKey.delete(k); return null; }
  return v.approval;
}

/** Test-only helpers. */
function _clear() { _byKey.clear(); }
function _size() { return _byKey.size; }

module.exports = {
  recordPendingApproval, peekPendingApproval,
  _clear, _size, _TTL_MS: TTL_MS, _MAX: MAX,
};
