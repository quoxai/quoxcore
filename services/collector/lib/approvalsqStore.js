/**
 * ApprovalsQ escalation ledger accessors (table: migrations/volt/009).
 * Thin, synchronous better-sqlite3 wrappers. Nothing here touches the HITL
 * approval items themselves: the ledger only records escalation state.
 */

'use strict';

const OUTCOMES = ['answered', 'no_answer', 'voicemail', 'error'];
const DECISIONS = ['approve', 'deny'];
const UPDATABLE = ['item_id', 'state', 'attempts', 'last_attempt_at', 'next_attempt_at', 'last_outcome', 'last_call_sid'];
const RETIRED = new Set(['resolved', 'exhausted', 'cancelled']);

function createApprovalsqStore(db) {
  const getStmt = db.prepare('SELECT * FROM approvalsq_escalations WHERE org_id = ? AND approval_id = ?');
  const getByIdStmt = db.prepare('SELECT * FROM approvalsq_escalations WHERE id = ?');
  const insertStmt = db.prepare(
    `INSERT INTO approvalsq_escalations (id, org_id, approval_id, item_id) VALUES (@id, @org_id, @approval_id, @item_id)`
  );
  const activeStmt = db.prepare(
    "SELECT * FROM approvalsq_escalations WHERE org_id = ? AND state IN ('pending','calling') ORDER BY created_at"
  );
  const recentStmt = db.prepare(
    'SELECT * FROM approvalsq_escalations WHERE org_id = ? ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC LIMIT ?'
  );

  function update(id, patch) {
    const cols = UPDATABLE.filter((c) => Object.prototype.hasOwnProperty.call(patch, c));
    const sets = cols.map((c) => `${c} = @${c}`);
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE approvalsq_escalations SET ${sets.join(', ')} WHERE id = @id`).run({ ...patch, id });
  }

  /**
   * Bridge callback. Records what the call REPORTED. State moves to
   * 'resolved' only on an explicit approve/deny decision; an 'answered'
   * outcome with no decision never resolves anything. A retired row keeps its
   * state (late callbacks must not resurrect it).
   */
  function recordOutcome(id, { outcome, decision, call_sid } = {}) {
    if (!OUTCOMES.includes(outcome)) return { ok: false, status: 400, error: 'invalid_outcome' };
    const dec = decision === undefined || decision === null ? null : decision;
    if (dec !== null && !DECISIONS.includes(dec)) return { ok: false, status: 400, error: 'invalid_decision' };
    const row = getByIdStmt.get(id);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    const patch = { last_outcome: outcome };
    if (typeof call_sid === 'string' && call_sid) patch.last_call_sid = call_sid.slice(0, 128);
    if (dec !== null && !RETIRED.has(row.state)) patch.state = 'resolved';
    update(id, patch);
    return { ok: true, escalation: getByIdStmt.get(id) };
  }

  return {
    getRow: (orgId, approvalId) => getStmt.get(orgId, approvalId),
    getById: (id) => getByIdStmt.get(id),
    insert: (row) => insertStmt.run({ item_id: null, ...row }),
    update,
    listActive: (orgId) => activeStmt.all(orgId),
    listRecent: (orgId, limit = 50) => recentStmt.all(orgId, Math.min(Math.max(Number(limit) || 50, 1), 200)),
    recordOutcome,
  };
}

module.exports = { createApprovalsqStore, OUTCOMES, DECISIONS };
