/**
 * buildReceiptsStore.js — durable persistence for quox-build-daemon (Terminal 9)
 * build outcomes.
 *
 * DEVSUITE-BUILD Phase 1 ("receipts wedge"). /opt/quoxcore/bin/quox-build-daemon's
 * record_action() function currently appends every build outcome (result,
 * target, terminal, stream, phase, msg, duration) to /tmp/quox-build-history
 * only — lost on reboot, no durable history, no WARD witnessing. This module
 * is the collector-side receiving half: a durable `build_receipts` table
 * (schema owned by migrations/aee/006-build-receipts-table.sql, applied to
 * the existing aeeDb via runMigrations()) plus handlers for POST/GET
 * /api/v1/build-receipts and GET /api/v1/build-status.
 *
 * Mirrors devServersStore.js's shape exactly: self-contained + dependency-
 * injected (no server.js import) so it unit-tests directly against a
 * better-sqlite3 db. Differs in one way — this table is INSERT-only (every
 * build action is its own row), not an UPSERT keyed by a stable id, so there
 * is no first_registered_at/last_seen_at pair here.
 *
 * The daemon-side change that actually POSTs to this endpoint is a separate,
 * parallel task — this module only builds the receiving side.
 */

'use strict';

// SEC-AUDIT (2026-08-11) S5 + REGRESSION-FIX (2026-08-11): build receipts
// written by /opt/quoxcore/bin/quox-build-daemon are SYSTEM/operator
// infrastructure data, not tenant data — the daemon builds shared images
// (dashboard, collector, website) for the whole box and POSTs with the
// INTERNAL_SERVICE_KEY and no org_id, so those rows land under this bucket.
// The first S5 fix wrongly imposed strict per-tenant partitioning on reads,
// which meant a real dashboard user (org_id = a ULID) and Bob-in-a-user-org
// saw ZERO of these system receipts — the feature went blind. The correct
// model: system receipts (this bucket) are visible to every authenticated
// caller; a genuinely tenant-scoped receipt (a future per-org dev server
// posting with its own ULID) stays private to that org. Reads therefore
// match "the caller's own org OR the shared system bucket", which restores
// system-build visibility while keeping the real tenant-isolation value of
// the S5 fix (org A still cannot read org B's ULID-scoped rows).
const SYSTEM_ORG_ID = 'default';

// SEC-AUDIT (2026-08-11) S5 — resolveOrgId (feedApiHandlers.js) is the
// established discipline this codebase already uses for deriving org
// context at a governed boundary: a real JWT session's req.user.org_id wins
// unconditionally; only an already-authenticated SERVICE caller (req.service,
// set by requireServiceOrUserAuth() for a valid INTERNAL_SERVICE_KEY) may
// assert an org via req.query/req.body; an unauthenticated caller gets null.
// Reused directly here rather than inventing a second org-resolution
// function — same pattern as server.js's resolveNucleusOrgId (used by the
// QLarity/nucleus proxies). Before this fix, createBuildReceiptCreateHandler
// trusted payload.org_id straight off the POST body with NO cross-check
// against the authenticated caller at all (not even the req.user-wins rule
// resolveOrgId already enforces), and the list/status reads applied no org
// filter whatsoever — a receipt (including its free-text `message`) written
// under any org_id string was readable by every caller regardless of their
// own resolved org.
const { resolveOrgId } = require('./feedApiHandlers.js');

// result vocabulary is intentionally NOT an enum here — see the migration
// file's comment. The daemon's real call sites use "ok" / "FAIL" /
// "UNVERIFIED"; "queued" is reserved but unused today. Store whatever the
// caller sends.
function isValidReceiptPayload(payload) {
  return !!payload
    && typeof payload.target === 'string' && payload.target.trim().length > 0
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
    target: row.target,
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

// INSERT a build_receipts row. Returns the stored record, or null if db/
// payload is missing/invalid (validation happens again in the HTTP handler
// so callers get a proper 400 — this direct function is also used standalone
// by tests).
function recordBuildReceipt(db, payload, { now = () => Date.now(), host = 'unknown' } = {}) {
  if (!db || !isValidReceiptPayload(payload)) return null;

  const params = {
    target: payload.target.trim(),
    result: payload.result.trim(),
    // Accept the daemon's `terminal`/`terminals` naming (its own variable is
    // `$terminals`, a comma-joined coalesced list) as well as `requester`.
    terminal: toNullableString(payload.terminal ?? payload.terminals ?? payload.requester),
    stream: toNullableString(payload.stream),
    phase: toNullableString(payload.phase),
    // Accept both `message` and the daemon's own short name `msg`.
    message: toNullableString(payload.message ?? payload.msg),
    duration_seconds: toNullableInt(payload.duration_seconds ?? payload.duration),
    host: toNullableString(payload.host) || host,
    org_id: toNullableString(payload.org_id) || 'default',
    created_at: now(),
  };

  const info = db.prepare(`
    INSERT INTO build_receipts (target, result, terminal, stream, phase, message, duration_seconds, host, org_id, created_at)
    VALUES (@target, @result, @terminal, @stream, @phase, @message, @duration_seconds, @host, @org_id, @created_at)
  `).run(params);

  const row = db.prepare('SELECT * FROM build_receipts WHERE id = ?').get(info.lastInsertRowid);
  const rec = rowToRecord(row);
  try { require('./lucid/emit.js').buildEvent(rec); } catch { /* LUCID must never break build receipts */ }
  return rec;
}

// GET /api/v1/build-receipts — recent history, optionally filtered by
// ?target= and/or ?result=, newest first, capped by ?limit= (default 50,
// max 500). ?org_id= scopes reads to "the caller's own org OR the shared
// system bucket" (see SYSTEM_ORG_ID above): the daemon's system receipts are
// visible to every authenticated caller, while a tenant-scoped receipt stays
// private to its org. When org_id is omitted (a pure service/operator caller
// with no asserted org), no org filter is applied and all rows are returned.
function listBuildReceipts(db, { target, result, host, org_id, limit = 50 } = {}) {
  if (!db) return [];
  const clauses = [];
  const params = {};
  if (target) { clauses.push('target = @target'); params.target = target; }
  if (result) { clauses.push('result = @result'); params.result = result; }
  // ?host= — per-dev-server history is what the hub's build panel shows;
  // without it every host's receipts interleave into one stream.
  if (host) { clauses.push('host = @host'); params.host = host; }
  if (org_id) {
    // Own org OR the shared system bucket — never a bare `org_id = @org_id`,
    // which is what blinded real users to daemon-written system receipts.
    clauses.push('(org_id = @org_id OR org_id = @systemOrg)');
    params.org_id = org_id;
    params.systemOrg = SYSTEM_ORG_ID;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.limit = normalizeLimit(limit, 50, 500);

  const rows = db.prepare(`
    SELECT * FROM build_receipts
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `).all(params);
  return rows.map(rowToRecord);
}

// Most recent receipt per target — the data source for GET /api/v1/build-status.
// NOTE (honest gap): this reflects the most recent COMPLETED receipt per
// target (record_action() is only ever called at the END of a build/verify
// step in quox-build-daemon today). It does NOT capture true in-flight
// "currently building" state — that would need the daemon to also POST a
// start-of-build receipt (e.g. result="queued" or "building"), which is a
// daemon-side change out of scope for this pass.
//
// ?org_id= scopes to "own org OR the shared system bucket" — see
// listBuildReceipts' header comment and SYSTEM_ORG_ID above for why system
// receipts must remain visible to every authenticated caller.
function latestBuildReceiptPerTarget(db, { limit = 500, org_id } = {}) {
  if (!db) return [];
  const where = org_id ? 'WHERE (org_id = @org_id OR org_id = @systemOrg)' : '';
  const params = { limit: normalizeLimit(limit, 500, 2000) };
  if (org_id) { params.org_id = org_id; params.systemOrg = SYSTEM_ORG_ID; }
  const rows = db.prepare(`
    SELECT * FROM build_receipts ${where} ORDER BY created_at DESC, id DESC LIMIT @limit
  `).all(params);

  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.target)) seen.set(row.target, rowToRecord(row));
  }
  return Array.from(seen.values());
}

// POST /api/v1/build-receipts — accepts the daemon's action data, records it
// durably, then fire-and-forget emits an AEE envelope (via the injected
// `emitEnvelope`, expected to be server.js's in-process storeAuditEnvelope)
// so it is WARD-witnessed. Best-effort: a witnessing failure is caught and
// logged, and NEVER changes the HTTP response — the receipt is already
// durably stored by that point.
function createBuildReceiptCreateHandler(deps = {}) {
  const { getDb, emitEnvelope, now = () => Date.now(), host = 'unknown' } = deps;
  return function buildReceiptCreateHandler(req, res) {
    const body = req.body || {};
    if (!isValidReceiptPayload(body)) {
      return res.status(400).json({ error: 'target and result are required' });
    }

    // SEC-AUDIT (2026-08-11) S5 — org_id is derived EXCLUSIVELY from the
    // caller's own authenticated identity (resolveOrgId, see this file's
    // top-of-file header comment), then used to OVERRIDE whatever the body
    // claims (spread first, org_id assigned after) — never merged, so a
    // real JWT caller can never assert a different org than their own
    // session no matter what body.org_id says.
    const orgId = resolveOrgId(req) || 'default';

    let record;
    try {
      const db = getDb();
      record = recordBuildReceipt(db, { ...body, org_id: orgId }, { now, host });
    } catch (err) {
      return res.status(500).json({ error: 'build_receipt_store_failed', detail: err.message });
    }

    if (typeof emitEnvelope === 'function') {
      try {
        emitEnvelope({
          type: 'event',
          // SEC-AUDIT (2026-08-11) S7 — previously hardcoded regardless of
          // who actually posted the receipt, so a Bob-authored receipt
          // (terminal: 'bob') was WARD-witnessed as if the build daemon
          // wrote it. Derive from record.terminal when the caller identified
          // itself (the daemon's own receipts carry no terminal today, so
          // this preserves 'system.build-daemon' for them unchanged).
          from: record.terminal ? `agent.${record.terminal}` : 'system.build-daemon',
          to: 'audit.build_queue',
          intent: 'quox.build.receipt',
          corr: `BUILD_${record.target}_${record.id}`,
          payload: {
            target: record.target,
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
        // Fire-and-forget: witnessing must never fail the caller.
        console.warn('[BuildReceipts] AEE emit failed (non-fatal):', envErr.message);
      }
    }

    // QUOXIFY pass 3 (DEVSUITE phase 16): the learning wire. A build that
    // fails REPEATEDLY becomes a wisdom entry, which the next dispatch of
    // that target reads back as a pre-build advisory. This is the hook
    // because it is the only deterministic point every build passes through,
    // so learning does not depend on anyone remembering to ask an agent.
    //
    // Fire-and-forget on purpose, and after the response is decided: a
    // learning wire must never be able to fail a build receipt. Single
    // failures are ignored (they are usually typos, not lessons); see
    // lib/buildLearning.js for why the threshold exists.
    try {
      const learning = require('./buildLearning.js');
      const db = getDb();
      const recent = listBuildReceipts(db, { target: record.target, org_id: orgId, limit: 10 });
      learning.learnFromReceipt({ orgId, receipt: record, recentReceipts: recent })
        .catch((err) => console.warn('[BuildReceipts] learning hook failed (non-fatal):', err.message));
    } catch (learnErr) {
      console.warn('[BuildReceipts] learning hook unavailable (non-fatal):', learnErr.message);
    }

    return res.status(201).json({ stored: true, receipt: record });
  };
}

function createBuildReceiptsListHandler(deps = {}) {
  const { getDb } = deps;
  return function buildReceiptsListHandler(req, res) {
    try {
      const db = getDb();
      const q = req.query || {};
      // SEC-AUDIT (2026-08-11) S5 — reads are now scoped to the caller's own
      // resolved org (same resolveOrgId as the write side); listBuildReceipts
      // ALWAYS applies this filter when it is passed, no bypass.
      const orgId = resolveOrgId(req) || 'default';
      const receipts = listBuildReceipts(db, { target: q.target, result: q.result, host: q.host, limit: q.limit, org_id: orgId });
      return res.json({ count: receipts.length, receipts });
    } catch (err) {
      return res.status(500).json({ error: 'build_receipts_list_failed', detail: err.message });
    }
  };
}

function createBuildStatusHandler(deps = {}) {
  const { getDb } = deps;
  return function buildStatusHandler(req, res) {
    try {
      const db = getDb();
      // SEC-AUDIT (2026-08-11) S5 — same org scoping as the list handler above.
      const orgId = resolveOrgId(req) || 'default';
      const targets = latestBuildReceiptPerTarget(db, { org_id: orgId });
      return res.json({
        count: targets.length,
        targets,
        note: 'Reflects the most recent COMPLETED build receipt per target. Does not capture true in-flight "building" state — the daemon does not yet POST a start-of-build receipt.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'build_status_failed', detail: err.message });
    }
  };
}

module.exports = {
  isValidReceiptPayload,
  recordBuildReceipt,
  listBuildReceipts,
  latestBuildReceiptPerTarget,
  createBuildReceiptCreateHandler,
  createBuildReceiptsListHandler,
  createBuildStatusHandler,
};
