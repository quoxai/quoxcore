'use strict';

/**
 * ContactsQ compliance (P4): the DSAR bundle (Art. 15), the Article 14 / posture
 * bands, and the Article 30 processing record. Read-only. The DSAR is the only
 * place that decrypts the whole record; the caller (api.js) restricts it to a
 * human admin. Bands and the processing record carry ids, codes and counts only.
 */

const cx = require('./crypto.js');
const store = require('./store.js');
const policy = require('./policy.js');

const LIVE = "status IN ('candidate','active')";
const BAND_ID_CAP = 100;

function safeDecrypt(dek, blob, binding) {
  if (!dek || !blob) return null;
  try { return cx.decryptField(dek, blob, binding); } catch { return null; }
}

/** The subject's own data, decrypted, plus who/what/when accessed it. Never the OTHER people's names. */
function buildDsar(orgId, row) {
  const db = store.getDb();
  const dek = store.dekFor(row);
  const bind = (field) => store.bindOf(orgId, row.id, field);
  const prov = db.prepare('SELECT * FROM contact_provenance WHERE org_id = ? AND contact_id = ? ORDER BY captured_at ASC, rowid ASC').all(orgId, row.id);
  const provById = new Map(prov.map((p) => [p.id, p]));
  const provJson = (p) => (p ? { id: p.id, source_type: p.source_type, source_ref: p.source_ref || null, captured_by: p.captured_by || null, captured_at: p.captured_at, trust: p.trust } : null);

  const identifiers = db.prepare('SELECT * FROM contact_identifiers WHERE org_id = ? AND contact_id = ? ORDER BY created_at ASC, rowid ASC').all(orgId, row.id).map((i) => ({
    id: i.id, channel: i.channel, label: i.label || null, network: i.network || null, value: safeDecrypt(dek, i.ciphertext, bind(`identifier:${i.id}`)),
    verification: i.verification, is_primary: Boolean(i.is_primary), created_at: i.created_at, retired_at: i.retired_at || null,
    provenance: provJson(provById.get(i.provenance_id)),
  }));

  let notes = null;
  const body = safeDecrypt(dek, row.body_ciphertext, bind('body'));
  if (body) { try { notes = JSON.parse(body).notes || null; } catch { notes = null; } }

  const consents = store.consentsFor(orgId, row.id).map((c) => ({
    id: c.id, purpose: c.purpose, channel: c.channel, status: c.status, lawful_basis: c.lawful_basis, evidence_ref: c.evidence_ref || null,
    captured_by: c.captured_by || null, captured_via: c.captured_via, captured_at: c.captured_at, expires_at: c.expires_at || null,
  }));

  const touchpoints = db.prepare('SELECT * FROM contact_touchpoints WHERE org_id = ? AND contact_id = ? ORDER BY occurred_at ASC, rowid ASC').all(orgId, row.id).map((t) => ({
    id: t.id, surface: t.surface, direction: t.direction, occurred_at: t.occurred_at, outcome: t.outcome || null, ref: t.ref || null,
    agent_id: t.agent_id || null, user_id: t.user_id || null, summary: safeDecrypt(dek, t.summary_ciphertext, bind(`touchpoint:${t.id}`)),
  }));

  // Edges: the relationship type and the other party's id/kind. An organisation's name is shown; another PERSON's is not (Art. 15(4)).
  const edges = store.edgesFor(orgId, row.id).map((e) => {
    const outbound = e.from_id === row.id;
    const other = store.getContactRow(orgId, outbound ? e.to_id : e.from_id);
    return {
      id: e.id, type: e.type, direction: outbound ? 'out' : 'in', since: e.since || null, until: e.until || null,
      other: other ? { id: other.id, kind: other.kind, display_name: other.kind === 'organisation' ? require('./strictNames.js').revealName(orgId, other, store.dekFor(other)) : null } : null,
      attrs: outbound ? store.edgeAttrs(orgId, e) : null,
    };
  });

  const decisions = store.decisionsFor(orgId, row.id, 500);

  // The lease + lease-use ledger: which agents/users/services were given access, when, for what, decided by whom.
  const uses = db.prepare('SELECT lease_id, used_at, transport, outcome FROM contact_lease_uses WHERE org_id = ? AND lease_id = ? ORDER BY used_at ASC, rowid ASC');
  const leases = db.prepare('SELECT * FROM contact_leases WHERE org_id = ? AND contact_id = ? ORDER BY requested_at ASC, rowid ASC LIMIT 5000').all(orgId, row.id).map((l) => ({
    id: l.id, subject_type: l.subject_type, subject_id: l.subject_id, projection: l.projection, channel: l.channel, purpose: l.purpose,
    status: l.status, decided_by: l.decided_by, requested_at: l.requested_at, expires_at: l.expires_at, revoked_at: l.revoked_at || null,
    use_count: l.use_count, max_uses: l.max_uses, reason: safeDecrypt(dek, l.reason_ciphertext, bind(`reason:${l.id}`)),
    uses: uses.all(orgId, l.id),
  }));

  const record = {
    id: row.id, kind: row.kind, status: row.status, display_name: safeDecrypt(dek, row.display_name_ct, bind('display_name')) || row.display_name,
    name: row.kind === 'organisation' ? null : require('./strictNames.js').readName(orgId, row, dek).parts,
    display_name_override: row.kind === 'organisation' ? null : require('./strictNames.js').readName(orgId, row, dek).override,
    preferred_name: safeDecrypt(dek, row.preferred_name_ct, bind('preferred_name')),
    pronunciation: safeDecrypt(dek, row.pronunciation_ct, bind('pronunciation')),
    notes, relationship_primary: row.relationship_primary || null, relationships: store.parseJson(row.relationships_json, []),
    lifecycle_stage: row.lifecycle_stage || null, tags: store.parseJson(row.tags_json, []), flags: store.parseJson(row.flags_json, []),
    jurisdiction: row.jurisdiction || store.getSettings(orgId).default_jurisdiction, language: row.language || null, tz: row.tz || null,
    quiet_hours: store.parseJson(row.quiet_hours_json, null), created_at: row.created_at, updated_at: row.updated_at,
    last_touchpoint_at: row.last_touchpoint_at || null, retain_until: row.retain_until || null,
    notice_due_at: row.notice_due_at || null, notice_sent_at: row.notice_sent_at || null,
    // Photo: presence and size only. The image bytes are not in the bundle (they are served by the photo route).
    photo: require('./photos.js').photoMeta(orgId, row.id),
  };

  const factList = require('./p5.js').dsarFacts(orgId, row);
  const counts = {
    facts: factList.length, identifiers: identifiers.length, consents: consents.length, touchpoints: touchpoints.length, edges: edges.length,
    policy_decisions: decisions.length, leases: leases.length, lease_uses: leases.reduce((n, l) => n + l.uses.length, 0), provenance: prov.length,
  };
  return {
    dsar_version: 1, generated_at: new Date().toISOString(), org_id: orgId, contact_id: row.id,
    record, identifiers, provenance: prov.map(provJson), facts: factList, consents, touchpoints, edges, policy_decisions: decisions, leases, counts,
  };
}

const idsOf = (rows, key = 'id') => rows.map((r) => r[key]);

function band(rows, key = 'id') {
  const ids = [...new Set(idsOf(rows, key))];
  return { count: ids.length, ids: ids.slice(0, BAND_ID_CAP), truncated: ids.length > BAND_ID_CAP };
}

/** Posture bands (counts + ids). special_category counts live contacts holding a non-rejected special-category fact (P5). */
function buildBands(orgId, nowMs = Date.now()) {
  const db = store.getDb();
  const now = new Date(nowMs).toISOString();
  const in7 = new Date(nowMs + 7 * 86400000).toISOString();
  const in30 = new Date(nowMs + 30 * 86400000).toISOString();

  const noticeOverdue = db.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND ${LIVE} AND notice_due_at IS NOT NULL AND notice_due_at < ? AND notice_sent_at IS NULL ORDER BY notice_due_at ASC`
  ).all(orgId, now);
  const candidatesExpiring = db.prepare(
    "SELECT id FROM contacts WHERE org_id = ? AND status = 'candidate' AND retain_until IS NOT NULL AND retain_until >= ? AND retain_until <= ? ORDER BY retain_until ASC"
  ).all(orgId, now, in7);
  const noBasis = db.prepare(
    `SELECT id FROM contacts c WHERE c.org_id = ? AND c.status = 'active' AND (c.relationship_primary IS NULL OR c.relationship_primary = 'unknown')
       AND NOT EXISTS (SELECT 1 FROM contact_consents k WHERE k.org_id = c.org_id AND k.contact_id = c.id) ORDER BY c.created_at ASC`
  ).all(orgId);

  // Current consent state per contact (latest row per purpose/channel) expiring inside 30 days.
  const expiring = [];
  const contactIds = db.prepare(
    `SELECT DISTINCT k.contact_id AS id FROM contact_consents k JOIN contacts c ON c.id = k.contact_id AND c.org_id = k.org_id
       WHERE k.org_id = ? AND k.expires_at IS NOT NULL AND c.status IN ('candidate','active')`
  ).all(orgId);
  for (const { id } of contactIds) {
    const hit = [...policy.currentConsentState(store.consentsFor(orgId, id)).values()].some((c) =>
      (c.status === 'granted' || c.status === 'soft_opt_in') && c.expires_at && c.expires_at >= now && c.expires_at <= in30);
    if (hit) expiring.push({ id });
  }

  return {
    notice_overdue: band(noticeOverdue),
    candidates_expiring_7d: band(candidatesExpiring),
    no_lawful_basis: band(noBasis),
    consents_expiring_30d: band(expiring),
    special_category: require('./p5.js').specialCategoryBand(orgId),
  };
}

/** Article 30 record: categories, purposes, recipients, retention, counts. No personal data. */
function buildProcessingRecord(orgId) {
  const db = store.getDb();
  const n = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
  const settings = store.getSettings(orgId);
  const channels = db.prepare(
    "SELECT i.channel AS channel, COUNT(DISTINCT i.contact_id) AS contacts FROM contact_identifiers i JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id WHERE i.org_id = ? AND i.retired_at IS NULL AND c.status != 'erased' GROUP BY i.channel ORDER BY i.channel"
  ).all(orgId);
  const live = n("SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND status != 'erased'");
  const categories = [{ category: 'name', contacts: live }, ...channels.map((c) => ({ category: `identifier:${c.channel}`, contacts: c.contacts }))];
  if (n("SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND body_ciphertext IS NOT NULL AND status != 'erased'")) {
    categories.push({ category: 'notes', contacts: n("SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND body_ciphertext IS NOT NULL AND status != 'erased'") });
  }
  if (n('SELECT COUNT(DISTINCT contact_id) AS n FROM contact_touchpoints WHERE org_id = ?')) {
    categories.push({ category: 'interaction_history', contacts: n('SELECT COUNT(DISTINCT contact_id) AS n FROM contact_touchpoints WHERE org_id = ?') });
  }
  const purposes = {
    leases: db.prepare('SELECT purpose, COUNT(*) AS n FROM contact_leases WHERE org_id = ? GROUP BY purpose ORDER BY purpose').all(orgId).map((r) => ({ purpose: r.purpose, count: r.n })),
    consents: db.prepare('SELECT purpose, lawful_basis, COUNT(*) AS n FROM contact_consents WHERE org_id = ? GROUP BY purpose, lawful_basis ORDER BY purpose, lawful_basis').all(orgId).map((r) => ({ purpose: r.purpose, lawful_basis: r.lawful_basis, count: r.n })),
  };
  const recipients = {
    transports: db.prepare('SELECT COALESCE(transport, \'unspecified\') AS transport, COUNT(*) AS n FROM contact_lease_uses WHERE org_id = ? GROUP BY transport ORDER BY transport').all(orgId).map((r) => ({ transport: r.transport, count: r.n })),
    accessor_types: db.prepare('SELECT subject_type, COUNT(DISTINCT subject_id) AS subjects, COUNT(*) AS leases FROM contact_leases WHERE org_id = ? GROUP BY subject_type ORDER BY subject_type').all(orgId).map((r) => ({ subject_type: r.subject_type, subjects: r.subjects, leases: r.leases })),
  };
  const by_status = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM contacts WHERE org_id = ? GROUP BY status').all(orgId)) by_status[r.status] = r.n;
  return {
    record_version: 1, generated_at: new Date().toISOString(), org_id: orgId,
    categories_of_data: categories, purposes, recipients,
    retention: {
      candidate_retention_days: settings.candidate_retention_days, backup_retention_days: settings.backup_retention_days,
      retention_reaper_enabled: settings.retention_reaper_enabled, retention_run_time_utc: settings.retention_run_time_utc,
    },
    safeguards: ['field_encryption_aes_256_gcm_per_contact_key', 'blind_index_lookup', 'crypto_shred_erasure', 'erasure_tombstones', 'lease_use_ledger', 'witnessed_evidence_without_personal_data'],
    counts: {
      contacts_by_status: by_status,
      identifiers: n('SELECT COUNT(*) AS n FROM contact_identifiers WHERE org_id = ? AND retired_at IS NULL'),
      consents: n('SELECT COUNT(*) AS n FROM contact_consents WHERE org_id = ?'),
      touchpoints: n('SELECT COUNT(*) AS n FROM contact_touchpoints WHERE org_id = ?'),
      leases: n('SELECT COUNT(*) AS n FROM contact_leases WHERE org_id = ?'),
      lease_uses: n('SELECT COUNT(*) AS n FROM contact_lease_uses WHERE org_id = ?'),
      suppressions: n('SELECT COUNT(*) AS n FROM contact_suppressions WHERE org_id = ?'),
      erasures: n('SELECT COUNT(*) AS n FROM contact_erasures WHERE org_id = ?'),
    },
  };
}

module.exports = { buildDsar, buildBands, buildProcessingRecord, BAND_ID_CAP };
