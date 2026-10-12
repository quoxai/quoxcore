'use strict';

/**
 * ContactsQ erasure (P4). ONE implementation, used by the human endpoint and by
 * the retention reaper; neither checks authority here (the service does).
 *
 *  full             crypto-shred (null the wrapped DEK: every encrypted field, on
 *                   every table, becomes unrecoverable), 'Erased contact' as the
 *                   name, name tokens / edges / identifiers deleted, status
 *                   'erased', an erasure_tombstone suppression per identifier
 *                   blind index so the same number or address is never recreated.
 *                   Touchpoint, lease and consent ROWS stay (counts and audit
 *                   history); their ciphertexts are now unreadable.
 *  identifiers_only identifiers deleted + tombstoned, the record otherwise kept.
 *
 * The certificate is a canonical JSON body plus its sha256. It holds ids, codes
 * and counts only: no name, no value.
 */

const nodeCrypto = require('node:crypto');
const store = require('./store.js');

const SCOPES = ['full', 'identifiers_only'];
const DAY_MS = 86400000;

/** Deterministic JSON: keys sorted at every level, no whitespace. */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

function hasFlag(row, flag) {
  const f = store.parseJson(row && row.flags_json, []);
  return Array.isArray(f) && f.includes(flag);
}

/** Honest per-surface map. voice_call_log is NOT propagated: the bridge keeps raw numbers in its own store. */
function propagationFor(scope, backupDays, nowMs) {
  const ageOut = new Date(nowMs + backupDays * DAY_MS).toISOString().slice(0, 10);
  return {
    contactsq: scope === 'full' ? 'shredded' : 'identifiers_removed',
    touchpoints: scope === 'full' ? 'shredded_with_contact' : 'retained',
    leases: 'revoked',
    consents: 'retained_codes_only',
    suppressions: 'tombstoned',
    photo: scope === 'full' ? 'shredded' : 'retained',
    voice_call_log: 'NOT_PROPAGATED',
    backups: `ages_out_by:${ageOut}`,
  };
}

/**
 * Execute an erasure. Throws ContactsqError: 404 not_found, 409 legal_hold, 409 already_erased.
 * -> { erasure, certificate }
 */
function eraseContact(orgId, contactId, { scope, reasonCode, requestedBy, nowMs = Date.now() }) {
  if (!orgId) throw new Error('eraseContact requires orgId');
  if (!SCOPES.includes(scope)) throw new store.ContactsqError(400, 'invalid_scope');
  const db = store.getDb();
  const row = store.getContactRow(orgId, contactId);
  if (!row) throw new store.ContactsqError(404, 'not_found');
  if (row.status === 'erased') throw new store.ContactsqError(409, 'already_erased');
  if (row.status === 'merged') throw new store.ContactsqError(409, 'contact_merged'); // its data now lives on the survivor: erase that one
  if (hasFlag(row, 'legal_hold')) throw new store.ContactsqError(409, 'legal_hold');

  const settings = store.getSettings(orgId);
  const now = new Date(nowMs).toISOString();
  const id = store.gid('er');
  const counts = {};

  db.transaction(() => {
    // 1. Tombstone every identifier by its stored blind indexes, then delete the rows (value + index).
    const idents = db.prepare('SELECT * FROM contact_identifiers WHERE org_id = ? AND contact_id = ?').all(orgId, row.id);
    let tombstones = 0;
    for (const i of idents) {
      const dup = db.prepare(
        "SELECT 1 FROM contact_suppressions WHERE org_id = ? AND channel = ? AND blind_index = ? AND reason = 'erasure_tombstone' LIMIT 1"
      ).get(orgId, i.channel, i.blind_index);
      if (dup) continue;
      db.prepare(`
        INSERT INTO contact_suppressions (id, org_id, channel, blind_index, blind_index_canonical, bi_version, reason, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'erasure_tombstone', ?, ?)
      `).run(store.gid('cs'), orgId, i.channel, i.blind_index, i.blind_index_canonical, i.bi_version, `erasure:${id}`, now);
      tombstones += 1;
    }
    counts.identifiers_removed = db.prepare('DELETE FROM contact_identifiers WHERE org_id = ? AND contact_id = ?').run(orgId, row.id).changes;
    counts.tombstones_written = tombstones;

    // 2. Revoke every active lease (queued dial jobs included).
    counts.leases_revoked = db.prepare(
      "UPDATE contact_leases SET status = 'revoked', revoked_at = ? WHERE org_id = ? AND contact_id = ? AND status = 'active'"
    ).run(now, orgId, row.id).changes;

    require('./p5.js').onErase(db, orgId, row, now, counts, scope); // P5: facts, merge pre-images, merged shells
    if (scope === 'full') {
      // The encrypted photo row goes with the key, and so do photos still held by contacts that were merged INTO this one.
      counts.photo_shredded = require('./photos.js').deletePhoto(orgId, row.id) ? 1 : 0;
      counts.photo_shredded += db.prepare('DELETE FROM contact_photos WHERE org_id = ? AND contact_id IN (SELECT id FROM contacts WHERE org_id = ? AND merged_into = ?)').run(orgId, orgId, row.id).changes;
      counts.touchpoints_shredded = db.prepare('SELECT COUNT(*) AS n FROM contact_touchpoints WHERE org_id = ? AND contact_id = ?').get(orgId, row.id).n;
      counts.name_tokens_removed = db.prepare('DELETE FROM contact_name_tokens WHERE org_id = ? AND contact_id = ?').run(orgId, row.id).changes;
      counts.name_tokens_removed += db.prepare('DELETE FROM contact_name_bi WHERE org_id = ? AND contact_id = ?').run(orgId, row.id).changes;
      counts.edges_removed = db.prepare('DELETE FROM contact_edges WHERE org_id = ? AND (from_id = ? OR to_id = ?)').run(orgId, row.id, row.id).changes;
      db.prepare('UPDATE contacts SET primary_org_contact_id = NULL WHERE org_id = ? AND primary_org_contact_id = ?').run(orgId, row.id);
      // The crypto-shred: with dek_wrapped gone no ciphertext of this contact can ever be opened again.
      db.prepare(`
        UPDATE contacts SET dek_wrapped = NULL, display_name = 'Erased contact', sort_name = 'erased contact', display_name_ct = NULL,
          ${require('./strictNames.js').NAME_COLS.map((c) => `${c} = NULL`).join(', ')},
          preferred_name_ct = NULL, pronunciation_ct = NULL, body_ciphertext = NULL, tags_json = '[]', quiet_hours_json = NULL,
          status = 'erased', retain_until = NULL, notice_due_at = NULL, erased_at = ?, updated_at = ?
        WHERE id = ? AND org_id = ?
      `).run(now, now, row.id, orgId);
    } else {
      db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ? AND org_id = ?').run(now, row.id, orgId);
    }
  })();

  const propagation = propagationFor(scope, settings.backup_retention_days, nowMs);
  const body = {
    certificate_version: 1,
    erasure_id: id,
    org_id: orgId,
    contact_id: row.id,
    executed_at: now,
    scope,
    reason_code: reasonCode,
    propagation,
    counts,
  };
  const certificate = { ...body, sha256: sha256(canonicalJson(body)) };
  db.prepare(`
    INSERT INTO contact_erasures (id, org_id, contact_id, scope, reason_code, requested_by, requested_at, executed_at,
      propagation_json, counts_json, certificate_json, certificate_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, row.id, scope, reasonCode, requestedBy || null, now, now, JSON.stringify(propagation), JSON.stringify(counts),
    canonicalJson(body), certificate.sha256);
  return { erasure: { id, scope, executed_at: now, counts, propagation }, certificate };
}

/** Re-derive the certificate from the stored canonical body; the hash is recomputed, not trusted. */
function getCertificate(orgId, erasureId) {
  const r = store.getDb().prepare('SELECT * FROM contact_erasures WHERE org_id = ? AND id = ?').get(orgId, String(erasureId));
  if (!r) return null;
  const body = JSON.parse(r.certificate_json);
  const hash = sha256(canonicalJson(body));
  return { certificate: { ...body, sha256: hash }, verified: hash === r.certificate_sha256 };
}

module.exports = { SCOPES, eraseContact, getCertificate, canonicalJson, hasFlag, propagationFor };
