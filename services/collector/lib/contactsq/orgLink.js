'use strict';

/**
 * A person's organisation as a plain field. The owner's rule: every contact has a NAME and an ORGANISATION, not a
 * person-or-organisation choice. Underneath it stays the graph: the organisation is its own contact (found by name or
 * created) and the person points at it with a works_at edge whose encrypted attrs carry the role. This module is the
 * one place create and edit set that line, so both paths agree.
 */

const store = require('./store.js');
const strictNames = require('./strictNames.js');
const { normName } = require('./merge.js');

const MAX_NAME = 200;
const MAX_ROLE = 100;

/** -> { ok, value: null | { name, role } } ; null clears the organisation. */
function validateOrganisation(v) {
  if (v === null) return { ok: true, value: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false };
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (v.name !== undefined && v.name !== null && typeof v.name !== 'string') return { ok: false };
  if (v.role !== undefined && v.role !== null && typeof v.role !== 'string') return { ok: false };
  const role = typeof v.role === 'string' ? v.role.trim() : '';
  if (name.length > MAX_NAME || role.length > MAX_ROLE) return { ok: false };
  if (!name) return { ok: true, value: null };
  return { ok: true, value: { name, role: role || null } };
}

function orgDisplayName(orgId, row) {
  return strictNames.revealName(orgId, row, row.display_name_ct ? store.dekFor(row) : null) || '';
}

/** A live organisation contact with this name (case and punctuation folded), or null. */
function findOrganisation(orgId, name) {
  const key = normName(name);
  if (!key) return null;
  const rows = store.getDb().prepare("SELECT * FROM contacts WHERE org_id = ? AND kind = 'organisation' AND status IN ('candidate','active')").all(orgId);
  return rows.find((o) => normName(orgDisplayName(orgId, o)) === key) || null;
}

/**
 * Point the person at `org` ({ name, role }) or clear it (null). Re-uses an existing organisation of the same name,
 * else creates one. Ends (deletes) the works_at edge to the previous primary organisation when it changes.
 * -> { org_contact_id: string|null, created: boolean, changed: boolean }
 */
function setOrganisation(orgId, personRow, org, { by = null } = {}) {
  if (!personRow || personRow.kind === 'organisation') return { org_contact_id: null, created: false, changed: false };
  const db = store.getDb();
  const prevId = personRow.primary_org_contact_id || null;
  const prevEdges = prevId ? store.edgesFor(orgId, personRow.id).filter((e) => e.type === 'works_at' && e.from_id === personRow.id && e.to_id === prevId) : [];
  if (!org) {
    if (!prevId) return { org_contact_id: null, created: false, changed: false };
    for (const e of prevEdges) store.deleteEdge(orgId, e.id);
    db.prepare('UPDATE contacts SET primary_org_contact_id = NULL, updated_at = ? WHERE id = ? AND org_id = ?').run(store.nowIso(), personRow.id, orgId);
    return { org_contact_id: null, created: false, changed: true };
  }
  let target = null;
  const prevRow = prevId ? store.getContactRow(orgId, prevId) : null;
  if (prevRow && prevRow.status !== 'erased' && normName(orgDisplayName(orgId, prevRow)) === normName(org.name)) target = prevRow;
  let created = false;
  if (!target) target = findOrganisation(orgId, org.name);
  if (!target) {
    ({ contact: target } = store.createContact(orgId, { display_name: org.name, kind: 'organisation', status: 'active', created_by: by }));
    target = store.getContactRow(orgId, target.id);
    created = true;
  }
  const sameOrg = prevRow && target.id === prevRow.id;
  const currentRole = sameOrg && prevEdges[0] ? (store.edgeAttrs(orgId, prevEdges[0]).role || null) : null;
  if (sameOrg && prevEdges.length && currentRole === (org.role || null)) return { org_contact_id: target.id, created, changed: false };
  for (const e of prevEdges) store.deleteEdge(orgId, e.id);
  db.prepare('UPDATE contacts SET primary_org_contact_id = NULL WHERE id = ? AND org_id = ?').run(personRow.id, orgId);
  const existing = store.findEdge(orgId, personRow.id, target.id, 'works_at');
  if (existing) store.deleteEdge(orgId, existing.id);
  const fresh = store.getContactRow(orgId, personRow.id);
  store.addEdge(orgId, fresh, target, { type: 'works_at', attrs: org.role ? { role: org.role } : {}, created_by: by });
  return { org_contact_id: target.id, created, changed: true };
}

module.exports = { validateOrganisation, setOrganisation, findOrganisation };
