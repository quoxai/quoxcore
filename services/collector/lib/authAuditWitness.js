'use strict';
/**
 * #1078: POST /api/internal/ward/auth-audit, the ONE writer for auth audit witnesses.
 *
 * Auth used to witness its audit_events rows through its own in-process WARD store, which never started (a native
 * dependency missing from the auth image) and, had it started, would have written a second, unseen copy of the core
 * chain into auth's own ward.db. Now auth POSTs each committed row's content-free hashes here and the collector
 * witnesses them into ITS hook chain, with exactly the envelope auth's adapter built before, so the WARD payload
 * hash formula and the auth_audit_v1 tags read by the VAULT-P6.I reconcile pass are unchanged.
 *
 * Body (all from the committed auth audit row; services/shared/authAuditCanonical.cjs defines the serialisation):
 *   id            audit_events.id (the WARD source_id; one entry per id, ever)
 *   org_id        audit_events.org_id or null
 *   action        audit_events.action        status   audit_events.status
 *   created_at    audit_events.created_at    (the envelope ts)
 *   payload_hash  sha256 of the canonical JSON of the row's fields:
 *                 action, actor_id, actor_type, created_at, id, org_id, status, target_id, target_type
 *                 (metadata_json is never part of it). Anyone with the auth audit table can recompute it.
 *   field_hashes  { <field>: sha256 } for org_id, actor_type, actor_id, action, target_type, target_id, status,
 *                 created_at, so reconcile can name which column of a witnessed row changed
 * Guards: service key only (a user JWT or an agent token is refused even though the default-deny gate lets JWTs
 * in); the chain is fixed server-side (any caller chain field is ignored); idempotent by id (WARD's UNIQUE
 * (chain, source_kind, source_id): a retry returns the existing entry).
 */

const HEX64 = /^[0-9a-f]{64}$/;
const RECONCILE_FIELDS = ['org_id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'status', 'created_at'];

function validateAuthAuditBody(b) {
  if (!b || typeof b !== 'object') return 'body required';
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(b.id)) return 'id: audit_events.id required';
  if (typeof b.action !== 'string' || !/^[a-z0-9_.:-]{1,120}$/i.test(b.action)) return 'action: invalid';
  if (typeof b.status !== 'string' || !/^[a-z_]{1,32}$/.test(b.status)) return 'status: invalid';
  if (typeof b.created_at !== 'string' || !b.created_at || b.created_at.length > 40) return 'created_at required';
  if (b.org_id != null && (typeof b.org_id !== 'string' || b.org_id.length > 80)) return 'org_id: invalid';
  if (!HEX64.test(String(b.payload_hash || ''))) return 'payload_hash: sha256 hex required';
  const fh = b.field_hashes;
  if (!fh || typeof fh !== 'object' || Array.isArray(fh)) return 'field_hashes required';
  const keys = Object.keys(fh);
  if (keys.length !== RECONCILE_FIELDS.length || !RECONCILE_FIELDS.every((k) => HEX64.test(String(fh[k] || '')))) {
    return `field_hashes: exactly ${RECONCILE_FIELDS.join(', ')} as sha256 hex`;
  }
  return null;
}

/**
 * @param {{ wardHookAOCL: Function, getHookChainId: Function, getEntryBySource: Function }} deps
 */
function makeAuthAuditWitnessHandler(deps) {
  return async function authAuditWitness(req, res) {
    // Service key only. collectorAuthGate also admits user JWTs to /api/internal/*; this route must not.
    if (!req || req.service !== true) return res.status(403).json({ success: false, error: 'service_key_required' });
    const b = req.body || {};
    const bad = validateAuthAuditBody(b);
    if (bad) return res.status(400).json({ success: false, error: bad });
    const chainId = deps.getHookChainId ? deps.getHookChainId() : null;
    if (!chainId) return res.status(503).json({ success: false, error: 'ward_unavailable' });
    const fieldHashes = {};
    for (const k of RECONCILE_FIELDS) fieldHashes[k] = b.field_hashes[k];
    let entry = null;
    try {
      entry = deps.wardHookAOCL({
        id: b.id,
        intent: `aocl.layer.auth_audit.${b.action}`,
        ts: b.created_at,
        corr: `AUTH_${b.id}`,
        org_id: b.org_id || null,
        payload: { layer: 'AUTH_AUDIT', status: b.status, action: b.action, _payload_hash: b.payload_hash, _field_hashes: fieldHashes },
      });
    } catch (err) {
      return res.status(503).json({ success: false, error: 'witness_failed', detail: String(err && err.message || err).slice(0, 200) });
    }
    if (entry) {
      return res.json({ success: true, duplicate: false, chain_id: chainId, entry_id: entry.ward_entry_id || entry.id || null, seq: entry.seq ?? null });
    }
    // The hook writes nothing for a duplicate AND for an internal error; tell them apart by looking the row up.
    const existing = deps.getEntryBySource ? deps.getEntryBySource(chainId, 'AOCL', b.id) : null;
    if (existing) {
      return res.json({ success: true, duplicate: true, chain_id: chainId, entry_id: existing.ward_entry_id || existing.id || null, seq: existing.seq ?? null });
    }
    return res.status(503).json({ success: false, error: 'witness_failed', detail: 'WARD wrote no entry for this audit row' });
  };
}


/**
 * GET /api/internal/ward/auth-audit/entries?from_seq=&window= : the auth audit witnesses in the hook chain, for
 * auth's VAULT-P6.I reconcile pass. BOUNDED: a real chain is millions of entries, so each call scans one seq window
 * (at most MAX_WINDOW rows) through the (chain_id, seq) key and returns a cursor; it never loads the chain.
 * Returns { chain_id, entries: [{ seq, source_id, ward_entry_id, fields }], next_seq, done }. Service key only.
 */
const MAX_WINDOW = 5000;
function makeAuthAuditEntriesHandler(deps) {
  return async function authAuditEntries(req, res) {
    if (!req || req.service !== true) return res.status(403).json({ success: false, error: 'service_key_required' });
    const chainId = deps.getHookChainId ? deps.getHookChainId() : null;
    if (!chainId) return res.status(503).json({ success: false, error: 'ward_unavailable' });
    const q = req.query || {};
    const from = Math.max(1, Number.isInteger(Number(q.from_seq)) ? Number(q.from_seq) : 1);
    const window = Math.min(MAX_WINDOW, Math.max(1, Number.isInteger(Number(q.window)) ? Number(q.window) : MAX_WINDOW));
    const head = Number(deps.getHead ? deps.getHead() : 0) || 0;
    if (from > head) return res.json({ success: true, chain_id: chainId, entries: [], next_seq: from, done: true });
    const to = Math.min(head, from + window - 1);
    const out = [];
    for (const e of deps.getEntriesRange(chainId, from, to) || []) {
      if (!e || e.source_kind !== 'AOCL') continue;
      let tags = e.tags;
      if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = null; } }
      if (!tags || tags._kind !== 'auth_audit_v1' || !tags.fields) continue;
      out.push({ seq: e.seq, source_id: e.source_id, ward_entry_id: e.ward_entry_id || e.id || null, fields: tags.fields });
    }
    return res.json({ success: true, chain_id: chainId, entries: out, next_seq: to + 1, done: to >= head });
  };
}

/**
 * #1081: POST /api/internal/ward/approval-event, the collector-side witness of an auth approval_events row
 * (AUDIT-REAL-1). Body { event_id, event_hash (the row's own sha256 chain hash), created_at }. Same guards as the
 * audit route: service key only, chain fixed server-side, idempotent by event id (WARD's unique EXTERNAL source).
 */
function makeApprovalEventWitnessHandler(deps) {
  return async function approvalEventWitness(req, res) {
    if (!req || req.service !== true) return res.status(403).json({ success: false, error: 'service_key_required' });
    const b = req.body || {};
    if (typeof b.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(b.event_id)) return res.status(400).json({ success: false, error: 'event_id required' });
    if (!HEX64.test(String(b.event_hash || ''))) return res.status(400).json({ success: false, error: 'event_hash: sha256 hex required' });
    if (b.created_at != null && (typeof b.created_at !== 'string' || b.created_at.length > 40)) return res.status(400).json({ success: false, error: 'created_at: invalid' });
    const chainId = deps.getHookChainId ? deps.getHookChainId() : null;
    if (!chainId) return res.status(503).json({ success: false, error: 'ward_unavailable' });
    let entry = null;
    try {
      entry = deps.wardHookApproval({ eventId: b.event_id, eventHash: b.event_hash, ts: b.created_at || undefined });
    } catch (err) {
      return res.status(503).json({ success: false, error: 'witness_failed', detail: String(err && err.message || err).slice(0, 200) });
    }
    if (entry) return res.json({ success: true, duplicate: false, chain_id: chainId, entry_id: entry.ward_entry_id || entry.id || null, seq: entry.seq ?? null });
    const existing = deps.getEntryBySource ? deps.getEntryBySource(chainId, 'EXTERNAL', b.event_id) : null;
    if (existing) return res.json({ success: true, duplicate: true, chain_id: chainId, entry_id: existing.ward_entry_id || existing.id || null, seq: existing.seq ?? null });
    return res.status(503).json({ success: false, error: 'witness_failed', detail: 'WARD wrote no entry for this approval event' });
  };
}

module.exports = { makeAuthAuditWitnessHandler, makeAuthAuditEntriesHandler, makeApprovalEventWitnessHandler, validateAuthAuditBody, RECONCILE_FIELDS };
