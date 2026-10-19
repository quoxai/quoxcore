'use strict';

/**
 * devSlotsStore.js — DEVSUITE-SLOTS Phase 3: durable, org-scoped slot
 * registry (migrations/aee/011-dev-slots.sql; design in QuoxPlan
 * DEVSUITE-SLOTS plan v2 section 2a).
 *
 * A slot is a fixed, owner-curated address (T1..T8, or named: `triage`,
 * `builder`) that a session checks out and releases. Checkout is a single
 * compare-and-swap UPDATE (state='free' -> 'held') so two sessions racing
 * the same slot cannot both win: exactly one UPDATE reports changes===1,
 * the loser gets a conflict result. A server-side sweep (never a browser
 * timer, per the collector-owned-scheduling rule) ages a held slot whose
 * heartbeat has lapsed to 'stale', then frees it after a further TTL.
 *
 * Same DI shape as devServersStore.js / qlusterDelegationStore.js: every
 * exported function is bound to a db handle via createDevSlotsStore, so
 * tests run against a throwaway better-sqlite3 db with zero module state.
 * Every method except sweepStale requires orgId — sweepStale is
 * deliberately global (server maintenance across all orgs in one pass).
 */

const crypto = require('crypto');

const SLOT_NAME_RE = /^[a-z0-9-]{1,32}$/;

// QUOXIDENTITY P10: a member row lapses (and is dropped by the sweep) after
// this long without a heartbeat. Matches the default held TTL.
const MEMBER_TTL_MS = 15 * 60 * 1000;

/**
 * The ONE slot-voice predicate (QUOXIDENTITY P10). A caller is the slot's
 * voice when it is the recorded holder, or a live member. Every gate (say,
 * claim, read) asks this; no route re-implements it.
 *
 * @param {object} slot - slot record (getSlot adds `members`, live only).
 * @param {{session?: string, identity?: string, memberKey?: string}} caller
 *   memberKey is the verified attach_lease_id; a caller carrying one is an
 *   attach caller, and it is also voice when its AGENT identity equals the
 *   hold's recorded identity (same agent, another splinter).
 */
function isSlotVoice(slot, caller) {
  if (!slot || !caller) return false;
  if (caller.session && slot.holder_session && caller.session === slot.holder_session) return true;
  if (!caller.memberKey) return false;
  if (Array.isArray(slot.members) && slot.members.some((m) => m.member_key === caller.memberKey)) return true;
  return !!(caller.identity && slot.holder_identity && caller.identity === slot.holder_identity);
}

function newSlotId() {
  return `slot_${crypto.randomBytes(12).toString('hex')}`;
}

function isUniqueViolation(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('UNIQUE');
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    state: row.state,
    holder_session: row.holder_session || null,
    holder_identity: row.holder_identity || null,
    holder_kind: row.holder_kind || null,
    host_id: row.host_id || null,
    matrix_room_id: row.matrix_room_id || null,
    checked_out_at: row.checked_out_at || null,
    last_heartbeat_at: row.last_heartbeat_at || null,
    released_at: row.released_at || null,
    created_by: row.created_by || null,
    notes: row.notes || null,
    created_at: row.created_at,
    assigned_to: row.assigned_to || null,
    discord_channel_id: row.discord_channel_id || null,
    discord_webhook_url: row.discord_webhook_url || null,
    last_read_at: row.last_read_at || null,
    last_read_rowid: row.last_read_rowid == null ? null : row.last_read_rowid,
    // DEVSUITE-SLOTS P1-TRUST slice 3: sweepStale stamps last_heartbeat_at
    // to the sweep time the moment a held slot ages into 'stale' (see
    // sweepStale below), so that column already carries "went stale at" —
    // but only readable as that for state==='stale'; for a still-held slot
    // it means "last heartbeat". Overloading one column with two meanings
    // is exactly how `slot list` rendered a swept-stale slot's HEARTBEAT
    // as "4m ago", reading as a live heartbeat instead of a stale marker
    // (observed live). stale_since exposes the SAME timestamp under its
    // own name, distinctly, only for a slot that is actually stale right
    // now — so a consumer never has to re-derive "is this heartbeat or
    // staleness" from state + last_heartbeat_at itself.
    stale_since: row.state === 'stale' ? (row.last_heartbeat_at || null) : null,
  };
}

// A held slot with unread mail is a visible state, not a silent one (owner
// incident, 2026-08-22/23: a heartbeating holder that never reads its room
// looks identical to an attended one). unread_count is DERIVED here, never
// stored: it is recomputed from dev_slot_messages every time a record is
// read, so it can never drift from the truth the way a cached counter
// could. Counts messages newer than the record's last_read_at (or every
// message, when last_read_at is null — "never read at all") that were not
// authored by the record's own current holder, because a holder's own
// posts are not unread mail waiting on them. A free slot has no holder to
// exclude, so every message since last_read_at counts.
function countUnreadMessages(db, { orgId, slotId, holderSession, sinceExclusive, sinceRowid }) {
  const params = [orgId, slotId];
  let where = 'org_id = ? AND slot_id = ?';
  // The read cursor is a message position (049): rows after the last one the holder received. The timestamp
  // rule below is only the fallback for a slot read before 049 and not since.
  if (sinceRowid != null) {
    where += ' AND rowid > ?';
    params.push(sinceRowid);
  } else if (sinceExclusive) {
    where += ' AND created_at > ?';
    params.push(sinceExclusive);
  }
  if (holderSession) {
    where += ' AND (from_label IS NULL OR from_label != ?)';
    params.push(holderSession);
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM dev_slot_messages WHERE ${where}`).get(...params);
  return row ? row.c : 0;
}

/**
 * @param {object} deps
 * @param {Function} deps.getDb - returns the better-sqlite3 handle (may be
 *   evaluated lazily, matching the aeeDb-not-ready-at-require-time pattern
 *   the dev-sessions routes already use).
 * @param {Function} [deps.now] - ISO-8601 clock, test override.
 */
function createDevSlotsStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createDevSlotsStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('devSlotsStore: db not available');
    return handle;
  }

  function getSlotRow(orgId, name) {
    return db().prepare('SELECT * FROM dev_slots WHERE org_id = ? AND name = ?').get(orgId, name) || null;
  }

  // Attaches the derived unread_count (see countUnreadMessages above) to an
  // already-built record. A no-op for null (unknown slot).
  function withUnread(record) {
    if (!record) return record;
    const unread_count = countUnreadMessages(db(), {
      orgId: record.org_id,
      slotId: record.id,
      holderSession: record.holder_session,
      sinceExclusive: record.last_read_at,
      sinceRowid: record.last_read_rowid,
    });
    return { ...record, unread_count, members: listLiveMembers(record.org_id, record.name) };
  }

  function listLiveMembers(orgId, name) {
    const cutoff = new Date(Date.parse(now()) - MEMBER_TTL_MS).toISOString();
    return db().prepare(`
      SELECT member_key, agent_id, splinter, member_session, joined_at, last_heartbeat_at
      FROM dev_slot_members WHERE org_id = ? AND slot_name = ? AND last_heartbeat_at >= ?
      ORDER BY joined_at ASC, rowid ASC
    `).all(orgId, name, cutoff);
  }

  // QUOXIDENTITY P10: join a HELD slot as a member (idempotent per member_key;
  // a re-join refreshes the heartbeat). Eligibility (attach caller of the
  // bound agent, same-agent holder) is the caller's job, see lib/slotSplinter.js.
  function joinMember({ orgId, name, memberKey, agentId, splinter, memberSession } = {}) {
    if (!orgId || !name || !memberKey || !agentId || !memberSession) {
      throw new Error('joinMember: orgId, name, memberKey, agentId and memberSession are required');
    }
    const slot = getSlotRow(orgId, name);
    if (!slot) return { ok: false, code: 'not_found' };
    if (slot.state !== 'held') return { ok: false, code: 'not_held' };
    const t = now();
    db().prepare(`
      INSERT INTO dev_slot_members (org_id, slot_name, member_key, agent_id, splinter, member_session, joined_at, last_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, slot_name, member_key)
      DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at, member_session = excluded.member_session,
                    splinter = excluded.splinter
    `).run(orgId, name, memberKey, agentId, splinter || null, memberSession, t, t);
    const member = listLiveMembers(orgId, name).find((m) => m.member_key === memberKey);
    return { ok: true, member, slot: withUnread(rowToRecord(getSlotRow(orgId, name))) };
  }

  function listSlots({ orgId } = {}) {
    if (!orgId) throw new Error('listSlots: orgId is required');
    const rows = db().prepare('SELECT * FROM dev_slots WHERE org_id = ? ORDER BY name').all(orgId);
    return rows.map(rowToRecord).map(withUnread);
  }

  // DEVSUITE-SLOTS Phase 5: single-slot lookup for the say/read routes
  // (they need the slot's id + matrix_room_id, not the whole org listing).
  function getSlot({ orgId, name } = {}) {
    if (!orgId || !name) throw new Error('getSlot: orgId and name are required');
    return withUnread(rowToRecord(getSlotRow(orgId, name)));
  }

  // DEVSUITE-SLOTS Phase 6: org-less lookup for bridge-side steer. A [name]
  // prefix typed on the owner's phone carries no org; the inbound route
  // delivers only when the name is globally unambiguous.
  // Every slot name across ALL orgs (orphan-channel safety: a name live in
  // any org is never an orphan).
  function listAllSlotNames() {
    return db().prepare('SELECT DISTINCT name FROM dev_slots').all().map((r) => r.name);
  }

  function findSlotsByName({ name } = {}) {
    if (!name) throw new Error('findSlotsByName: name is required');
    return db().prepare('SELECT * FROM dev_slots WHERE name = ?').all(name).map(rowToRecord);
  }

  // QUOXIDENTITY: org-agnostic lookup for Matrix-room-driven callers (the
  // appservice's inbound-by-room webhook, CommanderQ's held-slot defer
  // check). A Matrix room id is globally unique, so unlike findSlotsByName
  // this can never be ambiguous across orgs and returns a single record.
  function findSlotByMatrixRoomId({ roomId } = {}) {
    if (!roomId) throw new Error('findSlotByMatrixRoomId: roomId is required');
    return rowToRecord(db().prepare('SELECT * FROM dev_slots WHERE matrix_room_id = ?').get(roomId) || null);
  }

  function createSlot({ orgId, name, createdBy, notes } = {}) {
    if (!orgId || !name) throw new Error('createSlot: orgId and name are required');
    if (!SLOT_NAME_RE.test(name)) return { ok: false, code: 'bad_name' };
    const t = now();
    try {
      db().prepare(`
        INSERT INTO dev_slots (id, org_id, name, state, created_by, notes, created_at)
        VALUES (?, ?, ?, 'free', ?, ?, ?)
      `).run(newSlotId(), orgId, name, createdBy || null, notes || null, t);
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, code: 'duplicate' };
      throw err;
    }
    return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };
  }

  function retireSlot({ orgId, name } = {}) {
    if (!orgId || !name) throw new Error('retireSlot: orgId and name are required');
    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    db().prepare('DELETE FROM dev_slots WHERE org_id = ? AND name = ?').run(orgId, name);
    return { ok: true, slot: rowToRecord(existing) };
  }

  // The checkout compare-and-swap: the WHERE clause's state='free' is what
  // makes two concurrent checkouts race safely — only the UPDATE that finds
  // the row still free can win, so info.changes===1 for exactly one caller.
  //
  // DEVSUITE-SLOTS P1-TRUST slice 1 (`checkout --create`): `create` folds
  // create-if-missing into the SAME call as the checkout, as one atomic
  // INSERT (state='held' from birth) rather than a separate createSlot then
  // checkoutSlot — two sessions cannot land createSlot+checkoutSlot as
  // separate steps without a window where either could win the checkout
  // half. The INSERT's UNIQUE(org_id, name) constraint is what makes THIS
  // atomic: only one concurrent `checkout --create` of the same name can
  // ever have its INSERT succeed; the constraint violation the other(s) hit
  // is caught and they fall through to the normal CAS path below, which by
  // then sees an already-held row and correctly reports 'conflict'.
  function checkoutSlot({ orgId, name, holderSession, holderIdentity, holderKind, hostId, force, create, createdBy, take } = {}) {
    if (!orgId || !name || !holderSession) {
      throw new Error('checkoutSlot: orgId, name and holderSession are required');
    }
    if (create) {
      if (!SLOT_NAME_RE.test(name)) return { ok: false, code: 'bad_name' };
      const t = now();
      try {
        db().prepare(`
          INSERT INTO dev_slots (
            id, org_id, name, state, holder_session, holder_identity, holder_kind, host_id,
            checked_out_at, last_heartbeat_at, created_by, created_at
          ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newSlotId(), orgId, name, holderSession, holderIdentity || null, holderKind || null, hostId || null, t, t, createdBy || holderSession, t);
        return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)), created: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Someone else's INSERT (or a pre-existing slot of the same name)
        // won the race; fall through and treat this exactly like a normal
        // checkout attempt against the now-existing row.
      }
    }
    // An ASSIGNMENT must actually protect the slot. Until 2026-08-23 this
    // matched only state='free' and never read assigned_to, so an assignment
    // was advisory and any session could take a slot assigned to another,
    // first come first served. The owner hit exactly that: he assigned
    // `builder`, released it for the assigned session, and a different
    // session grabbed it seconds later. The dashboard meanwhile promised
    // "assigned to X, it claims the slot when it starts". force lets a human
    // override deliberately, so nobody is ever locked out of their own slot.
    if (!force) {
      const assignedRow = getSlotRow(orgId, name);
      if (assignedRow && assignedRow.assigned_to && assignedRow.assigned_to !== holderSession) {
        return { ok: false, code: 'assigned_to_other', slot: rowToRecord(assignedRow) };
      }
    }
    const t = now();
    // last_read_at is cleared on every fresh checkout: a new holder has
    // never read this channel, even if a previous holder had. Without this
    // reset, an old holder's read watermark would silently hide messages
    // the NEW holder has never seen behind an already-caught-up count.
    const info = db().prepare(`
      UPDATE dev_slots
      SET state = 'held', holder_session = ?, holder_identity = ?, holder_kind = ?, host_id = ?,
          checked_out_at = ?, last_heartbeat_at = ?, released_at = NULL, last_read_at = NULL, last_read_rowid = NULL
      WHERE org_id = ? AND name = ? AND state = 'free'
    `).run(holderSession, holderIdentity || null, holderKind || null, hostId || null, t, t, orgId, name);

    if (info.changes === 1) return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };

    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    // The CURRENT holder re-claiming its own slot (a restarted session, or one
    // recording its session key afresh) is an idempotent refresh, not a
    // conflict: same holder_session AND, when a holder identity is bound, the
    // same identity, so a name alone can never hijack another identity's hold.
    // The read watermark is kept: the holder has not changed.
    // A STALE hold of the same session is the same story (the holder's heartbeat lapsed, it is back): revive it.
    if (['held', 'stale'].includes(existing.state) && existing.holder_session === holderSession
        && (!existing.holder_identity || existing.holder_identity === (holderIdentity || null))) {
      db().prepare(`UPDATE dev_slots SET state = 'held', last_heartbeat_at = ?, holder_kind = COALESCE(?, holder_kind),
          host_id = COALESCE(?, host_id) WHERE org_id = ? AND name = ? AND state IN ('held', 'stale') AND holder_session = ?`)
        .run(t, holderKind || null, hostId || null, orgId, name, holderSession);
      return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)), refreshed: true };
    }
    // Same AUTHENTICATED identity, different session label: the same person's other (or renamed, or restarted)
    // session. A stale hold is theirs to reclaim outright; a live one only on an explicit `take`. Another
    // identity never gets here. The read watermark is kept (same person, same channel).
    const sameUser = Boolean(existing.holder_identity) && existing.holder_identity === (holderIdentity || null);
    if (sameUser && ['held', 'stale'].includes(existing.state) && (existing.state === 'stale' || take === true)) {
      const up = db().prepare(`UPDATE dev_slots SET state = 'held', holder_session = ?, holder_kind = COALESCE(?, holder_kind),
          host_id = COALESCE(?, host_id), checked_out_at = ?, last_heartbeat_at = ?
          WHERE org_id = ? AND name = ? AND state IN ('held', 'stale') AND holder_session = ? AND holder_identity = ?`)
        .run(holderSession, holderKind || null, hostId || null, t, t, orgId, name, existing.holder_session, existing.holder_identity);
      if (up.changes === 1) {
        return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)),
          tookOver: { from: existing.holder_session, state: existing.state, last_seen: existing.last_heartbeat_at } };
      }
    }
    return { ok: false, code: 'conflict', slot: rowToRecord(existing), sameUser };
  }

  // Only the current holder releases, unless force is set (owner override —
  // e.g. clearing a wedged slot from the dashboard). A slot that is not
  // currently held is treated as an idempotent no-op success: a retry of a
  // release that already landed must not error.
  function releaseSlot({ orgId, name, holderSession, holderIdentity, memberKey, force } = {}) {
    if (!orgId || !name) throw new Error('releaseSlot: orgId and name are required');
    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    // Only a FREE slot is the idempotent no-op. A STALE slot still has a holder on record: treating it as
    // "not held" reported success while holder_session stayed put (owner stuck, 2026-10-14).
    if (existing.state === 'free') return { ok: true, slot: rowToRecord(existing) };
    const t = now();
    // The holder is the recorded session, or the same authenticated identity (their other/renamed session).
    const isHolder = existing.holder_session === holderSession
      || (Boolean(existing.holder_identity) && existing.holder_identity === (holderIdentity || null));
    // P10: a member releasing removes ONLY its own row; the hold is untouched.
    if (!force && !isHolder && memberKey) {
      const del = db().prepare(
        'DELETE FROM dev_slot_members WHERE org_id = ? AND slot_name = ? AND member_key = ?'
      ).run(orgId, name, memberKey);
      if (del.changes === 1) return { ok: true, slot: withUnread(rowToRecord(existing)), memberReleased: true };
    }
    if (!force && !isHolder) {
      return { ok: false, code: 'forbidden' };
    }
    // P10: holder release promotes the oldest LIVE member to holder.
    if (!force) {
      const next = listLiveMembers(orgId, name)[0];
      if (next) {
        db().prepare('DELETE FROM dev_slot_members WHERE org_id = ? AND slot_name = ? AND member_key = ?')
          .run(orgId, name, next.member_key);
        db().prepare(`
          UPDATE dev_slots
          SET holder_session = ?, holder_identity = ?, last_heartbeat_at = ?
          WHERE org_id = ? AND name = ?
        `).run(next.member_session, `agent:${next.agent_id}`, t, orgId, name);
        return { ok: true, slot: withUnread(rowToRecord(getSlotRow(orgId, name))), promoted: next };
      }
    }
    db().prepare('DELETE FROM dev_slot_members WHERE org_id = ? AND slot_name = ?').run(orgId, name);
    db().prepare(`
      UPDATE dev_slots
      SET state = 'free', holder_session = NULL, holder_identity = NULL, holder_kind = NULL, host_id = NULL,
          checked_out_at = NULL, last_heartbeat_at = NULL, released_at = ?
      WHERE org_id = ? AND name = ?
    `).run(t, orgId, name);
    return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };
  }

  // CAS on (state='held' AND holder_session=holderSession) so a lapsed
  // holder (already swept to stale, or stolen via force-release) cannot
  // resurrect its own hold with a stray heartbeat.
  function heartbeatSlot({ orgId, name, holderSession, memberKey } = {}) {
    if (!orgId || !name || !holderSession) {
      throw new Error('heartbeatSlot: orgId, name and holderSession are required');
    }
    const t = now();
    // P10: a live member's heartbeat refreshes its own row AND the slot's
    // hold (reviving stale -> held, same as the holder's own heartbeat).
    // Only a recorded member qualifies; the recorded holder takes the path below.
    if (memberKey) {
      const row = getSlotRow(orgId, name);
      if (row && row.holder_session !== holderSession && ['held', 'stale'].includes(row.state)
          && listLiveMembers(orgId, name).some((m) => m.member_key === memberKey)) {
        db().prepare('UPDATE dev_slot_members SET last_heartbeat_at = ? WHERE org_id = ? AND slot_name = ? AND member_key = ?')
          .run(t, orgId, name, memberKey);
        db().prepare("UPDATE dev_slots SET state = 'held', last_heartbeat_at = ? WHERE org_id = ? AND name = ?").run(t, orgId, name);
        return { ok: true, slot: withUnread(rowToRecord(getSlotRow(orgId, name))), member: true };
      }
    }
    // A heartbeat from the RECORDED holder also revives 'stale' -> 'held'
    // (SLOTS-PERFECT, 2026-10-03). Stale means "maybe dead"; the holder's own
    // heartbeat proves it alive. Without this a holder whose heartbeats lapsed
    // (an outage, a forgotten wait) got 409 and could not reclaim its own slot
    // without --force, because checkout only takes 'free'. Nobody else can
    // take a stale slot without force, so this steals nothing.
    const info = db().prepare(`
      UPDATE dev_slots SET state = 'held', last_heartbeat_at = ?
      WHERE org_id = ? AND name = ? AND state IN ('held', 'stale') AND holder_session = ?
    `).run(t, orgId, name, holderSession);

    if (info.changes === 1) return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };

    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    if (existing.state !== 'held' && existing.state !== 'stale') return { ok: false, code: 'not_held' };
    return { ok: false, code: 'forbidden' };
  }

  // CAS on (state='held' AND holder_session=holderSession), same shape as
  // heartbeatSlot above: a bystander polling the room, or a lapsed holder,
  // must never mark the CURRENT holder as caught up. Called from the routes
  // that genuinely constitute reading (GET .../messages, GET .../wait), and
  // only when the caller identifies itself as the holder. This is the write
  // side of the visible-unread fix: last_read_at is what unread_count (see
  // countUnreadMessages) measures every non-self message against.
  // readThrough: the id of the LAST message this read delivered to the caller. The cursor moves to that message
  // and never past it, so a message landing between the fetch and this stamp (or in the same millisecond) stays
  // unread. null = the read delivered nothing new (the cursor stays). Omitted = everything stored right now was
  // read (direct store callers). An id that is not this slot's message never moves the cursor. Never backwards.
  function readCursorFor(orgId, name, readThrough) {
    const row = getSlotRow(orgId, name);
    const current = row && row.last_read_rowid != null ? row.last_read_rowid : 0;
    if (!row || readThrough === null) return current;
    let target;
    if (readThrough === undefined) {
      const m = db().prepare('SELECT MAX(rowid) AS r FROM dev_slot_messages WHERE org_id = ? AND slot_id = ?').get(orgId, row.id);
      target = m && m.r != null ? m.r : 0;
    } else {
      const m = db().prepare('SELECT rowid AS r FROM dev_slot_messages WHERE id = ? AND org_id = ? AND slot_id = ?').get(String(readThrough), orgId, row.id);
      target = m ? m.r : current;
    }
    return Math.max(current, target);
  }

  function touchSlotRead({ orgId, name, holderSession, memberKey, readThrough } = {}) {
    if (!orgId || !name || !holderSession) {
      throw new Error('touchSlotRead: orgId, name and holderSession are required');
    }
    const t = now();
    const cursor = readCursorFor(orgId, name, readThrough);
    // P10: a live member reading is the slot's voice reading (same predicate).
    if (memberKey) {
      const slot = getSlot({ orgId, name });
      if (slot && slot.state === 'held' && isSlotVoice(slot, { session: holderSession, memberKey })) {
        db().prepare('UPDATE dev_slots SET last_read_at = ?, last_read_rowid = ? WHERE org_id = ? AND name = ?').run(t, cursor, orgId, name);
        return { ok: true, slot: getSlot({ orgId, name }) };
      }
    }
    const info = db().prepare(`
      UPDATE dev_slots SET last_read_at = ?, last_read_rowid = ?
      WHERE org_id = ? AND name = ? AND state = 'held' AND holder_session = ?
    `).run(t, cursor, orgId, name, holderSession);

    if (info.changes === 1) return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };

    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    if (existing.state !== 'held') return { ok: false, code: 'not_held' };
    return { ok: false, code: 'forbidden' };
  }

  // DEVSUITE-SLOTS "Option B" assign model (plan v2 note #2831): the owner
  // names an EXPECTED holder for a slot ahead of time. This never touches
  // state/holder_session — the slot stays free until a session actually
  // claims it (claimForSession below). assignedTo of null/'' clears the
  // assignment (the slot reverts to unassigned, still checkoutable by name).
  function assignSlot({ orgId, name, assignedTo } = {}) {
    if (!orgId || !name) throw new Error('assignSlot: orgId and name are required');
    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'unknown' };
    const value = assignedTo || null;
    db().prepare('UPDATE dev_slots SET assigned_to = ? WHERE org_id = ? AND name = ?').run(value, orgId, name);
    return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };
  }

  // DEVSUITE-SLOTS "Option B" claim: a session checks out every FREE slot
  // assigned to its own name. Reuses the exact checkoutSlot CAS per slot
  // (state='free' -> 'held') so a held or stale slot assigned to this
  // session is simply skipped, never stolen. Returns the list of slots the
  // caller actually won; an empty array is a normal outcome (nothing
  // assigned, or everything assigned is already held elsewhere).
  function claimForSession({ orgId, session, holderKind, hostId } = {}) {
    if (!orgId || !session) throw new Error('claimForSession: orgId and session are required');
    const rows = db().prepare(
      "SELECT * FROM dev_slots WHERE org_id = ? AND assigned_to = ? AND state = 'free'"
    ).all(orgId, session);
    const claimed = [];
    for (const row of rows) {
      const result = checkoutSlot({ orgId, name: row.name, holderSession: session, holderKind, hostId });
      if (result.ok) claimed.push(result.slot);
    }
    return claimed;
  }

  // DEVSUITE-SLOTS phase 4: stamp the derived Matrix room id back onto the
  // slot row after a successful auth provision-node call. The auth-side
  // matrix_rooms ledger (UNIQUE(org_id, node_type, node_id)) is the mapping
  // TRUTH per the substrate-native law; this column is a denorm cache only,
  // read by the CLI/dashboard so a slot listing never needs a second
  // service call. Idempotent no-op success when the slot no longer exists
  // (the room-provision call is fire-and-forget and can land after a retire).
  function setSlotRoomId({ orgId, name, roomId } = {}) {
    if (!orgId || !name || !roomId) {
      throw new Error('setSlotRoomId: orgId, name and roomId are required');
    }
    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    db().prepare(
      'UPDATE dev_slots SET matrix_room_id = ? WHERE org_id = ? AND name = ?'
    ).run(roomId, orgId, name);
    return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };
  }

  // Global maintenance sweep, deliberately NOT org-scoped (a single server-
  // side interval covers every org in one pass). Two-stage: held rows whose
  // heartbeat has lapsed beyond heldTtlMs move to 'stale' (their
  // last_heartbeat_at is stamped to the sweep time, which doubles as the
  // "went stale at" marker); stale rows whose stale-marker has itself
  // lapsed beyond staleTtlMs are freed, clearing every holder field so a
  // fresh checkout can win the slot.
  function sweepStale({ heldTtlMs, staleTtlMs, now: nowMs = Date.now(), floorMs } = {}) {
    if (!Number.isFinite(heldTtlMs) || !Number.isFinite(staleTtlMs)) {
      throw new Error('sweepStale: heldTtlMs and staleTtlMs are required numbers');
    }
    const t = new Date(nowMs).toISOString();
    // Boot grace: while the collector was down holders could not heartbeat, so
    // a lapse can only be judged by evidence gathered while up. With floorMs
    // (process start) this is effective_heartbeat = max(last_heartbeat_at,
    // floorMs): no held->stale until the collector has been up heldTtlMs, no
    // stale->free until it has been up staleTtlMs.
    const hasFloor = Number.isFinite(floorMs);
    const upMs = hasFloor ? nowMs - floorMs : Infinity;
    const skipHeld = upMs < heldTtlMs;
    const skipStale = upMs < staleTtlMs;
    const heldCutoff = new Date(nowMs - heldTtlMs).toISOString();
    const staleCutoff = new Date(nowMs - staleTtlMs).toISOString();
    if (skipHeld && skipStale) return { heldToStale: 0, staleToFree: 0, wentStale: [], wentFree: [], membersDropped: 0 };

    // P10: lapsed members are dropped first (same boot-grace as held->stale:
    // a member could not heartbeat while the collector was down either).
    const membersDropped = skipHeld ? 0 : db().prepare(
      'DELETE FROM dev_slot_members WHERE last_heartbeat_at < ?'
    ).run(new Date(nowMs - MEMBER_TTL_MS).toISOString()).changes;
    // A slot is stale only when the holder AND every member are stale. A member
    // heartbeat also stamps the slot's own heartbeat, so this clause is the
    // belt to that braces for a member that joined after the holder's last beat.
    const noLiveMember = `NOT EXISTS (SELECT 1 FROM dev_slot_members m
      WHERE m.org_id = dev_slots.org_id AND m.slot_name = dev_slots.name AND m.last_heartbeat_at >= ?)`;

    // The affected rows are captured BEFORE each UPDATE (same WHERE) so the
    // caller can rewrite per-slot status surfaces (the Discord pinned card,
    // item 5) for exactly the slots that transitioned, without a diff pass.
    const wentStale = skipHeld ? [] : db().prepare(`
      SELECT org_id, name, holder_session, host_id, discord_channel_id FROM dev_slots
      WHERE state = 'held' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ? AND ${noLiveMember}
    `).all(heldCutoff, heldCutoff);
    const heldToStale = skipHeld ? 0 : db().prepare(`
      UPDATE dev_slots SET state = 'stale', last_heartbeat_at = ?
      WHERE state = 'held' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ? AND ${noLiveMember}
    `).run(t, heldCutoff, heldCutoff).changes;

    const wentFree = skipStale ? [] : db().prepare(`
      SELECT org_id, name, holder_session, host_id, discord_channel_id FROM dev_slots
      WHERE state = 'stale' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?
    `).all(staleCutoff);
    const staleToFree = skipStale ? 0 : db().prepare(`
      UPDATE dev_slots
      SET state = 'free', holder_session = NULL, holder_identity = NULL, holder_kind = NULL, host_id = NULL,
          checked_out_at = NULL, last_heartbeat_at = NULL, released_at = ?
      WHERE state = 'stale' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?
    `).run(t, staleCutoff).changes;

    // A freed slot has no members left.
    for (const f of wentFree) {
      db().prepare('DELETE FROM dev_slot_members WHERE org_id = ? AND slot_name = ?').run(f.org_id, f.name);
    }

    return { heldToStale, staleToFree, wentStale, wentFree, membersDropped };
  }

  // Denorm write-back for the per-slot Discord channel (item 5), same
  // contract as setSlotRoomId above: Discord is where the channel lives,
  // these columns only cache the pointer so the say path and status-card
  // updates need no daemon round trip to find it.
  function setSlotDiscord({ orgId, name, channelId, webhookUrl }) {
    const existing = getSlotRow(orgId, name);
    if (!existing) return { ok: false, code: 'not_found' };
    db().prepare(
      'UPDATE dev_slots SET discord_channel_id = ?, discord_webhook_url = ? WHERE org_id = ? AND name = ?'
    ).run(channelId || null, webhookUrl || null, orgId, name);
    return { ok: true, slot: rowToRecord(getSlotRow(orgId, name)) };
  }

  // Every held or stale holder across ALL orgs, for the tmux reap
  // (devSessionsReaper.js): like sweepStale, one server-side pass covers
  // every org — a session's slot protects it regardless of which org owns
  // the slot. Stale counts as held here: a stale slot still names its
  // holder and release-never-kills applies until the row is actually freed.
  function listHeldSlots() {
    return db().prepare(`
      SELECT holder_session, host_id, state FROM dev_slots
      WHERE state IN ('held', 'stale') AND holder_session IS NOT NULL
    `).all();
  }

  return {
    listSlots,
    getSlot,
    findSlotsByName,
    listAllSlotNames,
    findSlotByMatrixRoomId,
    createSlot,
    retireSlot,
    checkoutSlot,
    releaseSlot,
    heartbeatSlot,
    joinMember,
    touchSlotRead,
    assignSlot,
    claimForSession,
    setSlotRoomId,
    setSlotDiscord,
    sweepStale,
    listHeldSlots,
  };
}

// The read routes (GET /slots/:name/messages and /wait) mark the holder's read THROUGH the last message they
// delivered, never "now": readThrough = the last delivered message's id, or null when nothing was delivered.
function readThroughOf(delivered) {
  return Array.isArray(delivered) && delivered.length ? delivered[delivered.length - 1].id : null;
}

module.exports = {
  SLOT_NAME_RE,
  MEMBER_TTL_MS,
  isSlotVoice,
  createDevSlotsStore,
  readThroughOf,
};
