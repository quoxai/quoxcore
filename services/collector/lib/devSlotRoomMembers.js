'use strict';

/**
 * devSlotRoomMembers.js, QUOXON-ROOMS: durable, org-scoped room membership for slots
 * (migrations/aee/044-dev-slot-room-members.sql). A member may subscribe to a slot's live
 * stream and post to it without holding it. Holding (checkout) stays exclusive and separate.
 * Every query carries org_id, so a membership in one org can never open a slot in another.
 */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$/;
const clean = (s, max) => String(s || '').replace(/[^A-Za-z0-9._@:\- ]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function createDevSlotRoomMembers({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createDevSlotRoomMembers: getDb function is required');
  const db = () => { const h = getDb(); if (!h) throw new Error('devSlotRoomMembers: db not available'); return h; };

  function join({ orgId, slotId, slotName, session, person = null, identity = null }) {
    if (!orgId || !slotId) throw new Error('join: orgId and slotId are required');
    if (!SESSION_RE.test(String(session || ''))) return { ok: false, error: 'a valid session name is required' };
    const row = { org_id: orgId, slot_id: slotId, slot_name: slotName, session, person: clean(person, 24) || null, identity: identity || null, joined_at: now() };
    const prev = db().prepare('SELECT joined_at FROM dev_slot_room_members WHERE org_id=? AND slot_id=? AND session=?').get(orgId, slotId, session);
    db().prepare(`INSERT INTO dev_slot_room_members (org_id, slot_id, slot_name, session, person, identity, joined_at)
      VALUES (@org_id, @slot_id, @slot_name, @session, @person, @identity, @joined_at)
      ON CONFLICT(org_id, slot_id, session) DO UPDATE SET person=excluded.person, identity=excluded.identity, slot_name=excluded.slot_name`).run(row);
    return { ok: true, already: Boolean(prev), member: { ...row, joined_at: prev ? prev.joined_at : row.joined_at } };
  }
  function leave({ orgId, slotId, session }) {
    const r = db().prepare('DELETE FROM dev_slot_room_members WHERE org_id=? AND slot_id=? AND session=?').run(orgId, slotId, session);
    return { ok: true, removed: r.changes > 0 };
  }
  function getMember({ orgId, slotId, session }) {
    if (!orgId || !slotId || !session) return null;
    return db().prepare('SELECT * FROM dev_slot_room_members WHERE org_id=? AND slot_id=? AND session=?').get(orgId, slotId, session) || null;
  }
  const isMember = (a) => Boolean(getMember(a));
  function listMembers({ orgId, slotId }) {
    return db().prepare('SELECT session, person, joined_at FROM dev_slot_room_members WHERE org_id=? AND slot_id=? ORDER BY joined_at').all(orgId, slotId);
  }
  function listForSession({ orgId, session }) {
    return db().prepare('SELECT slot_id, slot_name, joined_at FROM dev_slot_room_members WHERE org_id=? AND session=? ORDER BY slot_name').all(orgId, session);
  }
  /** What a member's post is signed as: server-derived from the membership, never a human profile. */
  function senderFor(member) { return member.person ? `${member.session} (${member.person})` : member.session; }

  return { join, leave, getMember, isMember, listMembers, listForSession, senderFor };
}

module.exports = { createDevSlotRoomMembers, SESSION_RE };
