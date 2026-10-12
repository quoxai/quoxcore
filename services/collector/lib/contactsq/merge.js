'use strict';

/**
 * ContactsQ merge (P5): fold one contact (the loser) into another (the survivor),
 * reversibly, for 30 days.
 *
 * What moves: identifiers, provenance, touchpoints, edges, lease history, facts.
 * Consents are append-only and are NOT copied: the survivor's consent view is the
 * union of its own rows and those of contacts merged into it (store.consentsFor),
 * so undo needs no delete. Every moved ciphertext is re-encrypted under the
 * survivor's DEK with the survivor's v2 binding.
 *
 * The pre-image of BOTH sides (the survivor's merged columns, the loser's whole
 * row, and the raw original of every moved row) is stored as ONE blob encrypted
 * under the survivor's DEK with binding field `merge:<merge_id>`. Undo restores the
 * raw originals, so the decrypted state of both contacts is byte-identical to
 * before. Crypto-shredding the survivor shreds the blob with it.
 */

const cx = require('./crypto.js');
const store = require('./store.js');
const strictNames = require('./strictNames.js');

/** The real (decrypted when strict_names protected it) display name of a row. */
function realName(orgId, row) {
  return strictNames.revealName(orgId, row, row.display_name_ct ? store.dekFor(row) : null);
}

/** Name text for search tokens: the display name plus every searchable part (strict rows decrypt through their DEK). */
function nameText(orgId, row) {
  return strictNames.searchTextFor(orgId, row, row.display_name_ct || row.name_ct_json ? store.dekFor(row) : null);
}

/** Rewrite a contact's search tokens from `name`, in the mode the row is stored in. */
function rewriteTokens(db, orgId, row, name) {
  if (row.display_name_ct) strictNames.writeBlindTokens(db, orgId, row.id, name);
  else { strictNames.clearBlindTokens(db, orgId, row.id); store.writeNameTokens(db, orgId, row.id, name); }
}

const UNDO_WINDOW_MS = 30 * 86400000;
const MERGEABLE = ['candidate', 'active', 'archived'];
const SURVIVOR_COLS = ['preferred_name_ct', 'pronunciation_ct', 'body_ciphertext', 'relationship_primary', 'relationships_json', 'tags_json',
  'flags_json', 'language', 'tz', 'notice_due_at', 'primary_org_contact_id', 'last_touchpoint_at', 'status', 'retain_until', 'updated_at'];

const fail = (status, code) => new store.ContactsqError(status, code);
const bind = (orgId, contactId, field) => store.bindOf(orgId, contactId, field);

function union(a, b) {
  const out = [];
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (!out.includes(v)) out.push(v);
  return out;
}

function reencrypt(blob, from, to) {
  if (!blob) return blob;
  let plain;
  try { plain = cx.decryptField(from.dek, blob, bind(from.orgId, from.id, from.field)); } catch { throw fail(409, 'merge_decrypt_failed'); }
  return cx.encryptField(to.dek, plain, bind(to.orgId, to.id, to.field));
}

function readNotes(dek, orgId, id, ciphertext) {
  if (!ciphertext) return null;
  try { return JSON.parse(cx.decryptField(dek, ciphertext, bind(orgId, id, 'body'))).notes || null; } catch { throw fail(409, 'merge_decrypt_failed'); }
}

function mergeCounts(moved) {
  return {
    identifiers: moved.identifiers.length, provenance: moved.provenance.length, touchpoints: moved.touchpoints.length,
    edges: moved.edges.length, edges_dropped: moved.deleted_edges.length, leases: moved.leases.length, facts: moved.facts.length,
  };
}

/** -> { merge, counts }. Throws ContactsqError. The caller has already checked authority. */
function mergeContacts(orgId, survivorId, loserId, { by } = {}) {
  const db = store.getDb();
  if (!orgId) throw new Error('mergeContacts requires orgId');
  if (String(survivorId) === String(loserId)) throw fail(400, 'same_contact');
  const survivor = store.getContactRow(orgId, survivorId);
  const loser = store.getContactRow(orgId, loserId);
  if (!survivor || !loser) throw fail(404, 'not_found');
  if (!MERGEABLE.includes(survivor.status) || !MERGEABLE.includes(loser.status)) throw fail(409, 'not_mergeable');
  if (survivor.kind !== loser.kind) throw fail(400, 'kind_mismatch');
  const sDek = store.dekFor(survivor);
  const lDek = store.dekFor(loser);
  if (!sDek || !lDek) throw fail(409, 'contact_shredded');

  const mergeId = store.gid('mg');
  const now = store.nowIso();
  const S = { orgId, id: survivor.id, dek: sDek };
  const L = { orgId, id: loser.id, dek: lDek };
  const moved = { identifiers: [], touchpoints: [], leases: [], facts: [], provenance: [], edges: [], deleted_edges: [], repointed_orgs: [] };

  db.transaction(() => {
    const pre = { survivor: {}, loser: { row: { ...loser } } };
    for (const c of SURVIVOR_COLS) pre.survivor[c] = survivor[c];

    // 1. Identifiers (value re-encrypted; the loser's primary yields to the survivor's).
    for (const i of db.prepare('SELECT * FROM contact_identifiers WHERE org_id = ? AND contact_id = ?').all(orgId, loser.id)) {
      moved.identifiers.push({ id: i.id, contact_id: i.contact_id, is_primary: i.is_primary, ciphertext: i.ciphertext });
      const survivorHasPrimary = db.prepare(
        'SELECT 1 FROM contact_identifiers WHERE org_id = ? AND contact_id = ? AND channel = ? AND is_primary = 1 AND retired_at IS NULL'
      ).get(orgId, survivor.id, i.channel);
      db.prepare('UPDATE contact_identifiers SET contact_id = ?, ciphertext = ?, is_primary = ? WHERE id = ? AND org_id = ?').run(
        survivor.id, reencrypt(i.ciphertext, { ...L, field: `identifier:${i.id}` }, { ...S, field: `identifier:${i.id}` }),
        survivorHasPrimary ? 0 : i.is_primary, i.id, orgId);
    }

    // 2. Provenance (plain rows, so identifier/fact provenance ids keep resolving).
    for (const p of db.prepare('SELECT id FROM contact_provenance WHERE org_id = ? AND contact_id = ?').all(orgId, loser.id)) moved.provenance.push(p.id);
    db.prepare('UPDATE contact_provenance SET contact_id = ? WHERE org_id = ? AND contact_id = ?').run(survivor.id, orgId, loser.id);

    // 3. Touchpoints.
    for (const t of db.prepare('SELECT * FROM contact_touchpoints WHERE org_id = ? AND contact_id = ?').all(orgId, loser.id)) {
      moved.touchpoints.push({ id: t.id, contact_id: t.contact_id, summary_ciphertext: t.summary_ciphertext });
      db.prepare('UPDATE contact_touchpoints SET contact_id = ?, summary_ciphertext = ? WHERE id = ? AND org_id = ?').run(
        survivor.id, reencrypt(t.summary_ciphertext, { ...L, field: `touchpoint:${t.id}` }, { ...S, field: `touchpoint:${t.id}` }), t.id, orgId);
    }

    // 4. Lease history (value-free rows; the reason ciphertext is re-encrypted).
    for (const l of db.prepare('SELECT * FROM contact_leases WHERE org_id = ? AND contact_id = ?').all(orgId, loser.id)) {
      moved.leases.push({ id: l.id, contact_id: l.contact_id, reason_ciphertext: l.reason_ciphertext });
      db.prepare('UPDATE contact_leases SET contact_id = ?, reason_ciphertext = ? WHERE id = ? AND org_id = ?').run(
        survivor.id, reencrypt(l.reason_ciphertext, { ...L, field: `reason:${l.id}` }, { ...S, field: `reason:${l.id}` }), l.id, orgId);
    }

    // 5. Facts.
    for (const f of db.prepare('SELECT * FROM contact_facts WHERE org_id = ? AND contact_id = ?').all(orgId, loser.id)) {
      moved.facts.push({ id: f.id, contact_id: f.contact_id, value_ciphertext: f.value_ciphertext });
      db.prepare('UPDATE contact_facts SET contact_id = ?, value_ciphertext = ? WHERE id = ? AND org_id = ?').run(
        survivor.id, reencrypt(f.value_ciphertext, { ...L, field: `fact:${f.id}` }, { ...S, field: `fact:${f.id}` }), f.id, orgId);
    }

    // 6. Edges: repoint; a self-edge or an exact duplicate is dropped (kept in the pre-image).
    for (const e of db.prepare('SELECT * FROM contact_edges WHERE org_id = ? AND (from_id = ? OR to_id = ?)').all(orgId, loser.id, loser.id)) {
      const newFrom = e.from_id === loser.id ? survivor.id : e.from_id;
      const newTo = e.to_id === loser.id ? survivor.id : e.to_id;
      const dup = db.prepare(
        'SELECT 1 FROM contact_edges WHERE org_id = ? AND from_id = ? AND to_id = ? AND type = ? AND id != ? AND (until IS NULL OR until > ?) LIMIT 1'
      ).get(orgId, newFrom, newTo, e.type, e.id, now);
      if (newFrom === newTo || dup) {
        moved.deleted_edges.push({ ...e });
        db.prepare('DELETE FROM contact_edges WHERE id = ? AND org_id = ?').run(e.id, orgId);
        continue;
      }
      moved.edges.push({ id: e.id, from_id: e.from_id, to_id: e.to_id, attrs_ciphertext: e.attrs_ciphertext });
      db.prepare('UPDATE contact_edges SET from_id = ?, to_id = ?, attrs_ciphertext = ? WHERE id = ? AND org_id = ?').run(
        newFrom, newTo,
        e.from_id === loser.id ? reencrypt(e.attrs_ciphertext, { ...L, field: `edge:${e.id}` }, { ...S, field: `edge:${e.id}` }) : e.attrs_ciphertext,
        e.id, orgId);
    }
    // People whose employer was the loser now point at the survivor.
    for (const o of db.prepare('SELECT id FROM contacts WHERE org_id = ? AND primary_org_contact_id = ?').all(orgId, loser.id)) moved.repointed_orgs.push(o.id);
    db.prepare('UPDATE contacts SET primary_org_contact_id = ? WHERE org_id = ? AND primary_org_contact_id = ?').run(survivor.id, orgId, loser.id);

    // 7. Survivor columns: fill gaps, union the sets (a DNC flag on either side holds), earliest Article 14 clock.
    const prefName = survivor.preferred_name_ct
      ? survivor.preferred_name_ct : reencrypt(loser.preferred_name_ct, { ...L, field: 'preferred_name' }, { ...S, field: 'preferred_name' });
    const pron = survivor.pronunciation_ct
      ? survivor.pronunciation_ct : reencrypt(loser.pronunciation_ct, { ...L, field: 'pronunciation' }, { ...S, field: 'pronunciation' });
    const sNotes = readNotes(sDek, orgId, survivor.id, survivor.body_ciphertext);
    const lNotes = readNotes(lDek, orgId, loser.id, loser.body_ciphertext);
    const notes = sNotes && lNotes ? `${sNotes}\n\n---\n\n${lNotes}` : (sNotes || lNotes);
    const body = notes ? cx.encryptField(sDek, JSON.stringify({ notes }), bind(orgId, survivor.id, 'body')) : null;
    const dues = [survivor.notice_due_at, loser.notice_due_at].filter(Boolean).sort();
    const noticeDue = survivor.notice_sent_at ? survivor.notice_due_at : (dues[0] || null);
    const live = survivor.status === 'active' || loser.status === 'active';
    const status = survivor.status === 'candidate' && live ? 'active' : survivor.status;
    const lts = [survivor.last_touchpoint_at, loser.last_touchpoint_at].filter(Boolean).sort().pop() || null;
    db.prepare(`
      UPDATE contacts SET preferred_name_ct = ?, pronunciation_ct = ?, body_ciphertext = ?, relationship_primary = ?, relationships_json = ?,
        tags_json = ?, flags_json = ?, language = ?, tz = ?, notice_due_at = ?, primary_org_contact_id = ?, last_touchpoint_at = ?,
        status = ?, retain_until = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(prefName, pron, body, survivor.relationship_primary || loser.relationship_primary || null,
      JSON.stringify(union(store.parseJson(survivor.relationships_json, []), store.parseJson(loser.relationships_json, []))),
      JSON.stringify(union(store.parseJson(survivor.tags_json, []), store.parseJson(loser.tags_json, []))),
      JSON.stringify(union(store.parseJson(survivor.flags_json, []), store.parseJson(loser.flags_json, []))),
      survivor.language || loser.language || null, survivor.tz || loser.tz || null, noticeDue,
      survivor.primary_org_contact_id || loser.primary_org_contact_id || null, lts,
      status, status === 'active' && survivor.status === 'candidate' ? null : survivor.retain_until, now, survivor.id, orgId);

    // 8. Name tokens: the loser's name keeps resolving, to the survivor (works for plain and strict_names rows).
    rewriteTokens(db, orgId, survivor, `${nameText(orgId, survivor)} ${nameText(orgId, loser)}`);
    db.prepare('DELETE FROM contact_name_tokens WHERE org_id = ? AND contact_id = ?').run(orgId, loser.id);
    strictNames.clearBlindTokens(db, orgId, loser.id);

    // 9. The loser: status merged, its own ciphertexts cleared (they live on in the pre-image and in the survivor).
    db.prepare(`
      UPDATE contacts SET status = 'merged', merged_into = ?, preferred_name_ct = NULL, pronunciation_ct = NULL, body_ciphertext = NULL, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(survivor.id, now, loser.id, orgId);

    // 10. The pre-image, one blob under the survivor DEK.
    pre.moved = moved;
    db.prepare(`
      INSERT INTO contact_merges (id, org_id, survivor_id, loser_id, status, counts_json, pre_image_ciphertext, merged_by, merged_at, expires_at)
      VALUES (?, ?, ?, ?, 'merged', ?, ?, ?, ?, ?)
    `).run(mergeId, orgId, survivor.id, loser.id, JSON.stringify(mergeCounts(moved)),
      cx.encryptField(sDek, JSON.stringify(pre), bind(orgId, survivor.id, `merge:${mergeId}`)),
      by || null, now, new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString());
  })();

  return { merge: getMerge(orgId, mergeId), counts: mergeCounts(moved) };
}

function mergeJson(r) {
  return {
    id: r.id, survivor_id: r.survivor_id, loser_id: r.loser_id, status: r.status, counts: store.parseJson(r.counts_json, {}),
    merged_by: r.merged_by || null, merged_at: r.merged_at, expires_at: r.expires_at, undone_at: r.undone_at || null, undone_by: r.undone_by || null,
  };
}

function getMerge(orgId, id) {
  const r = store.getDb().prepare('SELECT * FROM contact_merges WHERE org_id = ? AND id = ?').get(orgId, String(id));
  return r ? mergeJson(r) : null;
}

function listMerges(orgId, { contact_id: contactId, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = contactId
    ? store.getDb().prepare('SELECT * FROM contact_merges WHERE org_id = ? AND (survivor_id = ? OR loser_id = ?) ORDER BY merged_at DESC, rowid DESC LIMIT ?').all(orgId, contactId, contactId, lim)
    : store.getDb().prepare('SELECT * FROM contact_merges WHERE org_id = ? ORDER BY merged_at DESC, rowid DESC LIMIT ?').all(orgId, lim);
  return rows.map(mergeJson);
}

/** Restore both contacts exactly. Throws 404 / 409 merge_not_active, merge_expired, survivor_unavailable, merge_decrypt_failed. */
function undoMerge(orgId, mergeId, { by } = {}) {
  const db = store.getDb();
  const m = db.prepare('SELECT * FROM contact_merges WHERE org_id = ? AND id = ?').get(orgId, String(mergeId));
  if (!m) throw fail(404, 'not_found');
  if (m.status !== 'merged' || !m.pre_image_ciphertext) throw fail(409, 'merge_not_active');
  const now = store.nowIso();
  if (m.expires_at <= now) throw fail(409, 'merge_expired');
  const survivor = store.getContactRow(orgId, m.survivor_id);
  const loser = store.getContactRow(orgId, m.loser_id);
  if (!survivor || !loser || loser.status !== 'merged' || loser.merged_into !== survivor.id || ['merged', 'erased'].includes(survivor.status)) {
    throw fail(409, 'survivor_unavailable');
  }
  const sDek = store.dekFor(survivor);
  if (!sDek) throw fail(409, 'contact_shredded');
  let pre;
  try { pre = JSON.parse(cx.decryptField(sDek, m.pre_image_ciphertext, bind(orgId, survivor.id, `merge:${m.id}`))); } catch { throw fail(409, 'merge_decrypt_failed'); }

  db.transaction(() => {
    const mv = pre.moved;
    for (const i of mv.identifiers) db.prepare('UPDATE contact_identifiers SET contact_id = ?, ciphertext = ?, is_primary = ? WHERE id = ? AND org_id = ?').run(i.contact_id, i.ciphertext, i.is_primary, i.id, orgId);
    for (const id of mv.provenance) db.prepare('UPDATE contact_provenance SET contact_id = ? WHERE id = ? AND org_id = ?').run(loser.id, id, orgId);
    for (const t of mv.touchpoints) db.prepare('UPDATE contact_touchpoints SET contact_id = ?, summary_ciphertext = ? WHERE id = ? AND org_id = ?').run(t.contact_id, t.summary_ciphertext, t.id, orgId);
    for (const l of mv.leases) db.prepare('UPDATE contact_leases SET contact_id = ?, reason_ciphertext = ? WHERE id = ? AND org_id = ?').run(l.contact_id, l.reason_ciphertext, l.id, orgId);
    for (const f of mv.facts) db.prepare('UPDATE contact_facts SET contact_id = ?, value_ciphertext = ? WHERE id = ? AND org_id = ?').run(f.contact_id, f.value_ciphertext, f.id, orgId);
    for (const e of mv.edges) db.prepare('UPDATE contact_edges SET from_id = ?, to_id = ?, attrs_ciphertext = ? WHERE id = ? AND org_id = ?').run(e.from_id, e.to_id, e.attrs_ciphertext, e.id, orgId);
    for (const e of mv.deleted_edges) {
      db.prepare(`
        INSERT OR IGNORE INTO contact_edges (id, org_id, from_id, to_id, type, attrs_ciphertext, since, until, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.id, e.org_id, e.from_id, e.to_id, e.type, e.attrs_ciphertext, e.since, e.until, e.created_by, e.created_at);
    }
    for (const id of mv.repointed_orgs) db.prepare('UPDATE contacts SET primary_org_contact_id = ? WHERE id = ? AND org_id = ?').run(loser.id, id, orgId);

    const sc = pre.survivor;
    db.prepare(`
      UPDATE contacts SET preferred_name_ct = ?, pronunciation_ct = ?, body_ciphertext = ?, relationship_primary = ?, relationships_json = ?,
        tags_json = ?, flags_json = ?, language = ?, tz = ?, notice_due_at = ?, primary_org_contact_id = ?, last_touchpoint_at = ?,
        status = ?, retain_until = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(sc.preferred_name_ct, sc.pronunciation_ct, sc.body_ciphertext, sc.relationship_primary, sc.relationships_json, sc.tags_json, sc.flags_json,
      sc.language, sc.tz, sc.notice_due_at, sc.primary_org_contact_id, sc.last_touchpoint_at, sc.status, sc.retain_until, sc.updated_at, survivor.id, orgId);

    const lr = pre.loser.row;
    db.prepare(`
      UPDATE contacts SET ${strictNames.NAME_COLS.map((c) => `${c} = ?`).join(', ')}, names_v = ?,
        display_name = ?, sort_name = ?, display_name_ct = ?, preferred_name_ct = ?, pronunciation_ct = ?, status = ?, merged_into = ?,
        primary_org_contact_id = ?, relationship_primary = ?, flags_json = ?, language = ?, tz = ?, retain_until = ?, body_ciphertext = ?,
        relationships_json = ?, lifecycle_stage = ?, tags_json = ?, notice_due_at = ?, notice_sent_at = ?, last_touchpoint_at = ?, updated_at = ?
      WHERE id = ? AND org_id = ?
    `).run(...strictNames.NAME_COLS.map((c) => lr[c] === undefined ? null : lr[c]), lr.names_v === undefined ? 1 : lr.names_v,
      lr.display_name, lr.sort_name, lr.display_name_ct || null, lr.preferred_name_ct, lr.pronunciation_ct, lr.status, lr.merged_into || null, lr.primary_org_contact_id,
      lr.relationship_primary, lr.flags_json, lr.language, lr.tz, lr.retain_until, lr.body_ciphertext, lr.relationships_json, lr.lifecycle_stage,
      lr.tags_json, lr.notice_due_at, lr.notice_sent_at, lr.last_touchpoint_at, lr.updated_at, loser.id, orgId);

    const sNow = store.getContactRow(orgId, survivor.id);
    rewriteTokens(db, orgId, sNow, nameText(orgId, sNow));
    const lNow = store.getContactRow(orgId, loser.id);
    rewriteTokens(db, orgId, lNow, nameText(orgId, lNow));
    db.prepare("UPDATE contact_merges SET status = 'undone', undone_at = ?, undone_by = ?, pre_image_ciphertext = NULL WHERE id = ? AND org_id = ?").run(now, by || null, m.id, orgId);
  })();
  return { merge: getMerge(orgId, m.id), counts: store.parseJson(m.counts_json, {}) };
}

/**
 * Lazy retirement of expired pre-images (called on merge/list; no timer). After the window the
 * pre-image is unrecoverable and the loser shell loses its key and its name.
 */
function purgeExpired(orgId, nowMs = Date.now()) {
  const db = store.getDb();
  const now = new Date(nowMs).toISOString();
  const rows = db.prepare("SELECT id, loser_id FROM contact_merges WHERE org_id = ? AND status = 'merged' AND expires_at <= ?").all(orgId, now);
  for (const r of rows) {
    db.transaction(() => {
      db.prepare("UPDATE contact_merges SET status = 'final', pre_image_ciphertext = NULL WHERE id = ? AND org_id = ?").run(r.id, orgId);
      db.prepare(`
        UPDATE contacts SET dek_wrapped = NULL, display_name = 'Merged contact', sort_name = 'merged contact', display_name_ct = NULL, preferred_name_ct = NULL,
          ${strictNames.NAME_COLS.map((c) => `${c} = NULL`).join(', ')},
          pronunciation_ct = NULL, body_ciphertext = NULL, tags_json = '[]', updated_at = ?
        WHERE id = ? AND org_id = ? AND status = 'merged'
      `).run(now, r.loser_id, orgId);
    })();
  }
  return rows.length;
}

const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Candidate duplicate pairs: same canonical identifier on two contacts, or same normalised name at the same organisation. Ids and codes only. */
function findDuplicates(orgId, { limit = 100 } = {}) {
  const db = store.getDb();
  const pairs = new Map();
  const live = "c.status IN ('candidate','active')";
  const add = (a, b, reason) => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}|${y}`;
    if (!pairs.has(k)) pairs.set(k, { a: x, b: y, reasons: new Set() });
    pairs.get(k).reasons.add(reason);
  };
  const groups = db.prepare(`
    SELECT i.channel AS channel, i.blind_index_canonical AS bi, GROUP_CONCAT(DISTINCT i.contact_id) AS ids
    FROM contact_identifiers i JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id
    WHERE i.org_id = ? AND i.retired_at IS NULL AND ${live}
    GROUP BY i.channel, i.blind_index_canonical HAVING COUNT(DISTINCT i.contact_id) > 1
  `).all(orgId);
  for (const g of groups) {
    const ids = g.ids.split(',');
    for (let x = 0; x < ids.length; x += 1) for (let y = x + 1; y < ids.length; y += 1) add(ids[x], ids[y], `identifier:${g.channel}`);
  }
  const byKey = new Map();
  for (const c of db.prepare(`SELECT c.* FROM contacts c WHERE c.org_id = ? AND ${live}`).all(orgId)) {
    const n = normName(realName(orgId, c));
    if (!n) continue;
    const key = c.kind === 'organisation' ? `org|${n}` : (c.primary_org_contact_id ? `person|${n}|${c.primary_org_contact_id}` : null);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c.id);
  }
  for (const [key, ids] of byKey) {
    for (let x = 0; x < ids.length; x += 1) for (let y = x + 1; y < ids.length; y += 1) add(ids[x], ids[y], key.startsWith('org|') ? 'name' : 'name_org');
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const card = (id) => {
    const r = store.getContactRow(orgId, id);
    return { id: r.id, kind: r.kind, display_name: realName(orgId, r), status: r.status, created_at: r.created_at };
  };
  return [...pairs.values()].slice(0, lim).map((p) => {
    const a = card(p.a);
    const b = card(p.b);
    return { a, b, reasons: [...p.reasons].sort(), suggested_survivor: a.created_at <= b.created_at ? a.id : b.id };
  });
}

module.exports = { UNDO_WINDOW_MS, mergeContacts, undoMerge, listMerges, getMerge, purgeExpired, findDuplicates, normName };
