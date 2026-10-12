/**
 * backupReceiptsStore.js — durable persistence for backup/restore outcomes.
 *
 * G2d slice 2 ("backup control plane"), the receipts half. The engines
 * (scripts/backup-quox.sh, scripts/restore-quox.sh, driven host-side by
 * quoxagent's dev.backup / dev.restore) record their outcome locally; this
 * module is the collector-side receiving half: a durable `backup_receipts`
 * table (schema owned by migrations/aee/028-backup-receipts-table.sql,
 * applied to the existing aeeDb via runMigrations()) plus handlers for
 * POST/GET /api/v1/backup-receipts and GET /api/v1/backup-status.
 *
 * Mirrors buildReceiptsStore.js's shape deliberately — same self-contained,
 * dependency-injected form (no server.js import) so it unit-tests directly
 * against a better-sqlite3 db, same INSERT-only discipline (every action is
 * its own row, never an UPSERT), same org-resolution rule. Two differences,
 * both load-bearing:
 *   1. `kind` ('backup' | 'restore') partitions the two engines, and
 *      /api/v1/backup-status reports the latest receipt per host AND kind —
 *      "this host last backed up at X, last restored at Y" is two facts.
 *   2. `dry_run` is tri-state (true / false / not stated). A restore receipt
 *      that never asserted a dry-run posture must NEVER read as "this was a
 *      real restore" — see toReceiptBool below and the migration comment.
 */

'use strict';

// Same bucket rule as buildReceiptsStore: a receipt written by SYSTEM/
// operator infrastructure (the host's own backup engine, posting with the
// INTERNAL_SERVICE_KEY and no org_id) lands under 'default' and stays visible
// to every authenticated caller, while a genuinely tenant-scoped receipt (a
// per-org dev server posting with its own ULID) stays private to that org.
// See that file's header for the full history of why a bare org_id = @org_id
// read filter blinded real users to system receipts.
const SYSTEM_ORG_ID = 'default';

// Same org-resolution discipline as every other governed write boundary in
// this codebase (feedApiHandlers.resolveOrgId): a real JWT session's
// req.user.org_id wins unconditionally; only an already-authenticated SERVICE
// caller may assert an org via body/query; an unauthenticated caller gets null.
const { resolveOrgId } = require('./feedApiHandlers.js');

const RECEIPT_KINDS = Object.freeze(['backup', 'restore']);

// `result` is intentionally unconstrained (see the migration comment): the
// engines own their outcome vocabulary. `kind` is constrained here AND in the
// table, because a third kind is a receipt nobody can interpret.
function isValidBackupReceiptPayload(payload) {
  return !!payload
    && typeof payload.kind === 'string' && RECEIPT_KINDS.includes(payload.kind.trim())
    && typeof payload.result === 'string' && payload.result.trim().length > 0;
}

function toNullableString(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function toNullableInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Tri-state boolean -> INTEGER. Anything that is not an unambiguous true or
// false becomes NULL ("not stated"), NEVER 0: a garbled dry_run must not be
// stored as the assertion "this was a real restore". The honest reading of an
// unparseable posture is that no posture was recorded.
function toReceiptBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return null;
}

// Distinct from toNullableInt: an explicit 0/negative limit is floored to 1
// rather than falling back to the default (a plain `limit || def` would
// wrongly treat 0 as "not provided").
function normalizeLimit(limit, def, max) {
  if (limit === undefined || limit === null || limit === '') return def;
  const n = Number(limit);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode || null,
    archive_id: row.archive_id || null,
    archive_sha256: row.archive_sha256 || null,
    archive_size_bytes: row.archive_size_bytes === null || row.archive_size_bytes === undefined ? null : row.archive_size_bytes,
    // Surfaced as a real tri-state to callers: true / false / null.
    dry_run: row.dry_run === null || row.dry_run === undefined ? null : row.dry_run === 1,
    result: row.result,
    terminal: row.terminal || null,
    stream: row.stream || null,
    phase: row.phase || null,
    message: row.message || null,
    duration_seconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : row.duration_seconds,
    host: row.host || 'unknown',
    org_id: row.org_id || 'default',
    created_at: row.created_at,
  };
}

// INSERT a backup_receipts row. Returns the stored record, or null if db/
// payload is missing/invalid (validation happens again in the HTTP handler so
// callers get a proper 400 — this direct function is also used standalone by
// tests).
function recordBackupReceipt(db, payload, { now = () => Date.now(), host = 'unknown' } = {}) {
  if (!db || !isValidBackupReceiptPayload(payload)) return null;

  const params = {
    kind: payload.kind.trim(),
    mode: toNullableString(payload.mode),
    archive_id: toNullableString(payload.archive_id),
    archive_sha256: toNullableString(payload.archive_sha256 ?? payload.sha256),
    archive_size_bytes: toNullableInt(payload.archive_size_bytes ?? payload.size_bytes),
    dry_run: toReceiptBool(payload.dry_run),
    result: payload.result.trim(),
    // Accept `terminals`/`requester` as aliases, same as the build receipts
    // store does for the build daemon's own field naming.
    terminal: toNullableString(payload.terminal ?? payload.terminals ?? payload.requester),
    stream: toNullableString(payload.stream),
    phase: toNullableString(payload.phase),
    message: toNullableString(payload.message ?? payload.msg),
    duration_seconds: toNullableInt(payload.duration_seconds ?? payload.duration),
    host: toNullableString(payload.host) || host,
    org_id: toNullableString(payload.org_id) || 'default',
    created_at: now(),
  };

  const info = db.prepare(`
    INSERT INTO backup_receipts (kind, mode, archive_id, archive_sha256, archive_size_bytes, dry_run, result, terminal, stream, phase, message, duration_seconds, host, org_id, created_at)
    VALUES (@kind, @mode, @archive_id, @archive_sha256, @archive_size_bytes, @dry_run, @result, @terminal, @stream, @phase, @message, @duration_seconds, @host, @org_id, @created_at)
  `).run(params);

  const row = db.prepare('SELECT * FROM backup_receipts WHERE id = ?').get(info.lastInsertRowid);
  return rowToRecord(row);
}

// GET /api/v1/backup-receipts — recent history, optionally filtered by ?kind=,
// ?result=, ?host= and/or ?archive_id=, newest first, capped by ?limit=
// (default 50, max 500). ?org_id= scopes reads to "the caller's own org OR the
// shared system bucket" (see SYSTEM_ORG_ID above).
function listBackupReceipts(db, { kind, result, host, archive_id, org_id, limit = 50 } = {}) {
  if (!db) return [];
  const clauses = [];
  const params = {};
  if (kind) { clauses.push('kind = @kind'); params.kind = kind; }
  if (result) { clauses.push('result = @result'); params.result = result; }
  if (host) { clauses.push('host = @host'); params.host = host; }
  if (archive_id) { clauses.push('archive_id = @archive_id'); params.archive_id = archive_id; }
  if (org_id) {
    clauses.push('(org_id = @org_id OR org_id = @systemOrg)');
    params.org_id = org_id;
    params.systemOrg = SYSTEM_ORG_ID;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.limit = normalizeLimit(limit, 50, 500);

  const rows = db.prepare(`
    SELECT * FROM backup_receipts
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `).all(params);
  return rows.map(rowToRecord);
}

// Most recent receipt per (host, kind) — the data source for
// GET /api/v1/backup-status. A host's last backup and its last restore are two
// separate facts and both are reported; collapsing them to one row per host
// would hide whichever happened longer ago.
//
// HONEST GAP, same shape as the build-status one: this reflects the most
// recent COMPLETED receipt, because the engines only post at the END of a run.
// It does not capture a backup/restore that is in flight right now — for that,
// GET /api/v1/dev-backup/:hostId/status asks the host itself.
function latestBackupReceiptPerHostKind(db, { limit = 500, org_id } = {}) {
  if (!db) return [];
  const where = org_id ? 'WHERE (org_id = @org_id OR org_id = @systemOrg)' : '';
  const params = { limit: normalizeLimit(limit, 500, 2000) };
  if (org_id) { params.org_id = org_id; params.systemOrg = SYSTEM_ORG_ID; }
  const rows = db.prepare(`
    SELECT * FROM backup_receipts ${where} ORDER BY created_at DESC, id DESC LIMIT @limit
  `).all(params);

  const seen = new Map();
  for (const row of rows) {
    const key = `${row.host}::${row.kind}`;
    if (!seen.has(key)) seen.set(key, rowToRecord(row));
  }
  return Array.from(seen.values());
}

// POST /api/v1/backup-receipts — accepts an engine's outcome, records it
// durably, then fire-and-forget emits an AEE envelope (via the injected
// `emitEnvelope`, expected to be server.js's in-process storeAuditEnvelope) so
// it is WARD-witnessed. Best-effort: a witnessing failure is caught and
// logged, and NEVER changes the HTTP response — the receipt is already durably
// stored by that point.
function createBackupReceiptCreateHandler(deps = {}) {
  const { getDb, emitEnvelope, now = () => Date.now(), host = 'unknown' } = deps;
  return function backupReceiptCreateHandler(req, res) {
    const body = req.body || {};
    if (!isValidBackupReceiptPayload(body)) {
      return res.status(400).json({ error: `kind (${RECEIPT_KINDS.join('|')}) and result are required` });
    }

    // org_id is derived EXCLUSIVELY from the caller's own authenticated
    // identity and then OVERRIDES whatever the body claims (spread first,
    // org_id assigned after) — never merged.
    const orgId = resolveOrgId(req) || 'default';

    let record;
    try {
      const db = getDb();
      record = recordBackupReceipt(db, { ...body, org_id: orgId }, { now, host });
    } catch (err) {
      return res.status(500).json({ error: 'backup_receipt_store_failed', detail: err.message });
    }

    if (typeof emitEnvelope === 'function') {
      try {
        emitEnvelope({
          type: 'event',
          // Derived from the receipt's own terminal when the caller identified
          // itself, same rule as the build receipts emit (a Bob-authored
          // receipt must not be witnessed as if the engine wrote it).
          from: record.terminal ? `agent.${record.terminal}` : 'system.backup-engine',
          to: 'audit.backup_queue',
          intent: 'quox.backup.receipt',
          corr: `BACKUP_${record.kind}_${record.id}`,
          payload: {
            kind: record.kind,
            mode: record.mode,
            archive_id: record.archive_id,
            archive_sha256: record.archive_sha256,
            archive_size_bytes: record.archive_size_bytes,
            dry_run: record.dry_run,
            result: record.result,
            terminal: record.terminal,
            stream: record.stream,
            phase: record.phase,
            message: record.message,
            duration_seconds: record.duration_seconds,
            host: record.host,
          },
        });
      } catch (envErr) {
        console.warn('[BackupReceipts] AEE emit failed (non-fatal):', envErr.message);
      }
    }

    return res.status(201).json({ stored: true, receipt: record });
  };
}

function createBackupReceiptsListHandler(deps = {}) {
  const { getDb } = deps;
  return function backupReceiptsListHandler(req, res) {
    try {
      const db = getDb();
      const q = req.query || {};
      const orgId = resolveOrgId(req) || 'default';
      const receipts = listBackupReceipts(db, {
        kind: q.kind, result: q.result, host: q.host, archive_id: q.archive_id, limit: q.limit, org_id: orgId,
      });
      return res.json({ count: receipts.length, receipts });
    } catch (err) {
      return res.status(500).json({ error: 'backup_receipts_list_failed', detail: err.message });
    }
  };
}

function createBackupStatusHandler(deps = {}) {
  const { getDb } = deps;
  return function backupStatusHandler(req, res) {
    try {
      const db = getDb();
      const orgId = resolveOrgId(req) || 'default';
      const hosts = latestBackupReceiptPerHostKind(db, { org_id: orgId });
      return res.json({
        count: hosts.length,
        hosts,
        note: 'Reflects the most recent COMPLETED backup and restore receipt per host. Does not capture an in-flight run — ask the host directly via GET /api/v1/dev-backup/:hostId/status.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'backup_status_failed', detail: err.message });
    }
  };
}

module.exports = {
  RECEIPT_KINDS,
  isValidBackupReceiptPayload,
  toReceiptBool,
  recordBackupReceipt,
  listBackupReceipts,
  latestBackupReceiptPerHostKind,
  createBackupReceiptCreateHandler,
  createBackupReceiptsListHandler,
  createBackupStatusHandler,
};
