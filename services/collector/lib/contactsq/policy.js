'use strict';

/**
 * ContactsQ reachability policy (P2). Pack 'uk-pecr-gdpr'.
 *
 * decide(...) is a PURE function: no I/O, no clock (`now` is an argument), no
 * PII in or out. Reasons are stable code strings. All reasons are collected;
 * deny beats approval_required beats allow. Informational reasons
 * (assumed_legitimate_interest, ai_disclosure_required) are reported only on
 * an 'allow' decision.
 *
 * evaluate()/record() below are the store-backed wrapper every enforcement
 * point uses (lease mint, lease redeem, the approval-gate predicate,
 * contacts_best_channel, the advisory endpoint). There is no second path.
 */

const store = require('./store.js');

const PACK = 'uk-pecr-gdpr';
const FLAGS = ['do_not_call', 'do_not_market', 'do_not_email', 'do_not_sms', 'human_only', 'ai_disclosure_required',
  'vip', 'legal_hold', 'minor', 'deceased', 'complainant', 'source_removed'];
const RELATIONSHIPS = ['customer', 'prospect', 'lead', 'supplier', 'partner', 'employee', 'contractor', 'investor',
  'press', 'advisor', 'personal', 'unknown'];
const CONSENT_PURPOSES = ['service', 'transactional', 'marketing', 'research', 'ai_interaction'];
const CONSENT_CHANNELS = ['voice', 'sms', 'email', 'post', 'social', 'messaging', 'any'];
const CONSENT_STATUSES = ['granted', 'withdrawn', 'objected', 'soft_opt_in', 'unknown'];
const LAWFUL_BASES = ['consent', 'contract', 'legitimate_interest', 'legal_obligation', 'vital_interest', 'public_task'];

/** Which identifier channel a reach channel needs. */
const IDENT_CHANNEL = { voice: 'phone', sms: 'phone', email: 'email', post: 'address', social: 'social', messaging: 'social' };

const DENY_REASONS = new Set(['erased', 'deceased', 'no_identifier', 'identifier_bounced', 'dnc', 'do_not_market', 'do_not_call',
  'do_not_sms', 'do_not_email', 'human_only', 'consent_withdrawn', 'objected', 'no_marketing_consent', 'org_do_not_market']);
const APPROVAL_REASONS = new Set(['minor', 'complainant', 'tps_not_screened', 'no_lawful_basis_recorded', 'quiet_hours']);
const INFO_REASONS = new Set(['assumed_legitimate_interest', 'ai_disclosure_required']);
const ALL_REASONS = [...DENY_REASONS, ...APPROVAL_REASONS, ...INFO_REASONS];
/** Denials that come purely from the suppression list / identifier state (kept as the P1 `suppressed` error). */
const SUPPRESSION_CLASS = new Set(['dnc', 'do_not_market', 'identifier_bounced']);

const REDUCING = new Set(['withdrawn', 'objected']);

// --- time ------------------------------------------------------------------

function parseHm(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

function localMinutes(nowMs, tz) {
  const fmt = (zone) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  };
  try { return fmt(tz || 'UTC'); } catch { return fmt('UTC'); }
}

/** start === end means "no quiet hours". A window may cross midnight. */
function inQuietHours(window, nowMs, tz) {
  if (!window) return false;
  const s = parseHm(window.start);
  const e = parseHm(window.end);
  if (s === null || e === null || s === e) return false;
  const t = localMinutes(nowMs, tz);
  return s < e ? (t >= s && t < e) : (t >= s || t < e);
}

// --- consent state -----------------------------------------------------------

const keyOf = (purpose, channel) => `${purpose}|${channel}`;
const ts = (v) => (v ? String(v) : '');

/** Latest row per (purpose, channel); `consents` are in insertion order, so a tie goes to the later row. */
function currentConsentState(consents) {
  const latest = new Map();
  for (const c of consents || []) {
    const k = keyOf(c.purpose, c.channel);
    const prev = latest.get(k);
    if (!prev || ts(c.captured_at) >= ts(prev.captured_at)) latest.set(k, c);
  }
  return latest;
}

function isExpired(row, nowMs) {
  return Boolean(row && row.expires_at && !REDUCING.has(row.status) && Date.parse(row.expires_at) <= nowMs);
}

/**
 * Effective consent for (purpose, channel): a specific-channel row beats 'any',
 * EXCEPT a newer 'any' withdrawal/objection, which always wins (an objection must
 * never be masked by an older channel-specific grant). Expired grant = unknown.
 */
function effectiveConsent(consents, purpose, channel, nowMs) {
  const state = currentConsentState(consents);
  const spec = state.get(keyOf(purpose, channel));
  const any = channel === 'any' ? null : state.get(keyOf(purpose, 'any'));
  let row = spec || any || null;
  if (spec && any && REDUCING.has(any.status) && ts(any.captured_at) > ts(spec.captured_at)) row = any;
  if (!row) return { status: 'none', row: null };
  return { status: isExpired(row, nowMs) ? 'unknown' : row.status, row };
}

// --- the engine ---------------------------------------------------------------

/**
 * decide({contact, identifiers, consents, suppressions, purpose, channel, subject, now, orgQuietHours, pack})
 *  contact:      {status, flags:[...], quiet_hours:{start,end,tz}|null, tz?}
 *  identifiers:  [{channel:'phone'|'email'|..., verification}]  (the candidates for this reach)
 *  consents:     contact_consents rows, oldest first
 *  suppressions: raw suppression reasons ('dnc'|'bounced'|'do_not_market') that apply to the identifier
 *  subject:      {type:'agent'|'user'}
 *  orgContext:   {do_not_market:boolean}  an employing ORGANISATION's marketing refusal (works_at edge), inherited
 *                by the person for purpose marketing only. introduced_by and a person's own flags never cascade.
 *  now:          ms or Date
 *  orgQuietHours: {start,end,tz} org default
 * -> {decision:'allow'|'deny'|'approval_required', reasons:[codes], pack}
 */
function decide(input) {
  const { contact = {}, identifiers = [], consents = [], suppressions = [], purpose, channel, subject = { type: 'user' }, orgQuietHours = null, orgContext = null } = input;
  const nowMs = input.now instanceof Date ? input.now.getTime() : (typeof input.now === 'number' ? input.now : Date.now());
  const pack = input.pack || PACK;
  const flags = new Set(Array.isArray(contact.flags) ? contact.flags : []);
  const reasons = [];
  const add = (c) => { if (!reasons.includes(c)) reasons.push(c); };
  const isAgent = subject && subject.type === 'agent';
  const isMessaging = channel === 'voice' || channel === 'sms';

  if (contact.status === 'erased') add('erased');
  if (flags.has('deceased')) add('deceased');

  // identifiers
  const need = IDENT_CHANNEL[channel];
  const forChannel = (identifiers || []).filter((i) => i && i.channel === need);
  if (!forChannel.length) add('no_identifier');
  else if (forChannel.every((i) => i.verification === 'bounced' || i.verification === 'dead')) add('identifier_bounced');

  // suppression list
  const sup = new Set(suppressions || []);
  if (isMessaging && sup.has('dnc')) add('dnc');
  if (channel === 'email' && sup.has('bounced')) add('identifier_bounced');
  if (purpose === 'marketing' && sup.has('do_not_market')) add('do_not_market');

  // contact flags
  if (flags.has('do_not_call') && channel === 'voice') add('do_not_call');
  if (flags.has('do_not_sms') && channel === 'sms') add('do_not_sms');
  if (flags.has('do_not_email') && channel === 'email') add('do_not_email');
  if (flags.has('do_not_market') && purpose === 'marketing') add('do_not_market');
  if (purpose === 'marketing' && orgContext && orgContext.do_not_market) add('org_do_not_market');
  if (flags.has('human_only') && isAgent) add('human_only');
  if (flags.has('minor')) add('minor');
  if (flags.has('complainant')) add('complainant');

  // consent
  const eff = effectiveConsent(consents, purpose, channel, nowMs);
  if (eff.status === 'withdrawn') add('consent_withdrawn');
  if (eff.status === 'objected') add('objected');
  const consented = eff.status === 'granted' || eff.status === 'soft_opt_in';

  if (purpose === 'marketing') {
    if (!consented) add('no_marketing_consent');
    else if (channel === 'voice' && eff.status !== 'granted') add('tps_not_screened');
  } else if (purpose === 'research') {
    if (eff.status === 'none' || eff.status === 'unknown') add('no_lawful_basis_recorded');
  } else if (purpose === 'service' || purpose === 'transactional') {
    if (eff.status === 'none' || eff.status === 'unknown') add('assumed_legitimate_interest');
  }

  // quiet hours: an AGENT reaching a person by voice/sms; a human may still choose to
  if (isAgent && isMessaging) {
    const qh = contact.quiet_hours || orgQuietHours;
    const tz = (contact.quiet_hours && contact.quiet_hours.tz) || contact.tz || (orgQuietHours && orgQuietHours.tz) || 'UTC';
    if (inQuietHours(qh, nowMs, tz)) add('quiet_hours');
  }

  if (flags.has('ai_disclosure_required')) add('ai_disclosure_required');

  const hasDeny = reasons.some((r) => DENY_REASONS.has(r));
  const hasApproval = reasons.some((r) => APPROVAL_REASONS.has(r));
  const decision = hasDeny ? 'deny' : hasApproval ? 'approval_required' : 'allow';
  const out = decision === 'allow' ? reasons : reasons.filter((r) => !INFO_REASONS.has(r));
  return { decision, reasons: out, pack };
}

/** Error code for a denial: the P1 `suppressed` when it is purely suppression/identifier state. */
function denialErrorCode(reasons) {
  return reasons.length && reasons.every((r) => SUPPRESSION_CLASS.has(r)) ? 'suppressed' : 'policy_denied';
}

// --- store-backed wrapper -----------------------------------------------------

function parseFlags(row) {
  const f = store.parseJson(row && row.flags_json, []);
  return Array.isArray(f) ? f.filter((x) => FLAGS.includes(x)) : [];
}

function pickIdentifier(orgId, contactId, reachChannel) {
  const want = IDENT_CHANNEL[reachChannel];
  const all = store.identifiersFor(orgId, contactId).filter((i) => i.channel === want);
  return all.find((i) => i.is_primary) || all[0] || null;
}

/** Raw suppression reasons for one identifier row, by its stored blind indexes (no value needed). */
function suppressionReasonsFor(orgId, ident) {
  if (!ident) return [];
  const rows = store.getDb().prepare(
    `SELECT DISTINCT reason FROM contact_suppressions WHERE org_id = ? AND channel = ?
       AND (blind_index = ? OR blind_index_canonical = ? OR blind_index_canonical = ?) AND (expires_at IS NULL OR expires_at > ?)`
  ).all(orgId, ident.channel, ident.blind_index, ident.blind_index_canonical, ident.blind_index, new Date().toISOString());
  return rows.map((r) => r.reason);
}

/**
 * Org inheritance (P3): true when an organisation this person works at (works_at edge, not ended)
 * carries the do_not_market flag, or any of the org's identifiers has a do_not_market suppression.
 * Only works_at edges FROM the person count: nothing cascades up from a person, and introduced_by
 * is provenance, never consent.
 */
function orgDoNotMarket(orgId, contactRow) {
  if (!contactRow || contactRow.kind === 'organisation') return false;
  for (const org of store.worksAtOrgs(orgId, contactRow.id)) {
    if (parseFlags(org).includes('do_not_market')) return true;
    for (const ident of store.identifiersFor(orgId, org.id)) {
      if (suppressionReasonsFor(orgId, ident).includes('do_not_market')) return true;
    }
  }
  return false;
}

/**
 * Evaluate policy for one contact/purpose/channel from stored state.
 * `identifier` (a contact_identifiers row) pins the leased identifier at redeem time.
 */
function evaluate(orgId, contactRow, { purpose, channel, subject, now, identifier } = {}) {
  const settings = store.getSettings(orgId);
  const chosen = identifier || pickIdentifier(orgId, contactRow.id, channel);
  const res = decide({
    contact: {
      status: contactRow.status, flags: parseFlags(contactRow), tz: contactRow.tz || null,
      quiet_hours: store.parseJson(contactRow.quiet_hours_json, null),
    },
    identifiers: chosen ? [{ channel: chosen.channel, verification: chosen.verification }] : [],
    consents: store.consentsFor(orgId, contactRow.id),
    suppressions: suppressionReasonsFor(orgId, chosen),
    purpose, channel, subject: subject || { type: 'user' },
    now: now === undefined ? Date.now() : now,
    orgQuietHours: settings.default_quiet_hours,
    orgContext: purpose === 'marketing' ? { do_not_market: orgDoNotMarket(orgId, contactRow) } : null,
  });
  return { ...res, identifier: chosen || null };
}

/** Persist a gating decision and witness it (codes only). */
function record(emit, ctx, contactId, { subjectId, purpose, channel, result }) {
  store.recordDecision(ctx.orgId, {
    contact_id: contactId, subject_id: subjectId || null, purpose, channel: channel || null,
    decision: result.decision, reasons: result.reasons, pack: result.pack,
  });
  if (typeof emit === 'function') {
    emit('quox.contacts.policy.decision', ctx, {
      contact_id: contactId, purpose, channel: channel || undefined, decision: result.decision, reasons: result.reasons, pack: result.pack,
    });
  }
}

module.exports = {
  PACK, FLAGS, RELATIONSHIPS, CONSENT_PURPOSES, CONSENT_CHANNELS, CONSENT_STATUSES, LAWFUL_BASES, IDENT_CHANNEL,
  DENY_REASONS, APPROVAL_REASONS, INFO_REASONS, ALL_REASONS, SUPPRESSION_CLASS,
  decide, denialErrorCode, effectiveConsent, currentConsentState, isExpired, inQuietHours, isValidTz, parseHm, parseFlags,
  pickIdentifier, suppressionReasonsFor, evaluate, record,
};
