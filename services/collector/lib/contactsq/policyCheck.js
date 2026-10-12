'use strict';

/**
 * ContactsQ identifier policy check (boundary for RAW-NUMBER outbound).
 *
 * POST /api/v1/contactsq/policy/check-identifier   SERVICE callers only.
 * body {org_id, channel:'voice'|'sms'|'email', value, purpose, subject_type:'agent'|'user', subject_id?}
 *
 * Callers that hold a raw number (quox-voice telephony.place_outbound, twilio_sms.send_guarded)
 * must ask THIS endpoint instead of keeping their own do-not-contact list: it runs the SAME
 * engine as lease mint (policy.evaluate / policy.decide), so there is one enforcement path.
 * A known contact is evaluated in full (flags, consent, quiet hours, suppressions) and the
 * decision is persisted; an unknown identifier gets suppressions + org-default quiet hours only.
 * Evidence carries codes only: never the value.
 */

const store = require('./store.js');
const cx = require('./crypto.js');
const policy = require('./policy.js');
const { createEmitter } = require('./evidence.js');
const { normalizeIdentifier, NormalizeError } = require('./normalize.js');

const CHANNELS = ['voice', 'sms', 'email'];
const PURPOSES = ['service', 'transactional', 'marketing', 'research'];
const SUBJECTS = ['agent', 'user'];
const err = (status, error) => ({ status, json: { error } });

function createPolicyCheck({ audit }) {
  const emit = createEmitter(audit);

  function checkIdentifier(ctx, b) {
    if (!ctx || ctx.actor !== 'service') return err(403, 'service_required');
    const orgId = typeof b.org_id === 'string' ? b.org_id.trim() : '';
    if (!orgId || orgId.length > 128) return err(400, 'invalid_org_id');
    if (!CHANNELS.includes(b.channel)) return err(400, 'invalid_channel');
    const purpose = b.purpose === undefined ? 'service' : b.purpose;
    if (!PURPOSES.includes(purpose)) return err(400, 'invalid_purpose');
    const subjectType = b.subject_type === undefined ? 'agent' : b.subject_type;
    if (!SUBJECTS.includes(subjectType)) return err(400, 'invalid_subject_type');
    if (b.subject_id !== undefined && b.subject_id !== null && (typeof b.subject_id !== 'string' || b.subject_id.length > 128)) return err(400, 'invalid_subject_id');

    const identChannel = policy.IDENT_CHANNEL[b.channel];
    const settings = store.getSettings(orgId);
    let norm;
    try {
      norm = normalizeIdentifier(identChannel, b.value, { region: settings.default_region });
    } catch (e) {
      if (e instanceof NormalizeError) return err(400, e.code);
      throw e;
    }
    const sctx = { orgId, actor: 'service', userId: ctx.userId || null, agentId: ctx.agentId || null };
    const subject = { type: subjectType };
    const subjectId = b.subject_id || null;
    const { bi, contact } = store.findContactByIdentifier(orgId, norm);
    let result;
    let contactId = null;

    if (contact && contact.status !== 'erased') {
      contactId = contact.id;
      const bis = new Set(cx.blindIndexes(orgId, norm.channel, norm.normalised));
      const canons = new Set(cx.blindIndexes(orgId, norm.channel, norm.canonical));
      const rows = store.identifiersFor(orgId, contact.id).filter((i) => i.channel === identChannel);
      const pinned = rows.find((i) => bis.has(i.blind_index) || canons.has(i.blind_index_canonical)) || null;
      const pol = policy.evaluate(orgId, contact, { purpose, channel: b.channel, subject, identifier: pinned || undefined });
      result = { decision: pol.decision, reasons: pol.reasons, pack: pol.pack };
      // A suppression stored against the raw value but not this contact's rows still binds.
      const sup = store.checkSuppression(orgId, norm);
      if (sup.suppressed && result.decision !== 'deny') {
        const merged = policy.decide({
          contact: { status: contact.status, flags: policy.parseFlags(contact), tz: contact.tz || null, quiet_hours: store.parseJson(contact.quiet_hours_json, null) },
          identifiers: [{ channel: identChannel, verification: pinned ? pinned.verification : 'unverified' }],
          consents: store.consentsFor(orgId, contact.id), suppressions: sup.reasons,
          purpose, channel: b.channel, subject, now: Date.now(), orgQuietHours: settings.default_quiet_hours,
        });
        if (merged.decision === 'deny') result = { decision: merged.decision, reasons: merged.reasons, pack: merged.pack };
      }
    } else {
      const sup = store.checkSuppression(orgId, norm);
      const res = policy.decide({
        contact: {}, identifiers: [{ channel: identChannel, verification: 'unverified' }], consents: [],
        suppressions: sup.reasons, purpose, channel: b.channel, subject, now: Date.now(),
        orgQuietHours: settings.default_quiet_hours, orgContext: null,
      });
      result = { decision: res.decision, reasons: res.reasons, pack: res.pack };
      if (sup.reasons.includes('erasure_tombstone')) {
        result = { decision: 'deny', reasons: [...new Set(['erased', ...result.reasons])], pack: result.pack };
      }
    }

    if (contactId) {
      policy.record(emit, sctx, contactId, { subjectId, purpose, channel: b.channel, result });
    } else {
      emit('quox.contacts.policy.decision', sctx, {
        contact_id: null, purpose, channel: b.channel, decision: result.decision, reasons: result.reasons, pack: result.pack, bi_ref: cx.biRef(bi),
      });
    }
    return { status: 200, json: { decision: result.decision, reasons: result.reasons, contact_id: contactId } };
  }

  return { checkIdentifier };
}

function registerPolicyCheckRoute(app, deps) {
  for (const k of ['requireAuth', 'audit', 'deriveActorType']) {
    if (!deps || typeof deps[k] !== 'function') throw new Error(`registerPolicyCheckRoute requires deps.${k}`);
  }
  const svc = createPolicyCheck({ audit: deps.audit });
  app.post('/api/v1/contactsq/policy/check-identifier', deps.requireAuth, (req, res) => {
    try {
      const actor = req.user?.agent_ops ? 'agent' : deps.deriveActorType(req);
      const out = svc.checkIdentifier({ actor, userId: req.user?.id || null, agentId: req.user?.agent_id || null }, req.body || {});
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[contactsq] policy check error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  return svc;
}

module.exports = { registerPolicyCheckRoute, createPolicyCheck };
