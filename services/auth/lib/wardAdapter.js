/**
 * LIFECYCLE-P3-D1 — WARD Adapter for Auth Service
 *
 * Provides fire-and-forget WARD witnessing for POWERS lifecycle audit events
 * that are written to the auth service's audit_events SQLite table.
 *
 * Architecture decision:
 *   - Auth imports WARD service directly (same container, no HTTP round-trip).
 *   - WARD's initWardHooks is called lazily on first use; subsequent calls are idempotent.
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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the WARD service directory from auth's location.
// Auth lives at: services/auth/
// WARD lives at:  services/ward/
const WARD_SERVICE_DIR = join(__dirname, '..', '..', 'ward');

let _wardInitialized = false;
let _wardHookVOLT = null;
let _wardHookAOCL = null;
let _wardHookApproval = null;
let _wardChainId = null;

/**
 * Lazily initialise WARD hooks. Idempotent — safe to call multiple times.
 * Returns true if WARD is available, false if unavailable/disabled.
 */
async function _ensureWard() {
  if (_wardInitialized) return _wardHookVOLT !== null;

  _wardInitialized = true; // Set early to avoid concurrent init races

  const wardDbPath = process.env.WARD_DB_PATH || '/var/lib/quox/ward.db';
  const chainId = process.env.WARD_AUTH_CHAIN_ID || 'ward:org/quox/env/production';
  const metaChainId = process.env.WARD_META_CHAIN_ID || 'ward:meta/quox-global';

  try {
    const { initWardHooks, wardHookVOLT, wardHookAOCL, wardHookApproval } = await import(`${WARD_SERVICE_DIR}/index.js`);

    initWardHooks({
      dbPath: wardDbPath,
      chainId,
      metaChainId,
      issuerId: 'ward:auth',
      tipInterval: 100,
    });

    _wardHookVOLT = wardHookVOLT;
    _wardHookAOCL = wardHookAOCL;
    _wardHookApproval = wardHookApproval;
    _wardChainId = chainId;

    console.log('[LIFECYCLE-P3-D1] WARD adapter initialised chain=%s', chainId);
    return true;
  } catch (err) {
    console.warn('[LIFECYCLE-P3-D1] WARD adapter init failed (non-fatal):', err.message);
    // Leave _wardHookVOLT as null so subsequent calls skip witnessing
    return false;
  }
}

/**
 * Build a WARD-compatible hash from an audit event record.
 * Uses the event's identity fields — not the metadata (which may contain PII).
 * Follows WARD SPEC §2.1 — content-free witnessing.
 */
function _buildAuditPayloadHash(auditRecord) {
  const { createHash } = createRequire(import.meta.url)('crypto');
  const canonical = JSON.stringify({
    id: auditRecord.id,
    org_id: auditRecord.org_id || null,
    actor_type: auditRecord.actor_type,
    actor_id: auditRecord.actor_id,
    action: auditRecord.action,
    target_type: auditRecord.target_type || null,
    target_id: auditRecord.target_id || null,
    status: auditRecord.status,
    created_at: auditRecord.created_at,
  }, Object.keys({
    id: 1, org_id: 1, actor_type: 1, actor_id: 1, action: 1,
    target_type: 1, target_id: 1, status: 1, created_at: 1,
  }).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// The set of audit_events columns that make up tamper-evident "content" for
// VAULT-P6.I reconciliation — everything _buildAuditPayloadHash() above
// already covers, minus `id` (that's the lookup key, not mutable content).
const _RECONCILE_FIELDS = ['org_id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'status', 'created_at'];

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
  const { createHash } = createRequire(import.meta.url)('crypto');
  const out = {};
  for (const field of _RECONCILE_FIELDS) {
    const value = auditRecord[field] ?? null;
    out[field] = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
  return out;
}

/**
 * Witness an auth audit event in the WARD chain. Fire-and-forget.
 *
 * Called AFTER the audit_events row has been durably committed.
 * Never blocks. Never throws. Logs warnings on failure.
 *
 * @param {object} auditRecord - The audit event record (id, action, actor_*, org_id, status, created_at, etc.)
 * @param {string} [orgId] - Organization ID (may be null for system events)
 */
export async function witnessAuthAudit(auditRecord, orgId) {
  if (!auditRecord || !auditRecord.id) return;

  try {
    const available = await _ensureWard();
    if (!available) return;

    const payloadHash = _buildAuditPayloadHash(auditRecord);
    const ts = auditRecord.created_at || new Date().toISOString();

    // Use wardHookAOCL for auth audit events (mirrors the AOCL event shape —
    // identity/policy decisions — which audit events represent).
    // The hook call is synchronous and fire-and-forget.
    //
    // VAULT-P6.B FINDING (fixed here, same file/no contract change):
    // wardHookAOCL (services/ward/lib/hooks.js:253-254) only chains an
    // envelope whose `intent` starts with 'aocl.layer.' or 'aocl.run.' (and
    // isn't the literal '...start' sentinel) — it silently returns null
    // (no chain entry, no error) for anything else. The previous
    // `quox.${action}` intent (e.g. 'quox.secret.access') NEVER matched that
    // filter, so every auth audit event witnessed via this function was
    // silently dropped — the WARD chain for auth audit events was never
    // actually being written to, despite every call site believing it was
    // "tamper-evidently witnessed". `aocl.layer.auth_audit.<action>` passes
    // the filter (starts with 'aocl.layer.', never literally
    // 'aocl.layer.start') while staying clearly distinguishable from real
    // collector AOCL pipeline-layer intents downstream (source_id is this
    // audit event's own id, so there is no source-key collision either way).
    _wardHookAOCL({
      id: auditRecord.id,
      intent: `aocl.layer.auth_audit.${auditRecord.action}`,
      ts,
      corr: `AUTH_${auditRecord.id}`,
      payload: {
        layer: 'AUTH_AUDIT',
        status: auditRecord.status,
        action: auditRecord.action,
        // Include the content-free payload hash so WARD can verify the event
        _payload_hash: payloadHash,
        // VAULT-P6.I — per-field breakdown so reconcileAuditChain() can name
        // exactly which column diverged, not just "content changed".
        _field_hashes: _buildAuditFieldHashes(auditRecord),
      },
    });
  } catch (err) {
    // NEVER propagate errors from WARD witnessing
    console.warn('[LIFECYCLE-P3-D1] WARD witness failed for audit event %s (non-fatal): %s',
      auditRecord?.id, err.message);
  }
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

  try {
    const available = await _ensureWard();
    if (!available || !_wardHookApproval) return null;

    const wardEntry = _wardHookApproval({
      eventId: event.id,
      eventHash: event.event_hash,
      ts: event.created_at,
    });

    return wardEntry?.ward_entry_id || null;
  } catch (err) {
    // NEVER propagate errors from WARD witnessing
    console.warn('[AUDIT-REAL-1] WARD witness failed for approval event %s (non-fatal): %s',
      event?.id, err.message);
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
  const available = await _ensureWard();
  if (!available || !_wardChainId) {
    return { chain_id: null, checked: 0, results: [] };
  }

  const ward = await import(`${WARD_SERVICE_DIR}/index.js`);
  const entries = ward.getEntries(_wardChainId).filter((e) => e.source_kind === 'AOCL');

  const db = getDb();
  const results = [];

  for (const entry of entries) {
    let tags;
    try {
      tags = entry.tags ? JSON.parse(entry.tags) : null;
    } catch {
      tags = null;
    }
    // Only entries witnessed via witnessAuthAudit() carry this marker —
    // other AOCL witnesses (e.g. the collector's own pipeline-layer events)
    // never set _field_hashes and are out of scope for this reconciliation.
    if (!tags || tags._kind !== 'auth_audit_v1' || !tags.fields) continue;

    const eventId = entry.source_id;
    let row;
    try {
      row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(eventId);
    } catch (err) {
      results.push({ eventId, status: 'ERROR', reason: err.message });
      continue;
    }

    if (!row) {
      results.push({ eventId, status: 'MISSING' });
      continue;
    }

    if (orgId && row.org_id !== orgId) continue;

    const currentFieldHashes = _buildAuditFieldHashes(row);
    const diverged = [];
    for (const field of _RECONCILE_FIELDS) {
      if (tags.fields[field] && tags.fields[field] !== currentFieldHashes[field]) {
        diverged.push(field);
      }
    }

    if (diverged.length > 0) {
      results.push({ eventId, status: 'CONTENT_TAMPERED', fields: diverged });
    } else {
      results.push({ eventId, status: 'OK' });
    }
  }

  return { chain_id: _wardChainId, checked: results.length, results };
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
  _wardInitialized = false;
  _wardHookApproval = null;
  _wardHookVOLT = null;
  _wardHookAOCL = null;
  _wardChainId = null;
}
