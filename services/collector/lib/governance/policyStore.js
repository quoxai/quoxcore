/**
 * OPGOV quox#582 phase 2 — draft/arm store for compiled policies.
 * devServersStore pattern: dependency-injected better-sqlite3 handle (the
 * shared aeeDb), schema in migrations/aee/032-governance-policies.sql, no
 * server.js import, unit-tested against an in-memory db.
 *
 * The state machine is the review gate: drafts are inspectable and inert
 * (policyDsl.evaluatePolicies ignores anything not armed), and arming
 * REQUIRES a human approver identity. There is no path from compile to
 * armed in one step.
 */

'use strict';

function rowToRecord(row) {
  if (!row) return null;
  let policy = null;
  try { policy = JSON.parse(row.policy_json); } catch { policy = null; }
  return {
    id: row.id,
    org_id: row.org_id,
    rule_text: row.rule_text,
    state: row.state,
    created_by: row.created_by,
    created_at: row.created_at,
    approved_by: row.approved_by,
    armed_at: row.armed_at,
    policy,
  };
}

function saveDraft(db, { orgId, policy, createdBy, nowIso }) {
  const createdAt = (typeof nowIso === 'function' && nowIso()) || new Date().toISOString();
  db.prepare(
    `INSERT INTO governance_policies (id, org_id, rule_text, policy_json, state, created_by, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(policy.id, orgId, policy.rule_text, JSON.stringify(policy), createdBy || null, createdAt);
  return getPolicy(db, orgId, policy.id);
}

function getPolicy(db, orgId, id) {
  return rowToRecord(db.prepare(
    'SELECT * FROM governance_policies WHERE org_id = ? AND id = ?',
  ).get(orgId, id));
}

function listPolicies(db, orgId, { state } = {}) {
  const rows = state
    ? db.prepare('SELECT * FROM governance_policies WHERE org_id = ? AND state = ? ORDER BY created_at DESC').all(orgId, state)
    : db.prepare('SELECT * FROM governance_policies WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
  return rows.map(rowToRecord);
}

/**
 * Arm a draft. approvedBy is REQUIRED and must be a human identity string;
 * the route enforces "not a bare service key", this enforces non-empty. The
 * stored policy_json's own state field moves with the row so a policy
 * document read from the store is self-describing.
 */
function armPolicy(db, { orgId, id, approvedBy, nowIso }) {
  if (!approvedBy || typeof approvedBy !== 'string') {
    return { ok: false, error: 'human_approval_required' };
  }
  const existing = getPolicy(db, orgId, id);
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.state !== 'draft') return { ok: false, error: `not_a_draft:${existing.state}` };
  const armedAt = (typeof nowIso === 'function' && nowIso()) || new Date().toISOString();
  const armedPolicy = { ...existing.policy, state: 'armed' };
  db.prepare(
    `UPDATE governance_policies SET state = 'armed', approved_by = ?, armed_at = ?, policy_json = ?
     WHERE org_id = ? AND id = ?`,
  ).run(approvedBy, armedAt, JSON.stringify(armedPolicy), orgId, id);
  return { ok: true, policy: getPolicy(db, orgId, id) };
}

module.exports = { saveDraft, getPolicy, listPolicies, armPolicy };
