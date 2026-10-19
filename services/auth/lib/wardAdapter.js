/**
 * LIFECYCLE-P3-D1 — WARD Adapter for Auth Service
 *
 * Provides fire-and-forget WARD witnessing for POWERS lifecycle audit events
 * that are written to the auth service's audit_events SQLite table.
 *
 * Architecture decision (#1078/#1081):
 *   - The collector is the ONE WARD writer. Auth never opens a WARD store of its own (that store never started in
 *     the auth image, and would have forked the core chain into auth's ward.db). It POSTs content-free hashes to the
 *     collector's internal witness routes; a failed POST goes to ward_witness_outbox and is retried by a sweep.
 *   - The witness is ALWAYS fire-and-forget. If WARD fails, log a warning and return.
 *   - NEVER block the audit_events write on a WARD failure.
 *   - The audit_events SQLite table remains the source of truth; WARD is the tamper-evident verifier.
 *
 * Usage:
 *   import { witnessAuthAudit } from '../lib/wardAdapter.js';
 *   // After writing to audit_events:
 *   witnessAuthAudit(auditEventRecord, orgId);
 *
 * Fail mode:
 *   WARD witness is fire-and-forget. Any error is caught, logged as WARN, and swallowed.
 *   The calling code must not rely on this for transactional correctness.
 */

import { createRequire } from 'module';
import { getDb } from '../db/index.js';

// #1078: services/shared in the source tree; the auth image copies it to /app/services/shared (same relative path).
const _canonical = createRequire(import.meta.url)('../../shared/authAuditCanonical.cjs');

// #1081: the last chain the collector confirmed a witness into (introspection/tests); null until the first success.
let _wardChainId = null;

/**
 * Build a WARD-compatible hash from an audit event record.
 * Uses the event's identity fields — not the metadata (which may contain PII).
 * Follows WARD SPEC §2.1 — content-free witnessing.
 */
function _buildAuditPayloadHash(auditRecord) {
  // #1078: one canonical serialisation, shared with the collector and any verifier.
  return _canonical.buildAuditPayloadHash(auditRecord);
}

// The set of audit_events columns that make up tamper-evident "content" for
// VAULT-P6.I reconciliation — everything _buildAuditPayloadHash() above
// already covers, minus `id` (that's the lookup key, not mutable content).
const _RECONCILE_FIELDS = _canonical.RECONCILE_FIELDS;

/**
 * VAULT-P6.I — per-field content hashes for an audit event record.
 *
 * Unlike `_buildAuditPayloadHash()` (one combined hash — good for a single
 * pass/fail check), this returns a hash PER COLUMN so a later reconciliation
 * pass can name exactly which field diverged when tampering is detected,
 * instead of only "something in this row changed".
 *
 * @param {object} auditRecord
 * @returns {Record<string, string>} fieldName -> sha256 hex of its value
 */
function _buildAuditFieldHashes(auditRecord) {
  return _canonical.buildAuditFieldHashes(auditRecord);
}

// ── #1078: the collector is the ONE writer of the core WARD chain ────────────────────────────────────────────────
// Auth used to witness through its own in-process WARD store (removed in #1081). That store never started in the
// auth image (better-sqlite3 missing) and, had it started, would have written a private fork of the core chain into
// auth's own ward.db that nothing reads. Auth audit rows now go to the collector's
// POST /api/internal/ward/auth-audit (service key only, chain fixed there, idempotent by audit id). A POST that fails
// lands in ward_witness_outbox; sweepWardWitnessOutbox() retries it (per-row backoff, retired as 'dead' after
// WARD_WITNESS_MAX_ATTEMPTS). getWardWitnessHealth() feeds the /health ward_witness sub-check so an outage is loud.
// QUOX_WARD_WITNESS_URL overrides only this hop (the test setups point it at a refused loopback port so a suite that
// witnesses indirectly fails fast into the outbox instead of waiting on a DNS lookup of `collector`).
const _witnessBaseUrl = () => process.env.QUOX_WARD_WITNESS_URL || process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
export const WARD_WITNESS_MAX_ATTEMPTS = 10;
const WITNESS_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

async function _httpTransport({ method, path, body, query, serviceKey }) {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${_witnessBaseUrl()}${path}${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
let _transport = _httpTransport;
/** @internal tests route the hop into the collector handlers in-process. */
export function _setWardTransport(fn) { _transport = typeof fn === 'function' ? fn : _httpTransport; }

const _health = { lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0 };
/** @internal */
export function _resetWitnessHealth() { Object.assign(_health, { lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0 }); }
function _noteOk() { _health.lastOkAt = new Date().toISOString(); _health.consecutiveFailures = 0; _health.lastError = null; }
function _noteFail(err) { _health.lastErrorAt = new Date().toISOString(); _health.lastError = String(err && err.message || err).slice(0, 300); _health.consecutiveFailures += 1; }

function _witnessBody(r) {
  return {
    id: r.id, org_id: r.org_id || null, action: r.action, status: r.status, created_at: r.created_at,
    payload_hash: _buildAuditPayloadHash(r), field_hashes: _buildAuditFieldHashes(r),
  };
}

// #1081: one route per witness kind; the outbox row's kind picks it on retry.
const WITNESS_PATHS = { auth_audit: '/api/internal/ward/auth-audit', approval_event: '/api/internal/ward/approval-event' };

async function _send(body, kind = 'auth_audit') {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  if (!serviceKey) throw new Error('INTERNAL_SERVICE_KEY not configured');
  const path = WITNESS_PATHS[kind];
  if (!path) throw new Error(`unknown witness kind ${kind}`);
  const { status, json } = await _transport({ method: 'POST', path, body, serviceKey });
  if (status !== 200 || !json || json.success !== true) {
    throw new Error(`collector witness ${status}: ${(json && (json.error || json.detail)) || 'no body'}`);
  }
  if (json.chain_id) _wardChainId = json.chain_id;
  return json;
}

function _queue(body, err, kind = 'auth_audit', sourceId = body.id) {
  try {
    getDb().prepare(`INSERT OR IGNORE INTO ward_witness_outbox (audit_id, kind, body_json, attempts, state, next_attempt_at, last_error)
      VALUES (?, ?, ?, 0, 'pending', ?, ?)`).run(sourceId, kind, JSON.stringify(body), new Date(Date.now() + BACKOFF_BASE_MS).toISOString(),
      String(err && err.message || err).slice(0, 300));
  } catch (e) {
    console.error('[WARD-WITNESS] could not queue %s %s for retry: %s', kind, sourceId, e.message);
  }
}

/**
 * Witness an auth audit event in the core WARD chain, through the collector. Called AFTER the audit_events row is
 * committed. Never throws. Returns { ok, entry_id?, duplicate?, queued? } (callers may ignore it).
 *
 * @param {object} auditRecord - the committed audit_events row (id, org_id, actor_*, action, target_*, status, created_at)
 * @param {string} [orgId] - unused (the row carries its own org); kept for the existing call sites
 */
export async function witnessAuthAudit(auditRecord, orgId) { // eslint-disable-line no-unused-vars
  if (!auditRecord || !auditRecord.id) return { ok: false, error: 'no audit id' };
  let body;
  try { body = _witnessBody(auditRecord); } catch (err) { _noteFail(err); return { ok: false, error: err.message }; }
  try {
    const json = await _send(body);
    _noteOk();
    return { ok: true, entry_id: json.entry_id || null, duplicate: !!json.duplicate, chain_id: json.chain_id || null };
  } catch (err) {
    _noteFail(err);
    _queue(body, err);
    console.warn('[WARD-WITNESS] audit %s not witnessed yet, queued for retry: %s', auditRecord.id, err.message);
    return { ok: false, queued: true, error: err.message };
  }
}

/**
 * One outbox pass: send every due pending row. Success deletes the row; a failure counts an attempt and backs the
 * row off (2^attempts * 30 s, capped at 1 h); the last allowed failure retires it as 'dead' (never retried, reported
 * in /health). Returns { sent, failed, dead } so the scheduler can log and back off on a zero-progress pass.
 */
export async function sweepWardWitnessOutbox({ now = Date.now(), limit = 50 } = {}) {
  const out = { sent: 0, failed: 0, dead: 0 };
  let rows = [];
  try {
    rows = getDb().prepare(`SELECT audit_id, kind, body_json, attempts FROM ward_witness_outbox
      WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`).all(new Date(now).toISOString(), limit);
  } catch (err) { _noteFail(err); out.failed++; return out; }
  for (const row of rows) {
    try {
      await _send(JSON.parse(row.body_json), row.kind || 'auth_audit');
      getDb().prepare('DELETE FROM ward_witness_outbox WHERE audit_id = ?').run(row.audit_id);
      _noteOk();
      out.sent++;
    } catch (err) {
      _noteFail(err);
      const attempts = row.attempts + 1;
      const dead = attempts >= WARD_WITNESS_MAX_ATTEMPTS;
      const next = new Date(now + Math.min(Math.pow(2, attempts) * BACKOFF_BASE_MS, BACKOFF_CAP_MS)).toISOString();
      getDb().prepare(`UPDATE ward_witness_outbox SET attempts = ?, state = ?, next_attempt_at = ?, last_error = ? WHERE audit_id = ?`)
        .run(attempts, dead ? 'dead' : 'pending', next, String(err.message).slice(0, 300), row.audit_id);
      if (dead) { out.dead++; console.error('[WARD-WITNESS] audit %s retired as dead after %d attempts: %s', row.audit_id, attempts, err.message); }
      else out.failed++;
    }
  }
  return out;
}

/**
 * The /health ward_witness sub-check. 'down': no service key, so nothing can be witnessed. 'degraded': the last
 * witness failed, or rows are waiting or retired dead. 'ok' otherwise (including a fresh boot with nothing sent yet).
 */
export function getWardWitnessHealth() {
  let pending = 0, dead = 0;
  try {
    const r = getDb().prepare(`SELECT SUM(state = 'pending') AS p, SUM(state = 'dead') AS d FROM ward_witness_outbox`).get();
    pending = r?.p || 0; dead = r?.d || 0;
  } catch { /* table missing: reported below as degraded via the error */ }
  const configured = !!process.env.INTERNAL_SERVICE_KEY;
  const status = !configured ? 'down' : (_health.consecutiveFailures > 0 || pending > 0 || dead > 0) ? 'degraded' : 'ok';
  return {
    status, writer: 'collector', covers: ['auth_audit', 'approval_event'], last_ok_at: _health.lastOkAt, last_error_at: _health.lastErrorAt, last_error: _health.lastError,
    consecutive_failures: _health.consecutiveFailures, outbox_pending: pending, outbox_dead: dead,
  };
}

/**
 * AUDIT-REAL-1 — Witness an approval_events row (services/auth/lib/approvalEvents.js)
 * into the existing WARD meta-chain. Fire-and-forget, exactly like
 * witnessAuthAudit above — approval_events itself (hash-chained + signed) is
 * the primary durable record; this is cross-system corroborating evidence,
 * never a dependency for the append to succeed.
 *
 * @param {object} event - an approval_events row (id, event_hash, created_at, ...)
 * @returns {Promise<string|null>} the WARD ward_entry_id, or null if unavailable
 */
export async function witnessApprovalEvent(event) {
  if (!event || !event.id || !event.event_hash) return null;
  // #1081: through the collector (the one WARD writer), like witnessAuthAudit; a failure queues for the sweep.
  const body = { event_id: event.id, event_hash: event.event_hash, created_at: event.created_at || null };
  try {
    const json = await _send(body, 'approval_event');
    _noteOk();
    return json.entry_id || null;
  } catch (err) {
    _noteFail(err);
    _queue(body, err, 'approval_event', event.id);
    console.warn('[AUDIT-REAL-1] approval event %s not witnessed yet, queued for retry: %s', event.id, err.message);
    return null;
  }
}

/**
 * VAULT-P6.I — closes FINDING P6-T4: reconcile every WARD-witnessed
 * audit_events row against the CURRENT content of that row.
 *
 * `verifyChain()` (services/ward/lib/verify.js) is intentionally left
 * unchanged — it only proves WARD's own ward_entries chain hasn't been
 * altered. It has zero visibility into the auth service's audit_events
 * table, so an attacker with write access to auth.db (not ward.db) can
 * rewrite actor_id/target_id on an already-witnessed row and verifyChain()
 * keeps reporting INTACT. This is a SEPARATE, additive detection path: for
 * every WARD entry that carries an auth-audit field-hash breakdown (written
 * by witnessAuthAudit above), re-read the audit_events row by id and compare
 * its CURRENT per-field hashes to what was recorded at witness time.
 *
 * Never blocks or throws on a per-entry basis — errors for one entry are
 * reported inline rather than aborting the whole reconciliation pass.
 *
 * @param {string} [orgId] - When provided, only reconcile entries whose
 *   underlying audit_events row belongs to this org (rows that no longer
 *   exist are still reported as MISSING regardless of the filter, since we
 *   can't know their org without the row).
 * @returns {Promise<{chain_id: string|null, checked: number, results: Array<{eventId: string, status: 'OK'|'CONTENT_TAMPERED'|'MISSING', fields?: string[]}>}>}
 */
export async function reconcileAuditChain(orgId) {
  // #1078: the witnesses live in the collector's chain; read them back through the internal route.
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  if (!serviceKey) return { chain_id: null, checked: 0, results: [], error: 'INTERNAL_SERVICE_KEY not configured' };
  // #1078: the collector scans the chain in bounded seq windows; follow its cursor (never one whole-chain read).
  const entries = [];
  let chainId = null;
  let fromSeq = 1;
  for (let page = 0; page < 100000; page++) {
    const { status, json } = await _transport({ method: 'GET', path: '/api/internal/ward/auth-audit/entries', query: { from_seq: String(fromSeq), window: '5000' }, serviceKey });
    if (status !== 200 || !json || json.success !== true) {
      return { chain_id: chainId, checked: 0, results: [], error: `collector entries ${status}: ${(json && json.error) || 'no body'}` };
    }
    chainId = json.chain_id;
    entries.push(...json.entries);
    if (json.done || !(json.next_seq > fromSeq)) break;
    fromSeq = json.next_seq;
  }

  const db = getDb();
  const results = [];
  for (const entry of entries) {
    const eventId = entry.source_id;
    let row;
    try {
      row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(eventId);
    } catch (err) {
      results.push({ eventId, status: 'ERROR', reason: err.message });
      continue;
    }
    if (!row) { results.push({ eventId, status: 'MISSING' }); continue; }
    if (orgId && row.org_id !== orgId) continue;
    const current = _buildAuditFieldHashes(row);
    const diverged = _RECONCILE_FIELDS.filter((f) => entry.fields[f] && entry.fields[f] !== current[f]);
    results.push(diverged.length ? { eventId, status: 'CONTENT_TAMPERED', fields: diverged } : { eventId, status: 'OK' });
  }
  return { chain_id: chainId, checked: results.length, results };
}

/**
 * Expose the chain ID for testing / introspection.
 */
export function getWardChainId() {
  return _wardChainId;
}

/**
 * Reset ward state (for testing only).
 * @internal
 */
export function _resetWardAdapter() {
  _wardChainId = null;
  _resetWitnessHealth();
}
