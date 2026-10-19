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

// A slot message cursor is '<created_at>|<seq>' (exact: after that message), '|<seq>' (after that row), or a plain
// ISO time (old clients: after that time). A timestamp alone loses a second message in the same millisecond.
function parseCursor(since) {
  if (since == null || since === '') return null;
  const m = /^(.*)\|(\d+)$/.exec(String(since));
  if (m) return { ts: m[1] || null, seq: Number(m[2]) };
  return { ts: String(since), seq: null };
}
// Is this message after the cursor? Mirrors listMessages' since filter. A plain ISO cursor counts a message AT
// that time as after it only when `inclusive` (a live stream advancing past a message it just delivered).
function isAfterCursor(rec, cursor, { inclusive = false } = {}) {
  const c = parseCursor(cursor);
  if (!c) return true;
  if (!rec || !rec.created_at) return false;
  if (c.seq != null && !c.ts) return rec.seq != null && rec.seq > c.seq;
  if (rec.created_at !== c.ts) return rec.created_at > c.ts;
  if (c.seq != null) return rec.seq != null && rec.seq > c.seq;
  return inclusive;
}
function cursorOf(rec) {
  if (!rec) return null;
  return rec.seq == null ? rec.created_at : `${rec.created_at}|${rec.seq}`;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    slot_id: row.slot_id,
    slot_name: row.slot_name,
    from: row.from_label || null,
    // SLOTS-REPLY (migration 046): the sender's verified slot, the reply address.
    from_slot: row.from_slot || null,
    // Server-derived, unforgeable identity (migrations/aee/022). from_label
    // stays the caller-chosen display name; this is the trustworthy field
    // for "who actually posted", see deriveCallerIdentity below.
    author_identity: row.author_identity || null,
    text: row.text,
    source: row.source,
    created_at: row.created_at,
    // The row position (rowid): with created_at it makes an exact cursor (see cursorOf / parseCursor).
    seq: row._seq == null ? null : row._seq,
    // QUOXIDENTITY P10: who claimed it (first claimer wins) and who it was for.
    claimed_by: row.claimed_by || null,
    claimed_at: row.claimed_at || null,
    addressed_to: row.addressed_to || null,
    // SLOT-RUN (migration 047): a command the sender asks the human to run. Data only, never executed here.
    run: row.run_command || null,
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
// QUOXON-MESH: parentheses allowed for "quox1 (Adam)" (slot plus the human's name); they
// carry no markup or line-break risk.
const LABEL_ALLOWED_RE = /^[A-Za-z0-9._@:\-() ]*$/;

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

// SLOT-RUN: the optional `run` field of a say. One command, one line, shown to the human in full before
// they choose to run it, so anything that can make the screen differ from what runs is refused: line
// breaks (a second command), C0/DEL control characters (ESC sequences can hide text, CR can overwrite it)
// and Unicode bidi/zero-width/line-separator characters (they reorder or hide what is displayed).
const RUN_MAX_LEN = 2000;
const RUN_BAD_RE = /[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

/** -> { ok: true, value: string|null } | { ok: false, error }. Never trims or rewrites: stored verbatim. */
function validateRunCommand(run) {
  if (run === undefined || run === null || run === '') return { ok: true, value: null };
  if (typeof run !== 'string') return { ok: false, error: 'run must be a string (one shell command)' };
  if (!run.trim()) return { ok: false, error: 'run is empty' };
  if (run.length > RUN_MAX_LEN) return { ok: false, error: `run too long (max ${RUN_MAX_LEN} characters)` };
  if (RUN_BAD_RE.test(run)) return { ok: false, error: 'run must be one command on one line, without control, bidi or zero-width characters' };
  return { ok: true, value: run };
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
  // Presence: who is listening right now (open SSE stream or in-progress wait). `session` is the
  // listener's own name when it gave one, so a sender's own window is not counted as the recipient.
  const live = new Map();
  function subscribe({ orgId, slotId, session = null } = {}, cb) {
    const key = `${orgId}:${slotId}`;
    bus.on(key, cb);
    const tok = { session: session || null };
    if (!live.has(key)) live.set(key, new Set());
    live.get(key).add(tok);
    return () => {
      bus.off(key, cb);
      const set = live.get(key);
      if (set) { set.delete(tok); if (!set.size) live.delete(key); }
    };
  }
  /** Open listeners on a slot, optionally ignoring the sender's own session. */
  function listeners({ orgId, slotId, excludeSession = null } = {}) {
    const set = live.get(`${orgId}:${slotId}`);
    if (!set) return 0;
    let n = 0;
    for (const t of set) if (!excludeSession || t.session !== excludeSession) n += 1;
    return n;
  }

  function appendMessage({ orgId, slotId, slotName, from, authorIdentity, text, source, fromSlot, run = null } = {}) {
    if (!orgId || !slotId || !slotName || !text) {
      throw new Error('appendMessage: orgId, slotId, slotName and text are required');
    }
    const t = now();
    const id = newMessageId();
    db().prepare(`
      INSERT INTO dev_slot_messages (id, org_id, slot_id, slot_name, from_label, author_identity, text, source, created_at, addressed_to, from_slot, run_command)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, slotId, slotName, from || null, authorIdentity || null, text, source || 'say', t, parseAddressedTo(text), fromSlot || null, run || null);
    const rec = rowToRecord(db().prepare('SELECT *, rowid AS _seq FROM dev_slot_messages WHERE id = ?').get(id));
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
    const c = parseCursor(since);
    if (c && c.seq != null && c.ts) {
      where += ' AND (created_at > ? OR (created_at = ? AND rowid > ?))';
      params.push(c.ts, c.ts, c.seq);
    } else if (c && c.seq != null) {
      where += ' AND rowid > ?';
      params.push(c.seq);
    } else if (c && c.ts) {
      where += ' AND created_at > ?';
      params.push(c.ts);
    }
    // rowid tiebreak (audit 2026-08-17): created_at is ISO ms-resolution, so a
    // say + a steer landing in the same millisecond had SQLite-undefined
    // relative order that could flip between reads. rowid is the stable
    // insertion order within a tie.
    const rows = db().prepare(`
      SELECT *, rowid AS _seq FROM dev_slot_messages WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?
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

  return { appendMessage, listMessages, claimMessage, subscribe, listeners, _listenerCount: (k) => bus.listenerCount(k), _emit: (k, rec) => bus.emit(k, rec) };
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

// quox#1306: the collector's own slot_say posts under the service key, so an agent turn's post (a workflow or
// scheduled run holds no slot) was stored as plain 'service' and the record could not say WHICH agent posted.
// A SERVICE caller (the collector itself, the trust root; it already chooses the display label) may name the
// acting agent, taken from the turn's verified agent id. It is stored as service:agent:<id>, never agent:<id>,
// so it reads as collector-asserted and cannot pass as an attached agent principal. A user or agent caller
// cannot claim one: its own authenticated identity stands. Returns null for a malformed acting agent (refuse).
const ACTING_AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function deriveSayIdentity(req, body) {
  const identity = deriveCallerIdentity(req);
  const acting = body && Object.prototype.hasOwnProperty.call(body, 'acting_agent') ? body.acting_agent : undefined;
  if (identity !== 'service' || acting === undefined) return identity;
  return typeof acting === 'string' && ACTING_AGENT_RE.test(acting) ? `service:agent:${acting}` : null;
}

// HYPERION #20 follow-up: WHO an agent post was made for, the verified turn user or the system actor of a
// scheduled/workflow run, so the say envelope carries run -> agent -> post -> human. Same trust rule as the
// acting agent: only a service caller that names one may assert it, in the X-On-Behalf-Of header (the body is
// never read for it). undefined = none given; null = refuse.
const ON_BEHALF_OF_RE = /^(?:system:[a-z0-9][a-z0-9:_-]{0,95}|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
function deriveOnBehalfOf(req, body) {
  const h = req && req.headers ? req.headers['x-on-behalf-of'] : undefined;
  if (h === undefined || deriveCallerIdentity(req) !== 'service' || !(body && body.acting_agent !== undefined)) return undefined;
  return typeof h === 'string' && ON_BEHALF_OF_RE.test(h) ? h : null;
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

/**
 * SLOTS-REPLY: verify a caller-supplied from_slot (the sender's reply address).
 * Kept only when that slot exists in the caller's org, is held (or stale, not yet
 * reclaimed), and its hold is bound to the SAME authenticated identity
 * (holder_identity, the same_user rule checkout uses). Anything else is dropped,
 * never an error: the say itself still lands, it just carries no reply address.
 * `getSlot(name)` must already be org-scoped.
 *
 * @returns {{ value: string|null, dropped: string|null }}
 */
const FROM_SLOT_RE = /^[a-z0-9-]{1,32}$/;
function checkFromSlot({ fromSlot, identity, getSlot } = {}) {
  if (fromSlot === undefined || fromSlot === null || fromSlot === '') return { value: null, dropped: null };
  const name = String(fromSlot);
  if (!FROM_SLOT_RE.test(name)) return { value: null, dropped: 'bad_name' };
  let slot = null;
  try { slot = typeof getSlot === 'function' ? getSlot(name) : null; } catch { slot = null; }
  if (!slot) return { value: null, dropped: 'unknown_slot' };
  const held = slot.state === 'held' || slot.state === 'stale';
  if (!held || !identity || !slot.holder_identity || slot.holder_identity !== identity) {
    return { value: null, dropped: 'not_held_by_you' };
  }
  return { value: slot.name, dropped: null };
}

/**
 * SLOTS-REPLY2: a say with no (or an unaccepted) from_slot still gets stamped when the caller names the
 * session it checked a slot out as (`holder_session`) and exactly ONE held/stale slot in the org is bound to
 * BOTH that session name and the caller's authenticated identity. The slot comes from the server's hold
 * record, never from the client, so a caller cannot forge another holder's address; an ambiguous or missing
 * match stamps nothing. `listSlots()` must already be org-scoped.
 *
 * @returns {{ value: string|null, dropped: string|null }}
 */
function resolveFromSlot({ fromSlot, holderSession, identity, getSlot, listSlots } = {}) {
  const direct = checkFromSlot({ fromSlot, identity, getSlot });
  if (direct.value) return direct;
  const hs = typeof holderSession === 'string' ? holderSession.trim() : '';
  if (!hs || !identity || typeof listSlots !== 'function') return direct;
  let rows = [];
  try { rows = listSlots() || []; } catch { rows = []; }
  const hit = rows.filter((r) => r && (r.state === 'held' || r.state === 'stale')
    && r.holder_identity === identity && r.holder_session === hs);
  if (hit.length === 1 && FROM_SLOT_RE.test(hit[0].name)) return { value: hit[0].name, dropped: null };
  return direct;
}

module.exports = {
  resolveFromSlot,
  createDevSlotMessagesStore, deriveSlotAuthor, deriveCallerIdentity, deriveSayIdentity, deriveOnBehalfOf, validateSlotLabel,
  checkSlotSayAuthor, parseAddressedTo, checkFromSlot, validateRunCommand, RUN_MAX_LEN,
  parseCursor, cursorOf, isAfterCursor,
};
