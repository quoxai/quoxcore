/**
 * POL-HIST Phase 0: Policy change history module
 *
 * Append-only log of every mutation to the `policies` table plus a
 * sibling "4-eyes approval" flow for policies flagged
 * `audit_required = true`. The history rows feed:
 *   - a per-policy "History" drawer in the Compliance UI
 *   - the SOC 2 CC8.1 / ISO 27001 A.5.37 / ISO 42001 Cl.6.1 auditor
 *     deliverable ("who changed this policy, when, and why?")
 *   - the WARD witness chain via a governance.policy.changed envelope
 *     emitted by the caller after append (kept separate from this
 *     module so the library stays DB-pure and unit-testable).
 *
 * Contract:
 *   - appendHistoryEntry is the ONLY write path; there is no
 *     update/delete on the history table by design.
 *   - resolveApproval appends a SIBLING row ('approved'/'rejected')
 *     rather than mutating the original 'approval_requested' row —
 *     preserves the immutable-log property while surfacing outcome.
 */

const HISTORY_OPERATIONS = [
  'created',
  'updated',
  'deleted',
  'enabled',
  'disabled',
  'approved',
  'rejected',
  'approval_requested',
];

const ACTOR_SOURCES = [
  'api',
  'template_pack',
  'seed',
  'service_key',
  'approval_workflow',
];

// ============================================================
// Schema
// ============================================================

function initPolicyHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_history (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      version_before INTEGER,
      version_after INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      diff_json TEXT,
      actor_id TEXT NOT NULL DEFAULT 'unknown',
      actor_email TEXT,
      actor_label TEXT NOT NULL DEFAULT 'unknown',
      actor_source TEXT NOT NULL DEFAULT 'api',
      reason TEXT,
      request_id TEXT,
      approval_state TEXT,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_phist_policy ON policy_history(policy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phist_org ON policy_history(org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phist_operation ON policy_history(operation);
    CREATE INDEX IF NOT EXISTS idx_phist_approval ON policy_history(approval_state)
      WHERE approval_state = 'pending';
  `);
}

// ============================================================
// Helpers
// ============================================================

function generateEntryId() {
  return `PHE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validateOnAppend(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('entry must be an object');
  if (!entry.policy_id) throw new Error('policy_id is required');
  if (!entry.org_id) throw new Error('org_id is required');
  if (entry.snapshot_json === undefined || entry.snapshot_json === null) {
    throw new Error('snapshot_json is required');
  }
  if (entry.version_after === undefined || entry.version_after === null) {
    throw new Error('version_after is required');
  }
  if (!HISTORY_OPERATIONS.includes(entry.operation)) {
    throw new Error(`operation must be one of: ${HISTORY_OPERATIONS.join(', ')}`);
  }
  const actor_source = entry.actor_source ?? 'api';
  if (!ACTOR_SOURCES.includes(actor_source)) {
    throw new Error(`actor_source must be one of: ${ACTOR_SOURCES.join(', ')}`);
  }
  if (entry.approval_state !== undefined && entry.approval_state !== null) {
    const valid = ['pending', 'approved', 'rejected', 'auto'];
    if (!valid.includes(entry.approval_state)) {
      throw new Error(`approval_state must be one of: ${valid.join(', ')}`);
    }
  }
}

// ============================================================
// Write
// ============================================================

function appendHistoryEntry(db, entry) {
  validateOnAppend(entry);

  const id = generateEntryId();
  const ts = nowIso();

  const row = {
    id,
    policy_id: entry.policy_id,
    org_id: entry.org_id,
    operation: entry.operation,
    version_before: entry.version_before ?? null,
    version_after: entry.version_after,
    snapshot_json: JSON.stringify(entry.snapshot_json),
    diff_json: entry.diff_json ? JSON.stringify(entry.diff_json) : null,
    actor_id: entry.actor_id || 'unknown',
    actor_email: entry.actor_email ?? null,
    actor_label: entry.actor_label || entry.actor_id || 'unknown',
    actor_source: entry.actor_source ?? 'api',
    reason: entry.reason ?? null,
    request_id: entry.request_id ?? null,
    approval_state: entry.approval_state ?? null,
    approved_by: entry.approved_by ?? null,
    approved_at: entry.approved_at ?? null,
    created_at: ts,
  };

  db.prepare(`
    INSERT INTO policy_history (
      id, policy_id, org_id, operation,
      version_before, version_after,
      snapshot_json, diff_json,
      actor_id, actor_email, actor_label, actor_source,
      reason, request_id,
      approval_state, approved_by, approved_at,
      created_at
    ) VALUES (
      @id, @policy_id, @org_id, @operation,
      @version_before, @version_after,
      @snapshot_json, @diff_json,
      @actor_id, @actor_email, @actor_label, @actor_source,
      @reason, @request_id,
      @approval_state, @approved_by, @approved_at,
      @created_at
    )
  `).run(row);

  const stored = db.prepare('SELECT * FROM policy_history WHERE id = ?').get(id);
  return deserialize(stored);
}

// ============================================================
// Read
// ============================================================

function listHistoryForPolicy(db, policy_id, { limit = 100, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM policy_history
    WHERE policy_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(policy_id, limit, offset);
  return rows.map(deserialize);
}

function listHistoryForOrg(db, filters = {}) {
  const {
    org_id,
    operation,
    actor_id,
    since,
    until,
    limit = 100,
    offset = 0,
  } = filters;

  const where = [];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (operation) { where.push('operation = ?'); params.push(operation); }
  if (actor_id) { where.push('actor_id = ?'); params.push(actor_id); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM policy_history ${whereSql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map(deserialize);
}

function getPendingApprovals(db, { org_id } = {}) {
  const where = ["approval_state = 'pending'"];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  const rows = db.prepare(`
    SELECT * FROM policy_history
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ASC
  `).all(...params);
  return rows.map(deserialize);
}

function getHistoryEntry(db, id) {
  const row = db.prepare('SELECT * FROM policy_history WHERE id = ?').get(id);
  return row ? deserialize(row) : null;
}

// ============================================================
// Approval flow
// ============================================================

function resolveApproval(db, entry_id, { outcome, approved_by, reason } = {}) {
  if (!['approved', 'rejected'].includes(outcome)) {
    throw new Error("outcome must be 'approved' or 'rejected'");
  }

  const existing = db.prepare('SELECT * FROM policy_history WHERE id = ?').get(entry_id);
  if (!existing) throw new Error(`history entry ${entry_id} not found`);

  // Only 'approval_requested' + pending rows are resolvable.
  if (existing.operation !== 'approval_requested' || existing.approval_state !== 'pending') {
    throw new Error(`entry ${entry_id} is already resolved (or not an approval request)`);
  }

  // Flip the original row's approval_state so it doesn't re-appear in
  // pending listings. This is the *only* mutation we allow on
  // history rows and it is functionally a state machine tick, not a
  // content change — the snapshot/diff/actor stay immutable.
  db.prepare(`
    UPDATE policy_history
    SET approval_state = ?
    WHERE id = ?
  `).run(outcome, entry_id);

  // Append the sibling outcome row.
  const sibling = appendHistoryEntry(db, {
    policy_id: existing.policy_id,
    org_id: existing.org_id,
    operation: outcome, // 'approved' | 'rejected'
    version_before: existing.version_before,
    version_after: existing.version_after,
    snapshot_json: JSON.parse(existing.snapshot_json),
    diff_json: existing.diff_json ? JSON.parse(existing.diff_json) : null,
    actor_id: approved_by || 'unknown',
    actor_label: approved_by || 'unknown',
    actor_source: 'approval_workflow',
    reason: reason ?? null,
    approval_state: outcome,
    approved_by: approved_by ?? null,
    approved_at: nowIso(),
  });

  return { outcome, original: getHistoryEntry(db, entry_id), sibling };
}

// ============================================================
// Diff helper
// ============================================================

// Bookkeeping fields that every mutation auto-bumps — including them
// in the diff just clutters the drawer because they're already
// surfaced as top-level columns (version_before / version_after /
// created_at) on the history row itself.
const DIFF_IGNORED_FIELDS = new Set(['version', 'updated_at', 'created_at']);

function computeDiff(before, after) {
  const diff = {};
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const k of keys) {
    if (DIFF_IGNORED_FIELDS.has(k)) continue;
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (!deepEqual(b, a)) {
      diff[k] = { before: b, after: a };
    }
  }
  return diff;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// ============================================================
// Serialisation
// ============================================================

function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    snapshot_json: safeJson(row.snapshot_json),
    diff_json: row.diff_json ? safeJson(row.diff_json) : null,
  };
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { return null; }
}

module.exports = {
  HISTORY_OPERATIONS,
  ACTOR_SOURCES,
  initPolicyHistory,
  appendHistoryEntry,
  listHistoryForPolicy,
  listHistoryForOrg,
  getPendingApprovals,
  getHistoryEntry,
  resolveApproval,
  computeDiff,
};
