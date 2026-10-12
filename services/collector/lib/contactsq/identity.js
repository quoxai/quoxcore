'use strict';

/**
 * ContactsQ in-process identity helper (P3b): InboxQ sender identity and
 * CalendarQ attendee cards.
 *
 * READ-ONLY resolve plus an idempotent touchpoint write. Every export is
 * FAIL-SOFT: a ContactsQ error (or ContactsQ absent) yields the "unknown"
 * answer / a no-op, never a throw into InboxQ or CalendarQ. No audit envelope
 * is emitted for a resolve (it runs on read paths and sync loops); the
 * touchpoint write goes through the ONE ContactsQ service so it is witnessed
 * there (envelope carries ids and codes only, never an address).
 *
 * NO auto-candidate creation here (open owner decision): an unknown email or
 * attendee stays unknown. Candidates and non-active contacts never resolve.
 *
 * Cache: per-process LRU keyed `<org>:<channel>:<blind index>` (the HMAC, never
 * the raw address). Hits live 5 minutes; misses 30 seconds so a freshly added
 * contact shows up quickly. The contactsq service calls invalidate() on every
 * mutation that can change an answer (create / identifier / update / archive /
 * erase), so erasure is not masked by the cache.
 */

const nodeCrypto = require('node:crypto');
const cx = require('./crypto.js');
const store = require('./store.js');
const { normalizeIdentifier } = require('./normalize.js');

const HIT_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 5000;
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const _cache = new Map(); // key -> { exp, card|null }  (Map order = LRU order)
let _svc = null;
let _now = () => Date.now();

function setService(svc) { _svc = svc && typeof svc === 'object' ? svc : null; }
function _setClock(fn) { _now = typeof fn === 'function' ? fn : () => Date.now(); }
function invalidate() { _cache.clear(); }
function _cacheSize() { return _cache.size; }
function _cacheKeys() { return [..._cache.keys()]; }

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (e.exp <= _now()) { _cache.delete(key); return undefined; }
  _cache.delete(key); _cache.set(key, e); // refresh recency
  return e.card;
}
function cacheSet(key, card) {
  _cache.delete(key);
  _cache.set(key, { exp: _now() + (card ? HIT_TTL_MS : MISS_TTL_MS), card });
  while (_cache.size > MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
}

function subset(row) {
  let flags = [];
  try { const f = JSON.parse(row.flags_json || '[]'); if (Array.isArray(f)) flags = f; } catch { /* leave empty */ }
  return {
    id: row.id,
    display_name: row.display_name,
    relationship_primary: row.relationship_primary || null,
    flags,
  };
}

function resolveOne(orgId, channel, value) {
  let norm;
  try { norm = normalizeIdentifier(channel, value); } catch { return null; }
  const bi = cx.blindIndex(orgId, norm.channel, norm.channel === 'email' ? norm.canonical : norm.normalised);
  const key = `${orgId}:${norm.channel}:${bi}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const { contact } = store.findContactByIdentifier(orgId, norm);
  const card = contact && contact.status === 'active' ? subset(contact) : null;
  cacheSet(key, card);
  return card;
}

/**
 * resolveCards(orgId, [{channel:'email', value}, ...]) -> Map(value -> Card|null)
 * Card is the safe subset {id, display_name, relationship_primary, flags}.
 * Never throws: any failure maps that value (or all values) to null.
 */
function resolveCards(orgId, items) {
  const out = new Map();
  if (!orgId || !Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it.value !== 'string') continue;
    if (out.has(it.value)) continue;
    let card = null;
    try { card = resolveOne(orgId, it.channel || 'email', it.value); } catch { card = null; }
    out.set(it.value, card);
  }
  return out;
}

function emailsOf(list) {
  const seen = new Set();
  const items = [];
  for (const v of list) {
    if (typeof v === 'string' && v && !seen.has(v)) { seen.add(v); items.push({ channel: 'email', value: v }); }
  }
  return items;
}

/**
 * InboxQ: return NEW message objects with sender_contact added where the sender
 * resolves; objects that do not resolve are returned untouched (same reference).
 * `agent: true` also adds sender_ref ('contact:<id>'). On any failure the input
 * array is returned unchanged.
 */
function enrichMessages(orgId, messages, { agent = false } = {}) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const cards = resolveCards(orgId, emailsOf(messages.map((m) => m && m.fromAddr)));
    return messages.map((m) => {
      const card = m && cards.get(m.fromAddr);
      if (!card) return m;
      return { ...m, sender_contact: card, ...(agent ? { sender_ref: `contact:${card.id}` } : {}) };
    });
  } catch { return messages; }
}

function enrichMessage(orgId, message, opts) {
  try {
    if (!message || typeof message !== 'object') return message;
    return enrichMessages(orgId, [message], opts)[0];
  } catch { return message; }
}

/**
 * CalendarQ: add attendee_contacts [{email_ref:'contact:<id>', display_name}] to
 * occurrences whose attendees resolve. Unknown attendees are untouched; an
 * occurrence with nothing resolved is returned as the same reference.
 */
function enrichOccurrences(orgId, occurrences) {
  try {
    if (!Array.isArray(occurrences) || occurrences.length === 0) return occurrences;
    const all = [];
    for (const o of occurrences) {
      if (o && Array.isArray(o.attendees)) for (const a of o.attendees) all.push(a && a.email);
    }
    if (all.length === 0) return occurrences;
    const cards = resolveCards(orgId, emailsOf(all));
    return occurrences.map((o) => {
      if (!o || !Array.isArray(o.attendees)) return o;
      const seen = new Set();
      const contacts = [];
      for (const a of o.attendees) {
        const card = a && cards.get(a.email);
        if (card && !seen.has(card.id)) { seen.add(card.id); contacts.push({ email_ref: `contact:${card.id}`, display_name: card.display_name }); }
      }
      return contacts.length ? { ...o, attendee_contacts: contacts } : o;
    });
  } catch { return occurrences; }
}

function enrichOccurrence(orgId, occurrence) {
  try {
    if (!occurrence || typeof occurrence !== 'object') return occurrence;
    return enrichOccurrences(orgId, [occurrence])[0];
  } catch { return occurrence; }
}

function safeRef(ref) {
  const r = String(ref || '');
  if (REF_RE.test(r)) return r;
  return `h:${nodeCrypto.createHash('sha256').update(r).digest('hex').slice(0, 32)}`;
}

/**
 * Idempotent touchpoint write via the ContactsQ service, surface 'inboxq'.
 * Returns true when a new touchpoint was written. NEVER throws. The duplicate
 * check and the service call run in one synchronous stretch (no await between),
 * so concurrent callers cannot interleave.
 */
function recordEmailTouchpoint(orgId, { email, direction, ref, outcome, occurredAt } = {}) {
  try {
    if (!_svc || !orgId || !email || !ref) return false;
    const card = resolveOne(orgId, 'email', email);
    if (!card) return false;
    const r = safeRef(ref);
    if (store.findTouchpointByRef(orgId, card.id, 'inboxq', r, outcome)) return false;
    let occurred;
    const t = occurredAt ? Date.parse(occurredAt) : NaN;
    if (Number.isFinite(t) && t <= _now()) occurred = new Date(t).toISOString();
    const p = _svc.logTouchpoint(
      { orgId, userId: null, isAdmin: false, actor: 'service', agentId: null },
      { contact_id: card.id, surface: 'inboxq', direction, outcome, ref: r, ...(occurred ? { occurred_at: occurred } : {}) },
    );
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  } catch { return false; }
}

/** Inbound: a newly ingested message. ref = the stored message id. */
function recordInbound(orgId, { fromAddr, messageId, dateTs } = {}) {
  return recordEmailTouchpoint(orgId, {
    email: fromAddr, direction: 'inbound', ref: messageId, outcome: 'email_received',
    occurredAt: typeof dateTs === 'number' ? new Date(dateTs).toISOString() : dateTs,
  });
}

/** Outbound: accepted recipients of an email_send. ref = send correlation id. */
function recordSent(orgId, recipients, ref) {
  let n = 0;
  try {
    for (const e of Array.isArray(recipients) ? recipients : []) {
      const addr = typeof e === 'string' ? (e.match(/<([^>]+)>/)?.[1] || e) : e && e.address;
      if (recordEmailTouchpoint(orgId, { email: addr, direction: 'outbound', ref, outcome: 'email_sent' })) n += 1;
    }
  } catch { /* fail-soft */ }
  return n;
}

module.exports = {
  setService, invalidate, resolveCards,
  enrichMessages, enrichMessage, enrichOccurrences, enrichOccurrence,
  recordEmailTouchpoint, recordInbound, recordSent,
  HIT_TTL_MS, MISS_TTL_MS, _setClock, _cacheSize, _cacheKeys,
};
