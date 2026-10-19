'use strict';
/**
 * #1078: the canonical, content-free serialisation of an auth audit_events row, shared by auth (which hashes a row
 * when it commits it), the collector (which witnesses that hash into WARD) and anyone verifying an entry against the
 * auth audit table. Moved here unchanged from services/auth/lib/wardAdapter.js (_buildAuditPayloadHash /
 * _buildAuditFieldHashes), so entries witnessed before the move are still checkable.
 *
 * payload_hash = sha256 hex of JSON.stringify over exactly these fields, keys in this (sorted) order, a missing
 * org_id / target_type / target_id written as null:
 *   action, actor_id, actor_type, created_at, id, org_id, status, target_id, target_type
 * metadata_json is NEVER included (it may carry PII; WARD SPEC §2.1 content-free witnessing).
 *
 * field_hashes = { <field>: sha256 hex of JSON.stringify(value ?? null) } for the RECONCILE_FIELDS (everything above
 * except id, the lookup key), so a reconciliation pass can name which column of a witnessed row changed.
 */
const { createHash } = require('crypto');

const CANONICAL_FIELDS = ['action', 'actor_id', 'actor_type', 'created_at', 'id', 'org_id', 'status', 'target_id', 'target_type'];
const RECONCILE_FIELDS = ['org_id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'status', 'created_at'];
const NULLABLE = new Set(['org_id', 'target_type', 'target_id']);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function canonicalAuditJson(row = {}) {
  const obj = {};
  for (const f of CANONICAL_FIELDS) obj[f] = NULLABLE.has(f) ? (row[f] || null) : row[f];
  return JSON.stringify(obj, CANONICAL_FIELDS);
}

function buildAuditPayloadHash(row) { return sha256(canonicalAuditJson(row)); }

function buildAuditFieldHashes(row = {}) {
  const out = {};
  for (const f of RECONCILE_FIELDS) out[f] = sha256(JSON.stringify(row[f] ?? null));
  return out;
}

module.exports = { CANONICAL_FIELDS, RECONCILE_FIELDS, canonicalAuditJson, buildAuditPayloadHash, buildAuditFieldHashes };
