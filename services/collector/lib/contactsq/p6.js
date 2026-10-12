'use strict';

/**
 * ContactsQ P6 service operations (new logic lives here; api.js only wires it):
 *   tombstoneLift   POST /suppressions/tombstones/lift
 *   strictNamesApply POST /admin/strict-names/apply
 *   reindex         POST /admin/reindex
 *   callerProjection  resolve projection 'caller' (pre-PIN awareness, no identifiers)
 *   revealCard / revealCards  strict_names: real name for HUMAN callers only
 * Evidence carries codes, ids and counts only.
 */

const store = require('./store.js');
const cx = require('./crypto.js');
const policy = require('./policy.js');
const strictNames = require('./strictNames.js');
const reindexer = require('./reindex.js');
const { normalizeIdentifier, NormalizeError } = require('./normalize.js');
const { toGreeting } = require('./projections.js');

const CODE_RE = /^[a-z0-9_.:-]{1,48}$/;
const CALLER_CHANNELS = ['voice', 'email', 'sms'];

/**
 * The person's organisation line for the address book: the primary organisation contact's name and, when a
 * works_at edge records one, the person's role there. HUMAN callers only (an organisation name can be strict-names
 * encrypted, and the role lives in encrypted edge attributes). Organisations carry no line.
 */
function orgLine(ctx, row) {
  if (!ctx || ctx.actor !== 'human' || !row || row.kind === 'organisation' || !row.primary_org_contact_id) return null;
  const org = store.getContactRow(ctx.orgId, row.primary_org_contact_id);
  if (!org || org.status === 'erased' || org.status === 'merged') return null;
  const name = strictNames.revealName(ctx.orgId, org, store.dekFor(org));
  let role = null;
  const edge = store.edgesFor(ctx.orgId, row.id).find((e) => e.type === 'works_at' && e.from_id === row.id && e.to_id === org.id);
  if (edge) { const a = store.edgeAttrs(ctx.orgId, edge); role = (a && a.role) || null; }
  return name ? { id: org.id, name, role } : null;
}

/** strict_names: swap the placeholder for the real name on a card/record, HUMAN callers only. Also attaches the org line. */
function revealCard(ctx, card, row) {
  if (!card || !row || !ctx || ctx.actor !== 'human') return card;
  let out = card;
  if (row.display_name_ct) {
    const dek = store.dekFor(row);
    const nm = row.kind === 'organisation' ? null : strictNames.readName(ctx.orgId, row, dek);
    out = { ...card, display_name: strictNames.revealName(ctx.orgId, row, dek), name: nm ? nm.parts : null, display_name_override: nm ? nm.override : null };
  }
  const org = orgLine(ctx, row);
  return org ? { ...out, org } : out;
}
function revealCards(ctx, cards) {
  if (!ctx || ctx.actor !== 'human') return cards;
  return cards.map((c) => (c && c.id ? revealCard(ctx, c, store.getContactRow(ctx.orgId, c.id)) : c));
}

/**
 * The 'caller' projection: just enough for a voice agent to greet an unverified caller with some
 * context. Spoofing guard: caller-ID can be forged, so it NEVER carries notes, facts, touchpoint
 * summaries, identifiers (masked or not), flags or the contact's raw name. known_since is a date only.
 */
function callerProjection(ctx, row, subject) {
  const g = toGreeting(ctx.orgId, row);
  const have = new Set(store.identifiersFor(ctx.orgId, row.id).map((i) => i.channel));
  let preferred = null;
  for (const channel of CALLER_CHANNELS) {
    if (!have.has(policy.IDENT_CHANNEL[channel])) continue;
    const r = policy.evaluate(ctx.orgId, row, { purpose: 'service', channel, subject });
    if (r.decision === 'allow') { preferred = channel; break; }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    greeting_name: g.greeting_name,
    preferred_name: g.preferred_name,
    pronunciation: g.pronunciation,
    language: g.language,
    tz: g.tz,
    ai_disclosure_required: g.ai_disclosure_required,
    relationship_primary: row.relationship_primary || null,
    lifecycle_stage: row.lifecycle_stage || null,
    known_since: String(row.created_at || '').slice(0, 10) || null,
    preferred_channel: preferred,
    verified: false,
  };
}

function createP6({ emit, wrap, err, needAdmin }) {
  /** Human org admin lifts an erasure tombstone so a returning person can be re-added. */
  const tombstoneLift = wrap((ctx, b) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    if (typeof b.reason_code !== 'string' || !CODE_RE.test(b.reason_code)) return err(400, 'invalid_reason_code');
    let norm;
    try {
      norm = normalizeIdentifier(b.channel, b.value, { region: store.getSettings(ctx.orgId).default_region });
    } catch (e) {
      if (e instanceof NormalizeError) return err(400, e.code);
      throw e;
    }
    const db = store.getDb();
    const bis = cx.blindIndexes(ctx.orgId, norm.channel, norm.normalised);
    const canons = cx.blindIndexes(ctx.orgId, norm.channel, norm.canonical);
    const l = (a) => a.map(() => '?').join(',');
    const removed = db.transaction(() => {
      const n = db.prepare(
        `DELETE FROM contact_suppressions WHERE org_id = ? AND channel = ? AND reason = 'erasure_tombstone'
           AND (blind_index IN (${l(bis)}) OR blind_index_canonical IN (${l(canons)}))`
      ).run(ctx.orgId, norm.channel, ...bis, ...canons).changes;
      if (n) {
        db.prepare('INSERT INTO contact_tombstone_lifts (id, org_id, channel, bi_ref, reason_code, lifted_by, removed, lifted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(store.gid('tl'), ctx.orgId, norm.channel, cx.biRef(bis[0]), b.reason_code, `user:${ctx.userId || 'unknown'}`, n, store.nowIso());
      }
      return n;
    })();
    if (!removed) return err(404, 'tombstone_not_found');
    emit('quox.contacts.tombstone_lifted', ctx, { channel: norm.channel, reason: b.reason_code, bi_ref: cx.biRef(bis[0]), count: removed, outcome: 'lifted' });
    return { status: 200, json: { lifted: { channel: norm.channel, removed } } };
  });

  /** Migrate every contact in the org to the CURRENT strict_names setting (both directions). */
  const strictNamesApply = wrap((ctx) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    const { failed_ids: failedIds, strict_names: strict, ...counts } = strictNames.applyForOrg(ctx.orgId);
    emit('quox.contacts.strict_names_applied', ctx, { reason: strict ? 'strict_on' : 'strict_off', counts, outcome: counts.failed ? 'partial' : 'applied' });
    return { status: 200, json: { strict_names: strict, counts, failed_ids: failedIds } };
  });

  /** Re-HMAC every blind index under the current master (master-key rotation, step 2 after rewrap). */
  const reindex = wrap((ctx) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    const r = reindexer.reindexOrg(ctx.orgId);
    emit('quox.contacts.reindex', ctx, { counts: r.counts, outcome: r.complete ? 'complete' : 'partial' });
    return { status: 200, json: r };
  });

  return { tombstoneLift, strictNamesApply, reindex };
}

module.exports = { createP6, callerProjection, revealCard, revealCards };
