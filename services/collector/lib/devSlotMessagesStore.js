'use strict';

const { EventEmitter } = require('events');

/**
 * devSlotMessagesStore.js — DEVSUITE-SLOTS Phase 5: the say/read message
 * cache behind a slot's Matrix room (migrations/aee/012-dev-slot-messages.sql;
 * design in QuoxPlan DEVSUITE-SLOTS plan v2 sections 1b/1c/2c).
 *
 * This store is a CACHE, not the truth — the slot's Matrix room stays the
 * source of record (see the migration file's header for why the cache
 * exists at all: no server-side room-timeline read precedent was found).
 * Phase 6 unifies the read onto a real Matrix timeline query.
 *
 * Same DI shape as devSlotsStore.js: every exported function is bound to a
 * db handle via createDevSlotMessagesStore, so tests run against a
 * throwaway better-sqlite3 db with zero module state.
 */

const crypto = require('crypto');
const { isSlotVoice } = require('./devSlotsStore.js');

function newMessageId() {
  return `slotmsg_${crypto.randomBytes(12).toString('hex')}`;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    slot_id: row.slot_id,
    slot_name: row.slot_name,
    from: row.from_label || null,
    // Server-derived, unforgeable identity (migrations/aee/022). from_label
    // stays the caller-chosen display name; this is the trustworthy field
    // for "who actually posted", see deriveCallerIdentity below.
    author_identity: row.author_identity || null,
    text: row.text,
    source: row.source,
    created_at: row.created_at,
    // QUOXIDENTITY P10: who claimed it (first claimer wins) and who it was for.
    claimed_by: row.claimed_by || null,
    claimed_at: row.claimed_at || null,
    addressed_to: row.addressed_to || null,
  };
}

// QUOXIDENTITY P10: a LEADING @all, @S<n> or @M<id> addresses a message.
// Parsed server-side at insert so every ingress (say, inbound, matrix) agrees.
const ADDRESS_RE = /^\s*@(all|S\d+|M\d+)(?=[\s:,]|$)/i;
function parseAddressedTo(text) {
  const m = ADDRESS_RE.exec(String(text || ''));
  if (!m) return null;
  const v = m[1];
  return v.toLowerCase() === 'all' ? 'all' : v.toUpperCase();
}

// Label validation (migrations/aee/022): the caller-chosen display name
// (from_label) is still free text, but unbounded free text landing on
// every rendered surface (CLI tables, bridge lines, the dashboard) is a
// markup/newline-injection risk, not just a spoofing risk. Reject rather
// than silently truncate or strip, so a caller finds out immediately
// instead of getting a mangled label.
const LABEL_MAX_LEN = 64;
// Space is allowed (multi-word labels like "QUOX SECURITY" are legitimate);
// tab/newline/CR and everything else are not — those are exactly what would
// smuggle markup or a fake extra line into every rendered surface (CLI
// tables, bridge lines, the dashboard), which is the whole point of this
// check, so "whitespace" here means the space character, not \s.
const LABEL_ALLOWED_RE = /^[A-Za-z0-9._@:\- ]*$/;

/**
 * Validate a client-supplied slot message label (the `from` field of a say).
 * `null`/`undefined`/empty string are valid (no label supplied — the caller
 * falls back to the derived identity, see deriveSlotAuthor).
 *
 * @returns {{ok: true, value: string|null} | {ok: false, error: string}}
 */
function validateSlotLabel(label) {
  if (label === undefined || label === null) return { ok: true, value: null };
  const s = String(label);
  if (s.trim() === '') return { ok: true, value: null };
  if (s.length > LABEL_MAX_LEN) {
    return { ok: false, error: `from label too long (max ${LABEL_MAX_LEN} characters)` };
  }
  if (!LABEL_ALLOWED_RE.test(s)) {
    return { ok: false, error: 'from label contains disallowed characters (allowed: letters, digits, and . _ @ : - and single spaces)' };
  }
  return { ok: true, value: s };
}

/**
 * @param {object} deps
 * @param {Function} deps.getDb - returns the better-sqlite3 handle.
 * @param {Function} [deps.now] - ISO-8601 clock, test override.
 */
function createDevSlotMessagesStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createDevSlotMessagesStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('devSlotMessagesStore: db not available');
    return handle;
  }

  // In-process notify so slot waiters never poll the DB. Keyed org+slot.
  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  function subscribe({ orgId, slotId } = {}, cb) {
    const key = `${orgId}:${slotId}`;
    bus.on(key, cb);
    return () => bus.off(key, cb);
  }

  function appendMessage({ orgId, slotId, slotName, from, authorIdentity, text, source } = {}) {
    if (!orgId || !slotId || !slotName || !text) {
      throw new Error('appendMessage: orgId, slotId, slotName and text are required');
    }
    const t = now();
    const id = newMessageId();
    db().prepare(`
      INSERT INTO dev_slot_messages (id, org_id, slot_id, slot_name, from_label, author_identity, text, source, created_at, addressed_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, slotId, slotName, from || null, authorIdentity || null, text, source || 'say', t, parseAddressedTo(text));
    const rec = rowToRecord(db().prepare('SELECT * FROM dev_slot_messages WHERE id = ?').get(id));
    bus.emit(`${orgId}:${slotId}`, rec);
    return rec;
  }

  // Newest-created-first insertion, returned oldest-first (chat reading
  // order) — matches how a room timeline reads. `since` is an ISO-8601
  // created_at cutoff (exclusive); `limit` caps the page, most-recent slice.
  function listMessages({ orgId, slotId, since, limit } = {}) {
    if (!orgId || !slotId) throw new Error('listMessages: orgId and slotId are required');
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    const params = [orgId, slotId];
    let where = 'org_id = ? AND slot_id = ?';
    if (since) {
      where += ' AND created_at > ?';
      params.push(since);
    }
    // rowid tiebreak (audit 2026-08-17): created_at is ISO ms-resolution, so a
    // say + a steer landing in the same millisecond had SQLite-undefined
    // relative order that could flip between reads. rowid is the stable
    // insertion order within a tie.
    const rows = db().prepare(`
      SELECT * FROM dev_slot_messages WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...params, cap);
    return rows.reverse().map(rowToRecord);
  }

  // QUOXIDENTITY P10: atomic claim. The WHERE claimed_by IS NULL is the CAS, so
  // exactly one of two racing claimers gets changes===1; the loser learns who won.
  function claimMessage({ orgId, slotId, messageId, claimedBy } = {}) {
    if (!orgId || !slotId || !messageId || !claimedBy) {
      throw new Error('claimMessage: orgId, slotId, messageId and claimedBy are required');
    }
    const info = db().prepare(`
      UPDATE dev_slot_messages SET claimed_by = ?, claimed_at = ?
      WHERE id = ? AND org_id = ? AND slot_id = ? AND claimed_by IS NULL
    `).run(claimedBy, now(), messageId, orgId, slotId);
    if (info.changes === 1) return { ok: true, claimed_by: claimedBy };
    const row = db().prepare('SELECT claimed_by FROM dev_slot_messages WHERE id = ? AND org_id = ? AND slot_id = ?').get(messageId, orgId, slotId);
    if (!row) return { ok: false, code: 'not_found' };
    return { ok: false, code: 'claimed', claimed_by: row.claimed_by };
  }

  return { appendMessage, listMessages, claimMessage, subscribe, _listenerCount: (k) => bus.listenerCount(k), _emit: (k) => bus.emit(k) };
}

/**
 * Attribute a slot message to its author SERVER-SIDE.
 *
 * Found by the acceptance owner driving the slot-inbox hook (2026-08-23):
 * `quox slot say` sends the literal "unnamed" whenever the caller has no
 * session name exported, so an unattributed post is indistinguishable from
 * a stranger's. Anything filtering "not my own posts" on that label then
 * leaks the caller's OWN messages back to it: for a resident supervisor
 * that is a self-loop, the precise failure the supervisor's picker was
 * built to make structurally impossible, reintroduced through the read
 * path.
 *
 * The durable fix is not "remember to pass --session" (that is the same
 * someone-has-to-remember failure again) but attributing from the
 * AUTHENTICATED identity, which the server always has. A resident resolves
 * to `resident:<host>`, matching supervisorEngine's buildSelfIdentity
 * exactly, so its own posts are recognisable whether or not it names
 * itself.
 *
 * An explicitly supplied name still wins for the DISPLAY LABEL: a session
 * naming itself is meaningful, and slots are deliberately addressable by
 * session name. This function stays as the from_label fallback chain; it is
 * NOT the unforgeable field — see deriveCallerIdentity for that (migrations/
 * aee/022, DEVSUITE-SLOTS unforgeable authorship).
 */
function deriveSlotAuthor(req, from) {
  const supplied = typeof from === 'string' ? from.trim() : '';
  if (supplied && supplied !== 'unnamed') return supplied;
  return deriveCallerIdentity(req);
}

/**
 * Resolve the AUTHENTICATED caller's identity SERVER-SIDE — never from
 * anything in the request body. This is the value stored in
 * author_identity (migrations/aee/022) and is the trustworthy field for
 * "who actually posted": from_label stays caller-chosen free text and must
 * never be used for own-post filtering or impersonation checks again (the
 * incident this closes: a session's posts rendered as "QUOX-SECURITY", a
 * different session entirely, because its label was unchecked free text).
 *
 * A resident resolves to `resident:<host>` (matching supervisorEngine's
 * buildSelfIdentity exactly), a human to their email, a service caller to
 * 'service'. Deliberately ignores `from`/`req.body` entirely: a client can
 * say anything it likes about who it is in the body, and none of it can
 * ever reach this value.
 */
function deriveCallerIdentity(req) {
  const user = (req && req.user) || null;
  if (user && user.agent_id && user.resident_host) return `resident:${user.resident_host}`;
  if (user && user.agent_id) return `agent:${user.agent_id}`;
  if (user && user.email) return user.email;
  if (user && user.id) return `user:${user.id}`;
  if (req && req.service === true) return 'service';
  // Never fall back to "unnamed": an unattributable post is what caused the
  // leak. "unknown" is at least honest about being unresolved, and it can
  // never collide with a real session name the way "unnamed" did.
  return 'unknown';
}

// Two processes cannot both speak AS the slot's voice (DEVSUITE-SLOTS
// P1-TRUST slice 2, the "double-voice kill"). A resident's identity IS the
// slot's voice: checkoutSlot for a resident sets holder_session to exactly
// buildSelfIdentity(host) === `resident:<host>` (see supervisorEngine.js /
// devSlotsStore.test.js "exactly one winner" convention), so a second
// resident process racing to post as the same slot is told apart from the
// real holder by identity alone.
//
// This deliberately does NOT extend to human/session say (steer): many
// Claude sessions authenticate as the SAME account (see the author_identity
// migration header, 022-dev-slot-message-author-identity.sql), so a human
// identity (an email, `user:<id>`) cannot distinguish "am I the holder"
// the way a resident's host-bound identity can. Ordinary owner/human say
// stays open, same as before this slice.
const RESIDENT_IDENTITY_RE = /^resident:/;

function isResidentVoice(identity) {
  return typeof identity === 'string' && RESIDENT_IDENTITY_RE.test(identity);
}

/**
 * Authorize a `say` for a resident caller: the caller's own identity must
 * equal the slot's CURRENT holder_session, otherwise a resident that lost
 * its hold (or a second resident racing the same slot name) could still
 * post under the slot's name. Non-resident identities are always
 * authorized here — see the module comment above for why.
 *
 * @returns {{ok: true} | {ok: false, holderSession: string|null}}
 */
function checkSlotSayAuthor({ slot, identity, caller }) {
  // QUOXIDENTITY P10: on a SHARED slot (live members), an attach caller must be
  // the slot's voice (holder, member, or same-agent splinter) via the one
  // predicate. Slots without members keep today's behaviour exactly.
  if (caller && caller.memberKey && slot && Array.isArray(slot.members) && slot.members.length > 0
      && !isSlotVoice(slot, caller)) {
    return { ok: false, holderSession: (slot && slot.holder_session) || null };
  }
  if (!isResidentVoice(identity)) return { ok: true };
  const holderSession = (slot && slot.holder_session) || null;
  if (holderSession === identity) return { ok: true };
  // quox#584: a checkout with --session <name> records the session NAME as
  // holder_session while the resident authenticates as resident:<host>, so
  // the two could never match and say was permanently 403 for the life of
  // the hold. The hold is ALSO bound server-side to the authenticated
  // identity at checkout (holder_identity, migration 033); a resident whose
  // own identity took the hold speaks as its slot regardless of the display
  // name. A DIFFERENT resident still fails: the double-voice kill holds.
  const holderIdentity = (slot && slot.holder_identity) || null;
  if (holderIdentity && holderIdentity === identity) return { ok: true };
  return { ok: false, holderSession };
}

module.exports = {
  createDevSlotMessagesStore, deriveSlotAuthor, deriveCallerIdentity, validateSlotLabel,
  checkSlotSayAuthor, parseAddressedTo,
};
