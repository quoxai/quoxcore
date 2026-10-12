/**
 * Commitment ledger (COMMANDERQ P8).
 *
 * A promise CommanderQ makes ("I'll call back with the deploy result", "I'll
 * chase this by 5pm") becomes a governed object: a signed P4 `commitment`
 * artifact (the immutable evidence of the promise) PLUS a mutable ledger row
 * tracking its lifecycle (open → fulfilled | escalated | cancelled) so Q can
 * find overdue promises and chase/escalate them.
 *
 * Split of concerns: the signed artifact is immutable (you cannot un-promise);
 * the ledger row carries the mutable status + denormalized fields for querying
 * (due_at, owner). Resolution is itself evidenced by the caller (AEE event).
 *
 * Pure — caller passes the better-sqlite3 handle (voltDb). Reads ALWAYS scope
 * by org_id.
 */

'use strict';

const STATUSES = new Set(['open', 'fulfilled', 'escalated', 'cancelled']);

function initCommitmentLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commitment_ledger (
      commitment_id   TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      promise         TEXT NOT NULL,
      owner           TEXT,
      channel         TEXT,
      due_at          TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      created_at      TEXT NOT NULL,
      resolved_at     TEXT,
      resolution_note TEXT,
      artifact_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_org_status ON commitment_ledger (org_id, status, due_at);
  `);
}

/**
 * Insert a new open commitment. `commitment` is the signed artifact (its
 * artifact_id is the commitment_id; body fields are denormalized for query).
 */
function insertCommitment(db, commitment) {
  const b = (commitment && commitment.body) || {};
  // A commitment IS a signed, immutable artifact (commitment_id === artifact_id).
  // ON CONFLICT DO NOTHING: a replayed insert of the same id must NOT overwrite —
  // OR REPLACE previously wiped resolved_at/resolution_note (not in this column
  // list), silently un-resolving a fulfilled commitment. Idempotent instead.
  db.prepare(`
    INSERT INTO commitment_ledger
      (commitment_id, org_id, promise, owner, channel, due_at, status, created_at, artifact_id)
    VALUES (@commitment_id, @org_id, @promise, @owner, @channel, @due_at, @status, @created_at, @artifact_id)
    ON CONFLICT(commitment_id) DO NOTHING
  `).run({
    commitment_id: commitment.artifact_id,
    org_id: commitment.org_id,
    promise: b.promise || '',
    owner: b.owner || null,
    channel: b.channel || null,
    // Normalize due_at to canonical Z-ISO so the lexicographic SQL/string
    // compares in listCommitments/isOverdue are correct for any input offset
    // or precision; drop an unparseable value rather than mis-compare it.
    due_at: (() => { if (!b.due_at) return null; const t = Date.parse(b.due_at); return Number.isFinite(t) ? new Date(t).toISOString() : null; })(),
    status: STATUSES.has(b.status) ? b.status : 'open',
    created_at: commitment.created_at,
    artifact_id: commitment.artifact_id,
  });
}

function isOverdue(row, nowIso) {
  if (!row || row.status !== 'open' || !row.due_at) return false;
  const due = Date.parse(row.due_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return false;
  return due < now;
}

/**
 * List an org's commitments. filter: 'open' | 'overdue' | 'all' | a status.
 * `now` is an ISO string (injectable for tests).
 */
function listCommitments(db, orgId, { filter = 'open', now, limit = 100 } = {}) {
  if (!orgId) return [];
  const cap = Math.min(Math.max(1, limit | 0), 500);
  const nowIso = now || new Date().toISOString();
  let rows;
  if (filter === 'all') {
    rows = db.prepare('SELECT * FROM commitment_ledger WHERE org_id = ? ORDER BY due_at IS NULL, due_at ASC LIMIT ?').all(orgId, cap);
  } else if (filter === 'overdue') {
    rows = db.prepare("SELECT * FROM commitment_ledger WHERE org_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT ?").all(orgId, nowIso, cap);
  } else {
    const status = STATUSES.has(filter) ? filter : 'open';
    rows = db.prepare('SELECT * FROM commitment_ledger WHERE org_id = ? AND status = ? ORDER BY due_at IS NULL, due_at ASC LIMIT ?').all(orgId, status, cap);
  }
  return rows.map(r => ({ ...r, overdue: isOverdue(r, nowIso) }));
}

function getCommitment(db, commitmentId, orgId) {
  if (!commitmentId || !orgId) return null;
  return db.prepare('SELECT * FROM commitment_ledger WHERE commitment_id = ? AND org_id = ?').get(commitmentId, orgId) || null;
}

/**
 * Resolve a commitment (org-scoped). Returns { ok, error?, previous_status? }.
 * Only an OPEN commitment can be resolved (idempotency + no un-resolving).
 */
function resolveCommitment(db, commitmentId, orgId, status, note, nowIso) {
  if (!STATUSES.has(status) || status === 'open') return { ok: false, error: 'invalid_status' };
  const row = getCommitment(db, commitmentId, orgId);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'open') return { ok: false, error: 'already_resolved', previous_status: row.status };
  // WHERE also asserts status='open' so the "no un-resolving" invariant is
  // DB-enforced, not only guarded above (robust if this ever goes async/multi-proc).
  const info = db.prepare("UPDATE commitment_ledger SET status = ?, resolved_at = ?, resolution_note = ? WHERE commitment_id = ? AND org_id = ? AND status = 'open'")
    .run(status, nowIso || new Date().toISOString(), note || null, commitmentId, orgId);
  if (!info.changes) return { ok: false, error: 'already_resolved', previous_status: row.status };
  return { ok: true, previous_status: 'open', status };
}

module.exports = {
  STATUSES,
  initCommitmentLedger,
  insertCommitment,
  listCommitments,
  getCommitment,
  resolveCommitment,
  isOverdue,
};
