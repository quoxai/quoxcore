'use strict';

/**
 * ContactsQ history (the log trail on the History tab): the org's own quox.contacts.* evidence events, newest
 * first, read back from the collector's AEE envelope store.
 *
 * Two pieces:
 *   createEnvelopeReader({ run, decryptRow })  adapts the AEE store (server.js hands it the prepared
 *       queryOrgScopedPrefix statement and decryptEnvelopeRow, so payloads encrypted at rest are opened by the
 *       collector's own helper, never by raw SQL on ciphertext).
 *   toEvent(orgId, envelope)  the safe public shape. The payload was built from the closed evidence allowlist when
 *       it was written; it is re-filtered here anyway, and only id-like and code-like values survive.
 *       Never a name, number, address, note or free text; bi_ref (a hash prefix) is dropped too.
 */

const { buildPayload } = require('./evidence.js');

const PREFIX = 'quox.contacts.';
const CODE_RE = /^[a-z0-9_.:-]{1,48}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
// Fields shown as top-level columns, or never shown at all.
const NOT_CODES = new Set(['orgId', 'contact_id', 'outcome', 'bi_ref']);

/** Half-open intent range for the prefix (idx_envelopes_org_intent serves it). */
function prefixRange(prefix = PREFIX) {
  return { lo: prefix, hi: prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) };
}

/**
 * run(params) -> envelope rows (newest first), params: the named parameters of queryOrgScopedPrefix.
 * Returns an async-free reader: ({ orgId, before, limit }) -> [{ ts, env }] (env null when it would not decrypt).
 */
function createEnvelopeReader({ run, decryptRow }) {
  if (typeof run !== 'function' || typeof decryptRow !== 'function') throw new Error('createEnvelopeReader requires run and decryptRow');
  return function readEnvelopes({ orgId, before, limit }) {
    const { lo, hi } = prefixRange();
    const rows = run({ intentLo: lo, intentHi: hi, type: null, from: null, to: null, after: null, before: before || null, corr: null, orgId, limit });
    return rows.map((r) => ({ ts: r.ts, env: decryptRow(r) }));
  };
}

const splitActor = (from) => {
  const s = String(from || '');
  const i = s.indexOf('.');
  const type = i > 0 ? s.slice(0, i) : s;
  return { type: ['human', 'agent', 'service'].includes(type) ? type : 'service', id: i > 0 ? s.slice(i + 1).slice(0, 128) : null };
};

/** Keep a value only if it is a code, an id, a number, a boolean, or a list/map of those. */
function codeOnly(v) {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') {
    // 'a,b' (a joined list of reason codes) is split; anything that is not code-shaped is dropped.
    const parts = v.split(',');
    if (parts.length > 1) { const ok = parts.filter((p) => CODE_RE.test(p)); return ok.length === parts.length ? ok : undefined; }
    return CODE_RE.test(v) || ID_RE.test(v) ? v : undefined;
  }
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && CODE_RE.test(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, n] of Object.entries(v)) if (CODE_RE.test(k) && typeof n === 'number' && Number.isFinite(n)) o[k] = n;
    return o;
  }
  return undefined;
}

/**
 * The public event for one envelope, or null when it is not this org's quox.contacts.* event.
 * The payload orgId must equal the caller's org: the SQL org filter is not the only gate.
 */
function toEvent(orgId, row) {
  const env = row && row.env;
  if (!env || typeof env.intent !== 'string' || !env.intent.startsWith(PREFIX)) return null;
  const payload = env.payload && typeof env.payload === 'object' ? env.payload : {};
  if (payload.orgId !== orgId) return null;
  const safe = buildPayload(orgId, payload);
  const codes = {};
  for (const [k, v] of Object.entries(safe)) {
    if (NOT_CODES.has(k)) continue;
    const c = codeOnly(v);
    if (c !== undefined) codes[k] = c;
  }
  const contactId = typeof safe.contact_id === 'string' && ID_RE.test(safe.contact_id) ? safe.contact_id : null;
  const outcome = typeof safe.outcome === 'string' && CODE_RE.test(safe.outcome) ? safe.outcome : null;
  return { id: env.id || null, ts: env.ts || row.ts, intent: env.intent, actor: splitActor(env.from), contact_id: contactId, outcome, codes };
}

module.exports = { PREFIX, prefixRange, createEnvelopeReader, toEvent };
