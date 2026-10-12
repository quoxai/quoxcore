'use strict';

/**
 * ContactsQ governed entry point: /api/v1/contactsq/*.
 *
 * Fail closed: registerContactsqRoutes THROWS at init if any governance dep
 * is missing. Org ALWAYS comes from resolveOrgId(req), never body/query.
 * No licence gate in P0 (the substrate is FREE in Core).
 *
 * ONE boundary: createContactsqService(deps) holds every operation (validation,
 * org scoping, projection, evidence). The HTTP routes below and the agent
 * tools (lib/contactsqTools.js) both call it, so there is no second path.
 * Services return { status, json }.
 *
 * AEE envelopes NEVER carry identifier values, names or notes (see evidence.js).
 */

const store = require('./store.js');
const cx = require('./crypto.js');
const { normalizeIdentifier, NormalizeError, isValidRegion, CHANNELS } = require('./normalize.js');
const { project, toCard, maskValue } = require('./projections.js');
const { createEmitter } = require('./evidence.js');
const { createLeases } = require('./leases.js');
const grants = require('./grants.js');
const policy = require('./policy.js');
const { rewrapAll } = require('./rewrap.js');
const { search: searchContacts } = require('./search.js');
const erasure = require('./erasure.js');
const compliance = require('./compliance.js');
const merge = require('./merge.js');
const { createRetention } = require('./retention.js');
const p6mod = require('./p6.js');
const reindexer = require('./reindex.js');
const { createP5 } = require('./p5.js');
const { createSyncService } = require('./sync.js');
const { createContactsqAware } = require('./aware.js');
const names = require('./names.js');
const photos = require('./photos.js');
const history = require('./history.js');
const orgLink = require('./orgLink.js');
const reportsMod = require('./reports.js');
const { createOutcomeRecorder } = require('./wisdom.js');

const REQUIRED = ['requireAuth', 'resolveOrgId', 'audit', 'deriveActorType', 'isHumanAdmin'];
const KINDS = ['person', 'organisation'];
const SUPPRESS_REASONS = ['dnc', 'do_not_market', 'bounced'];
const STATUSES = ['candidate', 'active', 'archived', 'erased', 'merged'];
const err = (status, error) => ({ status, json: { error } });
const JURISDICTION_RE = /^[a-z]{2,8}(-[a-z0-9]{1,8})?$/i;
const STAGE_RE = /^[a-z0-9_-]{1,32}$/i;
const OBJECTION_SCOPES = ['all', 'marketing', 'channel'];
const subjectOfCtx = (ctx) => ({
  type: ctx.actor === 'agent' ? 'agent' : 'user',
  id: String(ctx.actor === 'agent' ? (ctx.agentId || 'unknown') : (ctx.userId || ctx.actor || 'unknown')),
});

/** {start:'HH:MM', end:'HH:MM', tz} or null (contact: use org default). */
function validQuietHours(v, { requireTz = false } = {}) {
  if (v === null) return { ok: true, value: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false };
  if (policy.parseHm(v.start) === null || policy.parseHm(v.end) === null) return { ok: false };
  if (v.tz === undefined || v.tz === null || v.tz === '') {
    if (requireTz) return { ok: false };
    return { ok: true, value: { start: v.start, end: v.end } };
  }
  if (typeof v.tz !== 'string' || !policy.isValidTz(v.tz)) return { ok: false };
  return { ok: true, value: { start: v.start, end: v.end, tz: v.tz } };
}

function validStringList(v, { max, itemMax, allowed }) {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim() || x.length > itemMax) return null;
    if (allowed && !allowed.includes(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}
const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

function normOrErr(channel, value, region) {
  try {
    return { norm: normalizeIdentifier(channel, value, { region }) };
  } catch (e) {
    if (e instanceof NormalizeError) return { error: err(400, e.code) };
    throw e;
  }
}

function createContactsqService({ audit, readEnvelopes, deliverReport, recordOutcome, sync: syncDeps }) {
  const emitEvidence = createEmitter(audit);
  // QuoxMind outcomes ride the SAME evidence events (one hook, no second path). Fail-soft, codes and counts only.
  const outcomes = createOutcomeRecorder(recordOutcome ? { record: recordOutcome } : {});
  const emit = (intent, ctx, extra) => { emitEvidence(intent, ctx, extra); outcomes.observe(intent, ctx, extra); };
  const reports = reportsMod.createReports({ emit, ...(deliverReport ? { deliver: deliverReport } : {}) });
  const wrap = (fn) => async (ctx, input) => {
    try {
      if (!ctx || !ctx.orgId) return err(401, 'unauthenticated');
      return await fn(ctx, input || {});
    } catch (e) {
      if (e instanceof store.ContactsqError) return err(e.status, e.code);
      console.error('[contactsq] error:', e && e.message);
      return err(500, 'internal_error');
    }
  };

  // P3b: mutations that can change who an email resolves to drop the in-process identity cache.
  const identity = require('./identity.js');
  const mut = (fn) => wrap(async (ctx, i) => { try { return await fn(ctx, i); } finally { identity.invalidate(); } });

  const createContact = mut((ctx, b) => {
    const kind = b.kind === undefined ? 'person' : b.kind;
    if (!KINDS.includes(kind)) return err(400, 'invalid_kind');
    // Structured person name: parts and/or an explicit display override may replace display_name (old clients send only display_name).
    let nameIn;
    let overrideIn;
    if (b.name !== undefined && b.name !== null) {
      if (kind === 'organisation') return err(400, 'name_not_for_organisation');
      const nv = names.validateName(b.name);
      if (!nv.ok) return err(400, 'invalid_name');
      nameIn = nv.value;
    }
    if (b.display_name_override !== undefined && b.display_name_override !== null) {
      if (kind === 'organisation') return err(400, 'name_not_for_organisation');
      const ov = names.validateOverride(b.display_name_override);
      if (!ov.ok) return err(400, 'invalid_display_name_override');
      overrideIn = ov.value || undefined;
    }
    const structured = names.hasAny(nameIn) || Boolean(overrideIn);
    if (!(structured && (b.display_name === undefined || b.display_name === null)) && !isStr(b.display_name, 200)) return err(400, 'invalid_display_name');
    if (!optStr(b.relationship_primary, 64)) return err(400, 'invalid_relationship_primary');
    if (!optStr(b.notes, 20000)) return err(400, 'invalid_notes');
    if (!optStr(b.preferred_name, 100)) return err(400, 'invalid_preferred_name');
    if (!optStr(b.pronunciation, 200)) return err(400, 'invalid_pronunciation');
    if (!optStr(b.language, 35)) return err(400, 'invalid_language');
    if (!optStr(b.tz, 64)) return err(400, 'invalid_tz');
    if (b.identifiers !== undefined && (!Array.isArray(b.identifiers) || b.identifiers.length > 50)) return err(400, 'invalid_identifiers');
    // Every contact has a name AND an organisation (owner rule): a person's organisation is a field, stored as a works_at link.
    let orgIn = null;
    if (b.organisation !== undefined) {
      const ov = orgLink.validateOrganisation(b.organisation);
      if (!ov.ok) return err(400, 'invalid_organisation');
      if (ov.value && kind === 'organisation') return err(400, 'organisation_for_person_only');
      orgIn = ov.value;
    }
    const { default_region: region } = store.getSettings(ctx.orgId);
    const idents = [];
    for (const it of b.identifiers || []) {
      if (!it || typeof it !== 'object') return err(400, 'invalid_identifiers');
      if (!optStr(it.label, 64)) return err(400, 'invalid_label');
      const r = normOrErr(it.channel, it.value, region);
      if (r.error) return r.error;
      idents.push({ norm: r.norm, label: it.label, is_primary: Boolean(it.is_primary) });
    }
    const { contact } = store.createContact(ctx.orgId, {
      display_name: typeof b.display_name === 'string' ? b.display_name.trim() : undefined, name: nameIn, display_name_override: overrideIn,
      kind, relationship_primary: b.relationship_primary, notes: b.notes,
      preferred_name: b.preferred_name, pronunciation: b.pronunciation, language: b.language, tz: b.tz,
      identifiers: idents, created_by: ctx.userId || ctx.agentId || null,
    });
    emit('quox.contacts.create', ctx, { contact_id: contact.id, outcome: 'created', count: idents.length });
    if (orgIn) {
      const r = orgLink.setOrganisation(ctx.orgId, store.getContactRow(ctx.orgId, contact.id), orgIn, { by: ctx.userId || ctx.agentId || null });
      if (r.created) emit('quox.contacts.create', ctx, { contact_id: r.org_contact_id, outcome: 'created', count: 0 });
      emit('quox.contacts.edge_add', ctx, { contact_id: contact.id, edge_type: 'works_at', outcome: 'linked' });
    }
    const fresh = store.getContactRow(ctx.orgId, contact.id);
    return { status: 201, json: { contact: p6mod.revealCard(ctx, toCard(ctx.orgId, fresh), fresh) } };
  });

  const listContacts = wrap((ctx, q) => {
    if (q.status !== undefined && !STATUSES.includes(q.status)) return err(400, 'invalid_status');
    const rows = store.listContacts(ctx.orgId, { q: typeof q.q === 'string' ? q.q : undefined, status: q.status, limit: q.limit });
    emit('quox.contacts.find', ctx, { outcome: 'ok', count: rows.length });
    return { status: 200, json: { contacts: rows.map((r) => p6mod.revealCard(ctx, toCard(ctx.orgId, r), r)) } };
  });

  const getContact = wrap((ctx, { id, projection }) => {
    const p = projection === undefined || projection === '' ? 'card' : projection;
    if (!['card', 'greeting', 'full'].includes(p)) return err(400, 'invalid_projection');
    // The id lookup is org-scoped: another org's id is indistinguishable from a missing one.
    const row = store.getContactRow(ctx.orgId, id);
    if (p === 'full' && ctx.actor !== 'human') return err(403, 'human_required');
    if (!row) return err(404, 'not_found');
    emit(p === 'full' ? 'quox.contacts.read_full' : 'quox.contacts.read', ctx, { contact_id: row.id, projection: p, outcome: 'ok' });
    return { status: 200, json: { contact: p6mod.revealCard(ctx, project(ctx.orgId, row, p), row) } };
  });

  const addIdentifier = mut((ctx, { id, body: b }) => {
    if (!optStr(b.label, 64)) return err(400, 'invalid_label');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    const { default_region: region } = store.getSettings(ctx.orgId);
    const r = normOrErr(b.channel, b.value, region);
    if (r.error) return r.error;
    let out;
    try {
      out = store.addIdentifier(ctx.orgId, row.id, r.norm, { label: b.label, is_primary: Boolean(b.is_primary) });
    } catch (e) {
      if (e instanceof store.ContactsqError && e.code === 'identifier_in_use') {
        emit('quox.contacts.identifier_add', ctx, { contact_id: row.id, channel: r.norm.channel, outcome: 'conflict', bi_ref: cx.biRef(cx.blindIndex(ctx.orgId, r.norm.channel, r.norm.normalised)) });
      }
      throw e;
    }
    emit('quox.contacts.identifier_add', ctx, { contact_id: row.id, channel: r.norm.channel, outcome: out.created ? 'added' : 'exists', bi_ref: cx.biRef(out.bi) });
    const i = out.row;
    return { status: 201, json: { identifier: { id: i.id, channel: i.channel, label: i.label || null, masked: maskValue(i.channel, r.norm.normalised) } } };
  });

  const archive = mut((ctx, { id }) => {
    const row = store.archiveContact(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    emit('quox.contacts.archive', ctx, { contact_id: row.id, outcome: 'archived' });
    return { status: 200, json: { contact: toCard(ctx.orgId, row) } };
  });

  const resolve = wrap((ctx, b) => {
    const projection = b.projection === undefined ? 'card' : b.projection;
    if (!['card', 'greeting', 'caller'].includes(projection)) return err(400, 'invalid_projection');
    if (!CHANNELS.includes(b.channel)) return err(400, 'invalid_channel');
    const ac = b.auto_candidate;
    if (ac !== undefined && ac !== null && (typeof ac !== 'object' || !isStr(ac.source_type, 64) || !optStr(ac.source_ref, 200))) {
      return err(400, 'invalid_auto_candidate');
    }
    const settings = store.getSettings(ctx.orgId);
    const r = normOrErr(b.channel, b.value, settings.default_region);
    if (r.error) return r.error;
    const norm = r.norm;
    const sup = store.checkSuppression(ctx.orgId, norm);
    const suppressed = sup.suppressed ? { reasons: sup.reasons } : null;
    let { bi, contact } = store.findContactByIdentifier(ctx.orgId, norm);
    let candidateCreated = false;
    // An erased identifier is never recreated: a tombstone blocks the auto-candidate and the answer stays "unknown".
    const tombstoned = sup.reasons.includes('erasure_tombstone');
    if (!contact && ac && !tombstoned) {
      const retain = new Date(Date.now() + settings.candidate_retention_days * 86400000).toISOString();
      try {
        ({ contact } = store.createContact(ctx.orgId, {
          display_name: `Unknown ${norm.channel}`, status: 'candidate', retain_until: retain,
          identifiers: [{ norm }], created_by: ctx.userId || ctx.agentId || null,
          provenance: { source_type: ac.source_type, source_ref: ac.source_ref, trust: 'observed', captured_by: ctx.userId || ctx.agentId || null },
        }));
        candidateCreated = true;
      } catch (e) {
        // Lost a race with a concurrent resolve: take the winner.
        if (!(e instanceof store.ContactsqError && e.code === 'identifier_in_use')) throw e;
        ({ contact } = store.findContactByIdentifier(ctx.orgId, norm));
      }
    }
    emit('quox.contacts.resolve', ctx, {
      contact_id: contact ? contact.id : null, channel: norm.channel, bi_ref: cx.biRef(bi), projection,
      outcome: candidateCreated ? 'candidate_created' : (contact ? 'hit' : 'miss'), suppressed: Boolean(suppressed),
    });
    return {
      status: 200,
      json: { match: contact ? (projection === 'caller' ? p6mod.callerProjection(ctx, contact, subjectOfCtx(ctx)) : p6mod.revealCard(ctx, project(ctx.orgId, contact, projection), contact)) : null, candidate_created: candidateCreated, suppressed },
    };
  });

  const addSuppression = wrap((ctx, b) => {
    if (!SUPPRESS_REASONS.includes(b.reason)) return err(400, 'invalid_reason');
    const { default_region: region } = store.getSettings(ctx.orgId);
    const r = normOrErr(b.channel, b.value, region);
    if (r.error) return r.error;
    const s = store.addSuppression(ctx.orgId, r.norm, b.reason, ctx.actor || null);
    emit('quox.contacts.suppress', ctx, { channel: s.channel, reason: s.reason, bi_ref: cx.biRef(s.bi), outcome: 'added' });
    return { status: 201, json: { suppression: { id: s.id, channel: s.channel, reason: s.reason } } };
  });

  const checkSuppression = wrap((ctx, b) => {
    const { default_region: region } = store.getSettings(ctx.orgId);
    const r = normOrErr(b.channel, b.value, region);
    if (r.error) return r.error;
    const c = store.checkSuppression(ctx.orgId, r.norm);
    emit('quox.contacts.suppress_check', ctx, { channel: r.norm.channel, bi_ref: cx.biRef(c.bi), outcome: c.suppressed ? 'suppressed' : 'clear' });
    return { status: 200, json: { suppressed: c.suppressed, reasons: c.reasons } };
  });

  const getSettings = wrap((ctx) => ({ status: 200, json: { settings: store.getSettings(ctx.orgId) } }));

  const putSettings = wrap((ctx, b) => {
    if (!ctx.isAdmin) return err(403, 'admin_required');
    const cur = store.getSettings(ctx.orgId);
    const next = { ...cur, ...b };
    if (!isValidRegion(next.default_region)) return err(400, 'invalid_default_region');
    if (!Number.isInteger(next.candidate_retention_days) || next.candidate_retention_days < 1 || next.candidate_retention_days > 3650) {
      return err(400, 'invalid_candidate_retention_days');
    }
    if (typeof next.strict_names !== 'boolean') return err(400, 'invalid_strict_names');
    if (!Number.isInteger(next.backup_retention_days) || next.backup_retention_days < 1 || next.backup_retention_days > 3650) return err(400, 'invalid_backup_retention_days');
    if (typeof next.retention_reaper_enabled !== 'boolean') return err(400, 'invalid_retention_reaper_enabled');
    if (typeof next.retention_run_time_utc !== 'string' || policy.parseHm(next.retention_run_time_utc) === null) return err(400, 'invalid_retention_run_time_utc');
    if (typeof next.default_jurisdiction !== 'string' || !JURISDICTION_RE.test(next.default_jurisdiction)) return err(400, 'invalid_default_jurisdiction');
    if (b.compliance_report !== undefined) {
      if (!b.compliance_report || typeof b.compliance_report !== 'object' || Array.isArray(b.compliance_report)) return err(400, 'invalid_compliance_report');
      next.compliance_report = { ...cur.compliance_report, ...b.compliance_report };
    }
    const crErr = reportsMod.validateConfig(next.compliance_report);
    if (crErr) return err(400, crErr);
    const dqh = validQuietHours(next.default_quiet_hours, { requireTz: true });
    if (!dqh.ok || dqh.value === null) return err(400, 'invalid_default_quiet_hours');
    const saved = store.putSettings(ctx.orgId, {
      ...next, default_region: next.default_region.toUpperCase(),
      default_jurisdiction: next.default_jurisdiction.toLowerCase(), default_quiet_hours: dqh.value,
      compliance_report: { enabled: next.compliance_report.enabled, cadence: next.compliance_report.cadence, day: next.compliance_report.day, time_utc: next.compliance_report.time_utc },
    });
    emit('quox.contacts.settings_update', ctx, { outcome: 'updated' });
    return { status: 200, json: { settings: saved } };
  });

  // ---- P1: search, leases, standing grants -------------------------------
  const leases = createLeases({ emit });

  const search = wrap((ctx, b) => {
    if (!isStr(b.q, 200)) return err(400, 'invalid_q');
    if (!optStr(b.org_hint, 200)) return err(400, 'invalid_org_hint');
    const out = searchContacts(ctx.orgId, { q: b.q, org_hint: b.org_hint, limit: b.limit });
    emit('quox.contacts.search', ctx, { outcome: out.ambiguous ? 'ambiguous' : 'ok', count: out.candidates.length });
    return { status: 200, json: { ...out, candidates: p6mod.revealCards(ctx, out.candidates) } };
  });

  /** HUMAN direct mint (ops/testing and `quox contacts call`). A human acting directly is the authorization. */
  const mintLease = wrap((ctx, b) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    const dial = b.projection === 'dial' && b.channel === 'voice';
    return leases.mint(ctx, b, { decidedBy: `user:${ctx.userId || 'unknown'}`, queueDial: dial });
  });

  const redeemLease = wrap((ctx, { id, body }) => leases.redeem(ctx, id, { transport: body && body.transport }));
  const revokeLease = wrap((ctx, { id }) => leases.revoke(ctx, id));
  const listLeases = wrap((ctx, q) => leases.list(ctx, { contact_id: q.contact_id }));

  /** SERVICE only, org-agnostic (the bridge serves several orgs). Deliberately outside wrap(): no org on ctx. */
  async function dialQueue(ctx, { wait, isAborted } = {}) {
    if (!ctx || ctx.actor !== 'service') return err(403, 'service_required');
    const jobs = await leases.dialQueue({ wait, isAborted });
    return { status: 200, json: { jobs } };
  }

  const rewrap = wrap((ctx) => {
    if (ctx.actor !== 'human' || !ctx.isAdmin) return err(403, 'admin_required');
    // A previous master is set (rotation in progress): rewrap itself is safe (lookups are dual-keyed in the
    // window), but we only allow it once this org's blind indexes have been re-keyed, so the operator never
    // finishes a rotation with identifiers that would silently stop matching.
    const rot = cx.previousKeyConfigured() ? reindexer.status(ctx.orgId) : null;
    if (rot && !rot.complete) {
      return { status: 409, json: { error: 'blind_index_rotation_required',
        message: 'MASTER_ENCRYPTION_KEY_PREVIOUS is set: run `quox contacts reindex` (POST /admin/reindex) first so the blind indexes are re-keyed under the current master, then rewrap.' } };
    }
    const r = rewrapAll(ctx.orgId);
    const { failed_ids: failedIds, ...counts } = r;
    emit('quox.contacts.rewrap', ctx, { counts });
    const out = { counts, failed_ids: failedIds };
    if (rot) out.previous_key_still_required = rot.suppressions_unconvertible > 0;
    return { status: 200, json: out };
  });
  const listGrants = wrap((ctx) => (ctx.actor !== 'human' ? err(403, 'human_required') : { status: 200, json: { grants: grants.listGrants(ctx.orgId) } }));
  const createGrant = wrap((ctx, b) => {
    if (ctx.actor !== 'human' || !ctx.isAdmin) return err(403, 'admin_required');
    const p = grants.applyPreset(b);
    if (p.error) return err(400, p.error);
    const v = grants.validateGrant(p.body);
    if (v.error) return err(400, v.error);
    const g = grants.createGrant(ctx.orgId, v.ok, ctx.userId);
    emit('quox.contacts.grant_create', ctx, { grant_id: g.id, outcome: 'created' });
    return { status: 201, json: { grant: g } };
  });
  const revokeGrant = wrap((ctx, { id }) => {
    if (ctx.actor !== 'human' || !ctx.isAdmin) return err(403, 'admin_required');
    const g = grants.revokeGrant(ctx.orgId, id);
    if (!g) return err(404, 'not_found');
    emit('quox.contacts.grant_revoke', ctx, { grant_id: g.id, outcome: 'revoked' });
    return { status: 200, json: { grant: g } };
  });

  /**
   * AGENT path (called only by lib/contactsqTools.js AFTER the approval gate).
   * decided_by comes from the trusted reservation (grantId), never from input.
   */
  const queueDial = wrap((ctx, b) => {
    if (!isStr(b.reason, 500)) return err(400, 'invalid_reason');
    const r = leases.mint(ctx, { contact_id: b.contact_id, projection: 'dial', channel: 'voice', purpose: b.purpose, reason: b.reason },
      { decidedBy: b.grantId ? `policy:${b.grantId}` : 'approval_gate', grantId: b.grantId || null, queueDial: true });
    if (r.status !== 201) return r;
    const row = store.getContactRow(ctx.orgId, r.json.lease.contact_id);
    return { status: 200, json: { lease: r.json.lease, contact: toCard(ctx.orgId, row) } };
  });

  /** AGENT path: mint a send lease, redeem it in-process, hand the value to `deliver` only. */
  const sendLease = wrap(async (ctx, b) => {
    if (!isStr(b.reason, 500)) return err(400, 'invalid_reason');
    if (typeof b.deliver !== 'function') return err(500, 'internal_error');
    const m = leases.mint(ctx, { contact_id: b.contact_id, projection: 'send', channel: b.channel, purpose: b.purpose, reason: b.reason },
      { decidedBy: b.grantId ? `policy:${b.grantId}` : 'approval_gate', grantId: b.grantId || null });
    if (m.status !== 201) return m;
    const lease = m.json.lease;
    const red = leases.redeem(ctx, lease.id, { transport: `notification:${b.channel}` }, { internal: true });
    if (red.status !== 200) return red;
    let out;
    try {
      out = await b.deliver({ value: red.json.value, channel: b.channel, lease_id: lease.id });
    } catch (e) {
      out = { success: false, error: e && e.message };
    }
    const ok = !out || out.success !== false;
    store.getDb().prepare("UPDATE contact_lease_uses SET outcome = ? WHERE org_id = ? AND lease_id = ?").run(ok ? 'sent' : 'failed', ctx.orgId, lease.id);
    emit('quox.contacts.send', ctx, { contact_id: lease.contact_id, channel: b.channel, lease_id: lease.id, outcome: ok ? 'sent' : 'failed' });
    const row = store.getContactRow(ctx.orgId, lease.contact_id);
    return { status: 200, json: { lease_id: lease.id, status: ok ? 'sent' : 'failed', ...(ok ? {} : { error: 'delivery_failed' }), contact: toCard(ctx.orgId, row) } };
  });

  // ---- P2: contact profile, consents, policy, objections, stats ------------
  const UPDATE_FIELDS = ['display_name', 'name', 'display_name_override', 'relationship_primary', 'relationships', 'lifecycle_stage', 'tags', 'flags', 'jurisdiction',
    'quiet_hours', 'preferred_name', 'pronunciation', 'language', 'tz', 'notes', 'organisation'];

  /** HUMAN edit of a contact's profile. Flag/stage changes are witnessed (codes only). */
  const updateContact = mut((ctx, { id, body: b }) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    const unknown = Object.keys(b || {}).filter((k) => !UPDATE_FIELDS.includes(k));
    if (unknown.length) return err(400, 'unknown_field');
    if (!Object.keys(b || {}).length) return err(400, 'no_fields');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    if (row.status === 'erased') return err(409, 'contact_erased');
    const patch = {};
    if (b.display_name !== undefined) { if (!isStr(b.display_name, 200)) return err(400, 'invalid_display_name'); patch.display_name = b.display_name.trim(); }
    if (b.name !== undefined) {
      const nv = names.validateName(b.name);
      if (!nv.ok) return err(400, 'invalid_name');
      patch.name = nv.value;
    }
    if (b.display_name_override !== undefined) {
      const ov = names.validateOverride(b.display_name_override);
      if (!ov.ok) return err(400, 'invalid_display_name_override');
      patch.display_name_override = ov.value;
    }
    if (b.relationship_primary !== undefined) {
      if (b.relationship_primary !== null && !policy.RELATIONSHIPS.includes(b.relationship_primary)) return err(400, 'invalid_relationship_primary');
      patch.relationship_primary = b.relationship_primary;
    }
    if (b.relationships !== undefined) {
      const l = validStringList(b.relationships, { max: policy.RELATIONSHIPS.length, itemMax: 32, allowed: policy.RELATIONSHIPS });
      if (!l) return err(400, 'invalid_relationships');
      patch.relationships = l;
    }
    if (b.lifecycle_stage !== undefined) {
      if (b.lifecycle_stage !== null && (typeof b.lifecycle_stage !== 'string' || !STAGE_RE.test(b.lifecycle_stage))) return err(400, 'invalid_lifecycle_stage');
      patch.lifecycle_stage = b.lifecycle_stage;
    }
    if (b.tags !== undefined) {
      const l = validStringList(b.tags, { max: 50, itemMax: 64 });
      if (!l) return err(400, 'invalid_tags');
      patch.tags = l;
    }
    if (b.flags !== undefined) {
      const l = validStringList(b.flags, { max: policy.FLAGS.length, itemMax: 32, allowed: policy.FLAGS });
      if (!l) return err(400, 'invalid_flags');
      patch.flags = l;
    }
    if (b.jurisdiction !== undefined) {
      if (b.jurisdiction !== null && (typeof b.jurisdiction !== 'string' || !JURISDICTION_RE.test(b.jurisdiction))) return err(400, 'invalid_jurisdiction');
      patch.jurisdiction = b.jurisdiction === null ? null : b.jurisdiction.toLowerCase();
    }
    if (b.quiet_hours !== undefined) {
      const q = validQuietHours(b.quiet_hours);
      if (!q.ok) return err(400, 'invalid_quiet_hours');
      patch.quiet_hours = q.value;
    }
    for (const [k, max] of [['preferred_name', 100], ['pronunciation', 200], ['language', 35], ['tz', 64], ['notes', 20000]]) {
      if (b[k] !== undefined) { if (!optStr(b[k], max)) return err(400, `invalid_${k}`); patch[k] = b[k]; }
    }
    if (patch.tz && !policy.isValidTz(patch.tz)) return err(400, 'invalid_tz');
    let orgPatch;
    if (b.organisation !== undefined) {
      const ov = orgLink.validateOrganisation(b.organisation);
      if (!ov.ok) return err(400, 'invalid_organisation');
      if (row.kind === 'organisation') return err(400, 'organisation_for_person_only');
      orgPatch = ov.value;
    }
    const before = policy.parseFlags(row);
    let updated = Object.keys(patch).length ? store.updateContact(ctx.orgId, row.id, patch) : row;
    if (orgPatch !== undefined) {
      const r = orgLink.setOrganisation(ctx.orgId, store.getContactRow(ctx.orgId, row.id), orgPatch, { by: ctx.userId || null });
      if (r.created) emit('quox.contacts.create', ctx, { contact_id: r.org_contact_id, outcome: 'created', count: 0 });
      if (r.changed) emit('quox.contacts.edge_add', ctx, { contact_id: row.id, edge_type: 'works_at', outcome: orgPatch ? 'linked' : 'unlinked' });
      updated = store.getContactRow(ctx.orgId, row.id);
    }
    if (patch.flags !== undefined) {
      const added = patch.flags.filter((f) => !before.includes(f));
      const removed = before.filter((f) => !patch.flags.includes(f));
      if (added.length || removed.length) emit('quox.contacts.flags_changed', ctx, { contact_id: row.id, flags: patch.flags, count: added.length + removed.length, outcome: 'changed' });
    }
    if (patch.lifecycle_stage !== undefined && patch.lifecycle_stage !== (row.lifecycle_stage || null)) {
      emit('quox.contacts.stage_changed', ctx, { contact_id: row.id, stage: patch.lifecycle_stage === null ? 'none' : patch.lifecycle_stage.toLowerCase(), outcome: 'changed' });
    }
    return { status: 200, json: { contact: p6mod.revealCard(ctx, toCard(ctx.orgId, updated), updated) } };
  });

  const consentJson = (c) => ({
    id: c.id, contact_id: c.contact_id, purpose: c.purpose, channel: c.channel, status: c.status, lawful_basis: c.lawful_basis,
    evidence_ref: c.evidence_ref || null, captured_by: c.captured_by || null, captured_via: c.captured_via, captured_at: c.captured_at,
    expires_at: c.expires_at || null,
  });

  /** Current matrix (latest row per purpose/channel) + full history. Human or service. */
  const listConsents = wrap((ctx, { id }) => {
    if (ctx.actor !== 'human' && ctx.actor !== 'service') return err(403, 'human_required');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    const all = store.consentsFor(ctx.orgId, row.id);
    const now = Date.now();
    const matrix = [...policy.currentConsentState(all).values()].map((c) => ({ ...consentJson(c), expired: policy.isExpired(c, now) }));
    return { status: 200, json: { matrix, history: all.map(consentJson) } };
  });

  /** APPEND a consent row. Human or service; agents may only reduce reach via the objection tool. */
  const addConsent = wrap((ctx, { id, body: b }) => {
    if (ctx.actor !== 'human' && ctx.actor !== 'service') return err(403, 'human_required');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    if (row.status === 'erased') return err(409, 'contact_erased');
    if (!policy.CONSENT_PURPOSES.includes(b.purpose)) return err(400, 'invalid_purpose');
    if (!policy.CONSENT_CHANNELS.includes(b.channel)) return err(400, 'invalid_channel');
    if (!policy.CONSENT_STATUSES.includes(b.status)) return err(400, 'invalid_status');
    const basis = b.lawful_basis === undefined ? 'consent' : b.lawful_basis;
    if (!policy.LAWFUL_BASES.includes(basis)) return err(400, 'invalid_lawful_basis');
    if (!optStr(b.evidence_ref, 200)) return err(400, 'invalid_evidence_ref');
    if (b.expires_at !== undefined && b.expires_at !== null && (typeof b.expires_at !== 'string' || Number.isNaN(Date.parse(b.expires_at)))) return err(400, 'invalid_expires_at');
    const c = store.appendConsent(ctx.orgId, row.id, {
      purpose: b.purpose, channel: b.channel, status: b.status, lawful_basis: basis, evidence_ref: b.evidence_ref || null,
      captured_by: ctx.userId || ctx.agentId || null, captured_via: ctx.actor === 'human' ? 'dashboard' : 'api',
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
    });
    emit('quox.contacts.consent', ctx, { contact_id: row.id, purpose: c.purpose, channel: c.channel, status: c.status, outcome: 'recorded' });
    return { status: 201, json: { consent: consentJson(c) } };
  });

  /** ADVISORY policy check: reads state, persists nothing. */
  const policyCheck = wrap((ctx, { id, body: b }) => {
    const purpose = b.purpose === undefined ? 'service' : b.purpose;
    if (!grants.PURPOSES.includes(purpose)) return err(400, 'invalid_purpose');
    if (!Object.keys(policy.IDENT_CHANNEL).includes(b.channel)) return err(400, 'invalid_channel');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    const r = policy.evaluate(ctx.orgId, row, { purpose, channel: b.channel, subject: subjectOfCtx(ctx) });
    return { status: 200, json: { decision: r.decision, reasons: r.reasons, pack: r.pack, purpose, channel: b.channel, advisory: true } };
  });

  const listPolicyDecisions = wrap((ctx, { id, limit }) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    return { status: 200, json: { decisions: store.decisionsFor(ctx.orgId, row.id, limit) } };
  });

  const stats = wrap((ctx) => {
    if (ctx.actor !== 'human' && ctx.actor !== 'service') return err(403, 'human_required');
    return { status: 200, json: store.stats(ctx.orgId) };
  });

  /**
   * contacts_best_channel: first channel whose policy decision is 'allow'. Read-only
   * apart from the persisted decision (it gates which channel the caller will use).
   */
  const bestChannel = wrap((ctx, b) => {
    const purpose = b.purpose === undefined ? 'service' : b.purpose;
    if (!grants.PURPOSES.includes(purpose)) return err(400, 'invalid_purpose');
    const contact = store.getContactRow(ctx.orgId, b.contact_id);
    if (!contact || contact.status === 'erased') return err(404, 'not_found');
    const subject = subjectOfCtx(ctx);
    const have = new Set(store.identifiersFor(ctx.orgId, contact.id).map((i) => i.channel));
    const order = ['voice', 'email', 'sms'];
    const sorted = [...order.filter((c) => have.has(policy.IDENT_CHANNEL[c])), ...order.filter((c) => !have.has(policy.IDENT_CHANNEL[c]))];
    const evals = sorted.map((channel) => {
      const r = policy.evaluate(ctx.orgId, contact, { purpose, channel, subject });
      return { channel, decision: r.decision, reasons: r.reasons };
    });
    const chosen = evals.find((e) => e.decision === 'allow') || null;
    const pending = evals.find((e) => e.decision === 'approval_required') || null;
    const overall = chosen || pending || evals[0];
    policy.record(emit, ctx, contact.id, {
      subjectId: subject.id, purpose, channel: chosen ? chosen.channel : null,
      result: { decision: overall.decision, reasons: overall.reasons, pack: policy.PACK },
    });
    return { status: 200, json: {
      channel: chosen ? chosen.channel : null, decision: overall.decision, reasons: overall.reasons,
      alternatives: evals.filter((e) => e !== chosen),
    } };
  });

  /**
   * Live objection capture. UNGATED by design: it only ever REDUCES reach, so it must be
   * instant. Appends 'objected' consent rows and adds suppressions.
   */
  const recordObjection = wrap((ctx, b) => {
    if (!OBJECTION_SCOPES.includes(b.scope)) return err(400, 'invalid_scope');
    if (b.scope === 'channel' && !(policy.CONSENT_CHANNELS.includes(b.channel) && b.channel !== 'any')) return err(400, 'invalid_channel');
    if (b.scope !== 'channel' && b.channel !== undefined && b.channel !== null) return err(400, 'channel_only_with_scope_channel');
    const via = b.via === undefined ? 'api' : b.via;
    if (!['voice', 'api'].includes(via)) return err(400, 'invalid_via');
    const row = store.getContactRow(ctx.orgId, b.contact_id);
    if (!row) return err(404, 'not_found');
    const purposes = b.scope === 'marketing' ? ['marketing'] : policy.CONSENT_PURPOSES;
    const channel = b.scope === 'channel' ? b.channel : 'any';
    const idents = store.identifiersFor(ctx.orgId, row.id);
    const source = `objection:${ctx.actor || 'service'}`;
    let suppressions = 0;
    store.getDb().transaction(() => {
      for (const purpose of purposes) {
        store.appendConsent(ctx.orgId, row.id, {
          purpose, channel, status: 'objected', lawful_basis: 'consent', captured_by: ctx.userId || ctx.agentId || null, captured_via: via,
        });
      }
      const sup = (i, reason) => { if (store.addSuppressionForIdentifier(ctx.orgId, i, reason, source).created) suppressions += 1; };
      for (const i of idents) {
        if ((b.scope === 'all' || (b.scope === 'channel' && b.channel === 'voice')) && i.channel === 'phone') sup(i, 'dnc');
        if (b.scope === 'all' || b.scope === 'marketing') sup(i, 'do_not_market');
      }
    })();
    emit('quox.contacts.objection', ctx, { contact_id: row.id, scope: b.scope, channel: b.scope === 'channel' ? b.channel : undefined, count: purposes.length, outcome: 'recorded' });
    return { status: 200, json: { objection: { contact_id: row.id, scope: b.scope, channel, purposes, suppressions_added: suppressions, via } } };
  });

  // ---- P3: touchpoints, timeline, relationship graph --------------------------
  const CODE_RE = /^[a-z0-9_.:-]{1,48}$/;
  const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const EDGE_ATTR_KEYS = ['role', 'dept', 'label'];
  const validIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

  /**
   * Record a touchpoint. ANY actor (the agent tool calls this too); the HTTP route narrows to
   * human/service via postTouchpoint. ref is an id (call sid, thread id, lease id), never content.
   * Agents cannot back-date or use the reserved 'contactsq' surface (automatic only).
   */
  const logTouchpoint = wrap((ctx, b) => {
    if (typeof b.contact_id !== 'string' || !b.contact_id) return err(400, 'invalid_contact_id');
    if (!store.TOUCHPOINT_SURFACES.includes(b.surface)) return err(400, 'invalid_surface');
    if (!store.TOUCHPOINT_DIRECTIONS.includes(b.direction)) return err(400, 'invalid_direction');
    if (typeof b.outcome !== 'string' || !CODE_RE.test(b.outcome)) return err(400, 'invalid_outcome');
    if (b.ref !== undefined && b.ref !== null && (typeof b.ref !== 'string' || !REF_RE.test(b.ref))) return err(400, 'invalid_ref');
    if (b.summary !== undefined && b.summary !== null && (typeof b.summary !== 'string' || b.summary.length > 500)) return err(400, 'invalid_summary');
    if (b.occurred_at !== undefined && b.occurred_at !== null && !validIso(b.occurred_at)) return err(400, 'invalid_occurred_at');
    if (ctx.actor === 'agent') {
      if (b.surface === 'contactsq') return err(400, 'invalid_surface');
      if (b.occurred_at) return err(400, 'invalid_occurred_at');
    }
    const row = store.getContactRow(ctx.orgId, b.contact_id);
    if (!row || row.status === 'erased') return err(404, 'not_found');
    const tp = store.addTouchpoint(ctx.orgId, row, {
      surface: b.surface, direction: b.direction, outcome: b.outcome, ref: b.ref || null, summary: b.summary || null,
      occurred_at: b.occurred_at ? new Date(b.occurred_at).toISOString() : null,
      agent_id: ctx.actor === 'agent' ? (ctx.agentId || null) : null, user_id: ctx.actor === 'human' ? (ctx.userId || null) : null,
    });
    emit('quox.contacts.touchpoint', ctx, { contact_id: row.id, surface: tp.surface, direction: tp.direction, touchpoint_id: tp.id, outcome: tp.outcome });
    return { status: 201, json: { touchpoint: { id: tp.id, contact_id: tp.contact_id, surface: tp.surface, direction: tp.direction, occurred_at: tp.occurred_at, outcome: tp.outcome, ref: tp.ref || null } } };
  });

  /** HTTP entry: human or service only (agents use the contacts_log_touchpoint tool, which is the same service call). */
  const postTouchpoint = wrap((ctx, { id, body }) => {
    if (ctx.actor !== 'human' && ctx.actor !== 'service') return err(403, 'human_required');
    return logTouchpoint(ctx, { ...(body || {}), contact_id: id });
  });

  /**
   * Timeline projection: touchpoints newest first. Summaries are decrypted for HUMAN callers only.
   * TODO(ContactsQ): summaries to agents wait for P4 context leases (spoofing + minimisation).
   */
  const timeline = wrap((ctx, { id, contact_id, limit }) => {
    const row = store.getContactRow(ctx.orgId, id || contact_id);
    if (!row || row.status === 'erased') return err(404, 'not_found');
    const human = ctx.actor === 'human';
    const dek = human ? store.dekFor(row) : null;
    const items = store.touchpointsFor(ctx.orgId, row.id, limit).map((t) => {
      const o = { id: t.id, surface: t.surface, direction: t.direction, occurred_at: t.occurred_at, outcome: t.outcome || null, ref: t.ref || null };
      if (human) {
        o.agent_id = t.agent_id || null;
        o.user_id = t.user_id || null;
        o.summary = null;
        if (dek && t.summary_ciphertext) { try { o.summary = cx.decryptField(dek, t.summary_ciphertext, { orgId: ctx.orgId, contactId: row.id, field: `touchpoint:${t.id}` }); } catch { o.summary = null; } }
      }
      return o;
    });
    emit('quox.contacts.timeline_read', ctx, { contact_id: row.id, count: items.length, outcome: 'ok' });
    return { status: 200, json: { timeline: items } };
  });

  /**
   * P8a handoff: a note left for the next session about an open thread with a contact. Same
   * touchpoint path (surface agent, direction internal, outcome handoff). Summary is encrypted and
   * shown to humans only; agents get existence + age.
   */
  const handoff = wrap((ctx, { contact_id, note }) => {
    if (typeof note !== 'string' || !note.trim()) return err(400, 'invalid_note');
    return logTouchpoint(ctx, { contact_id, surface: 'agent', direction: 'internal', outcome: 'handoff', summary: note.trim() });
  });

  const handoffs = wrap((ctx, { id, limit }) => {
    const row = store.getContactRow(ctx.orgId, id);
    if (!row || row.status === 'erased') return err(404, 'not_found');
    const human = ctx.actor === 'human';
    const dek = human ? store.dekFor(row) : null;
    const now = Date.now();
    const items = store.handoffsFor(ctx.orgId, row.id, limit === undefined ? 3 : limit).map((t) => {
      const o = { id: t.id, occurred_at: t.occurred_at, age_hours: Math.max(0, Math.floor((now - Date.parse(t.occurred_at)) / 3600000)), agent_id: t.agent_id || null };
      if (human) {
        o.summary = null;
        if (dek && t.summary_ciphertext) { try { o.summary = cx.decryptField(dek, t.summary_ciphertext, { orgId: ctx.orgId, contactId: row.id, field: `touchpoint:${t.id}` }); } catch { o.summary = null; } }
      }
      return o;
    });
    emit('quox.contacts.handoffs_read', ctx, { contact_id: row.id, count: items.length, outcome: 'ok' });
    return { status: 200, json: { handoffs: items } };
  });

  const edgeJson = (ctx, selfId, e, human) => {
    const outbound = e.from_id === selfId;
    const otherRow = store.getContactRow(ctx.orgId, outbound ? e.to_id : e.from_id);
    const o = {
      id: e.id, type: e.type, direction: outbound ? 'out' : 'in', since: e.since || null, until: e.until || null,
      other: otherRow ? { id: otherRow.id, kind: otherRow.kind, display_name: human ? p6mod.revealCard(ctx, otherRow, otherRow).display_name : otherRow.display_name } : null,
    };
    if (human) { o.attrs = store.edgeAttrs(ctx.orgId, e); o.created_by = e.created_by || null; }
    return o;
  };

  const listEdges = wrap((ctx, { id }) => {
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    const human = ctx.actor === 'human';
    return { status: 200, json: { edges: store.edgesFor(ctx.orgId, row.id).map((e) => edgeJson(ctx, row.id, e, human)) } };
  });

  const addEdge = wrap((ctx, { id, body: b }) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    if (!store.EDGE_TYPES.includes(b.type)) return err(400, 'invalid_type');
    if (typeof b.to_id !== 'string' || !b.to_id) return err(400, 'invalid_to_id');
    if (b.since !== undefined && b.since !== null && !validIso(b.since)) return err(400, 'invalid_since');
    if (b.until !== undefined && b.until !== null && !validIso(b.until)) return err(400, 'invalid_until');
    let attrs = {};
    if (b.attrs !== undefined && b.attrs !== null) {
      if (typeof b.attrs !== 'object' || Array.isArray(b.attrs)) return err(400, 'invalid_attrs');
      for (const [k, v] of Object.entries(b.attrs)) {
        if (!EDGE_ATTR_KEYS.includes(k) || typeof v !== 'string' || v.length > 100) return err(400, 'invalid_attrs');
        if (v.trim()) attrs[k] = v.trim();
      }
    }
    const from = store.getContactRow(ctx.orgId, id);
    const to = store.getContactRow(ctx.orgId, b.to_id);
    if (!from || !to) return err(404, 'not_found');
    if (from.status === 'erased' || to.status === 'erased') return err(404, 'not_found');
    if (from.id === to.id) return err(400, 'self_edge');
    const kinds = { works_at: ['person', 'organisation'], is_subsidiary_of: ['organisation', 'organisation'], reports_to: ['person', 'person'], assistant_of: ['person', 'person'] }[b.type];
    if (kinds && (from.kind !== kinds[0] || to.kind !== kinds[1])) return err(400, 'invalid_edge_kinds');
    if (store.findEdge(ctx.orgId, from.id, to.id, b.type)) return err(409, 'edge_exists');
    const e = store.addEdge(ctx.orgId, from, to, {
      type: b.type, attrs, since: b.since ? new Date(b.since).toISOString() : null, until: b.until ? new Date(b.until).toISOString() : null,
      created_by: ctx.userId || null,
    });
    emit('quox.contacts.edge_add', ctx, { contact_id: from.id, edge_type: e.type, edge_id: e.id, outcome: 'added' });
    return { status: 201, json: { edge: edgeJson(ctx, from.id, e, true) } };
  });

  const deleteEdge = wrap((ctx, { id, edge_id }) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    const row = store.getContactRow(ctx.orgId, id);
    const e = row ? store.edgeById(ctx.orgId, edge_id) : null;
    if (!row || !e || (e.from_id !== row.id && e.to_id !== row.id)) return err(404, 'not_found');
    store.deleteEdge(ctx.orgId, e.id);
    emit('quox.contacts.edge_remove', ctx, { contact_id: e.from_id, edge_type: e.type, edge_id: e.id, outcome: 'removed' });
    return { status: 200, json: { removed: true } };
  });

  // ---- P4: GDPR operations (erasure, DSAR, retention, Article 14 clocks, Article 30) ----
  const retention = createRetention({ emit });
  const needAdmin = (ctx) => (ctx.actor !== 'human' || !ctx.isAdmin ? err(403, 'admin_required') : null);

  /** Erase a contact. HUMAN org admin only, never an agent or service. */
  const eraseContact = mut((ctx, { id, body: b }) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    if (!erasure.SCOPES.includes(b.scope)) return err(400, 'invalid_scope');
    if (typeof b.reason_code !== 'string' || !CODE_RE.test(b.reason_code)) return err(400, 'invalid_reason_code');
    const out = erasure.eraseContact(ctx.orgId, id, { scope: b.scope, reasonCode: b.reason_code, requestedBy: `user:${ctx.userId || 'unknown'}` });
    emit('quox.contacts.erased', ctx, {
      contact_id: String(id), scope: b.scope, reason: b.reason_code, counts: out.erasure.counts, erasure_id: out.erasure.id, outcome: 'erased',
    });
    return { status: 200, json: { erasure: out.erasure, certificate: out.certificate } };
  });

  const getCertificate = wrap((ctx, { id }) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    const c = erasure.getCertificate(ctx.orgId, id);
    if (!c) return err(404, 'not_found');
    return { status: 200, json: { certificate: c.certificate, verified: c.verified } };
  });

  /** Art. 15 bundle: the whole record, decrypted, plus the lease and lease-use ledger. Human admin only. */
  const dsar = wrap((ctx, { id }) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    if (row.status === 'erased') return err(409, 'contact_erased');
    const bundle = compliance.buildDsar(ctx.orgId, row);
    emit('quox.contacts.dsar_exported', ctx, { contact_id: row.id, counts: bundle.counts, outcome: 'exported' });
    return { status: 200, json: bundle };
  });

  const getCompliance = wrap((ctx) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    return { status: 200, json: { generated_at: new Date().toISOString(), bands: compliance.buildBands(ctx.orgId) } };
  });

  const noticeSent = wrap((ctx, { id, body: b }) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    if (typeof b.evidence_ref !== 'string' || !REF_RE.test(b.evidence_ref)) return err(400, 'invalid_evidence_ref');
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return err(404, 'not_found');
    if (row.status === 'erased') return err(409, 'contact_erased');
    if (!row.notice_due_at) return err(409, 'notice_not_required');
    const at = new Date().toISOString();
    store.getDb().prepare('UPDATE contacts SET notice_sent_at = ?, notice_evidence_ref = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(at, b.evidence_ref, at, row.id, ctx.orgId);
    emit('quox.contacts.notice_sent', ctx, { contact_id: row.id, outcome: 'recorded' });
    return { status: 200, json: { notice: { contact_id: row.id, due_at: row.notice_due_at, sent_at: at, evidence_ref: b.evidence_ref } } };
  });

  /** Art. 30 record for the org: categories, purposes, recipients, retention and counts. No personal data. */
  const processingRecord = wrap((ctx) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    const rec = compliance.buildProcessingRecord(ctx.orgId);
    emit('quox.contacts.processing_record_exported', ctx, { counts: rec.counts.contacts_by_status, outcome: 'exported' });
    return { status: 200, json: rec };
  });

  const retentionStatus = wrap((ctx) => (ctx.actor !== 'human' ? err(403, 'human_required') : { status: 200, json: retention.status(ctx.orgId) }));
  const retentionRun = wrap((ctx, b) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return err(400, 'invalid_dry_run');
    const r = retention.runOrg(ctx.orgId, { dryRun: b.dry_run === true });
    return { status: 200, json: { run: r } };
  });
  /** Scheduler entry (server-side only, no HTTP route). */
  const retentionTick = (opts) => retention.tick(opts);
  /** Scheduler entry for the recurring compliance report (server-side only, async, no HTTP route). */
  const reportTick = (opts) => reports.tick(opts);

  /** Last N delivered/failed compliance reports for the org (counts and ids only). HUMAN only. */
  const listReports = wrap((ctx, q) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    let limit = 10;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > reportsMod.LIST_MAX) return err(400, 'invalid_limit');
    }
    return { status: 200, json: { reports: reports.list(ctx.orgId, limit) } };
  });


  // ---- History: the org's own quox.contacts.* evidence events, newest first (HUMAN only, codes and ids only) ----
  const HISTORY_MAX = 200;
  const getHistory = wrap((ctx, q) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    let limit = 50;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX) return err(400, 'invalid_limit');
    }
    let before = null;
    if (q.before !== undefined && q.before !== '') {
      if (typeof q.before !== 'string' || q.before.length > 40 || Number.isNaN(Date.parse(q.before))) return err(400, 'invalid_before');
      before = q.before;
    }
    if (typeof readEnvelopes !== 'function') return err(503, 'history_unavailable');
    // One extra row tells us whether there is another page; the cursor is the ts of the last row returned.
    const rows = readEnvelopes({ orgId: ctx.orgId, before, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const events = page.map((r) => history.toEvent(ctx.orgId, r)).filter(Boolean);
    return { status: 200, json: { events, next_before: hasMore && page.length ? page[page.length - 1].ts : null } };
  });

  // ---- Photos: encrypted under the contact DEK. HUMAN only for every verb (agents and services never see a photo) ----
  const photoRow = (ctx, id) => {
    if (ctx.actor !== 'human') return { out: err(403, 'human_required') };
    const row = store.getContactRow(ctx.orgId, id);
    if (!row) return { out: err(404, 'not_found') };
    if (row.status === 'erased') return { out: err(409, 'contact_erased') };
    if (row.status === 'merged') return { out: err(409, 'contact_merged') };
    return { row };
  };
  const putPhoto = wrap((ctx, { id, buffer }) => {
    const { row, out } = photoRow(ctx, id);
    if (out) return out;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return err(400, 'file_required');
    if (buffer.length > photos.MAX_BYTES) return err(413, 'file_too_large');
    const mime = photos.sniff(buffer);
    if (!mime) return err(415, 'unsupported_image_type');
    const meta = photos.putPhoto(ctx.orgId, row, buffer, mime);
    emit('quox.contacts.photo_set', ctx, { contact_id: row.id, format: photos.FORMAT[mime], outcome: 'set' });
    return { status: 200, json: { photo: { has_photo: true, mime: meta.mime, size: meta.size, updated_at: meta.updated_at } } };
  });
  /** -> { status: 200, binary: { mime, buffer, updated_at } } or a JSON error. The route sends the bytes. */
  const getPhoto = wrap((ctx, { id }) => {
    const { row, out } = photoRow(ctx, id);
    if (out) return out;
    const p = photos.getPhoto(ctx.orgId, row);
    if (!p) return err(404, 'no_photo');
    return { status: 200, binary: p };
  });
  const deletePhoto = wrap((ctx, { id }) => {
    const { row, out } = photoRow(ctx, id);
    if (out) return out;
    const removed = photos.deletePhoto(ctx.orgId, row.id);
    if (removed) emit('quox.contacts.photo_removed', ctx, { contact_id: row.id, outcome: 'removed' });
    return { status: 200, json: { removed } };
  });

  const p6 = p6mod.createP6({ emit, wrap, err, needAdmin });

  // ---- P8B: dashboard focus (in-memory, ids only, never persisted, no evidence) ----
  const focus = require('./focus.js');
  /** HUMAN only: the contact this person has open in the dashboard. */
  const setFocus = wrap((ctx, b) => {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    if (!ctx.userId) return err(400, 'user_required');
    if (!isStr(b.contact_id, 128)) return err(400, 'invalid_contact_id');
    const row = store.getContactRow(ctx.orgId, b.contact_id);
    if (!row || row.status === 'erased') return err(404, 'not_found');
    focus.setFocus(ctx.orgId, ctx.userId, row.id);
    return { status: 200, json: { ok: true } };
  });
  /** Human or agent: the most recent live focus in this org as a masked card, or {focus:null}. */
  const getFocus = wrap((ctx) => {
    if (ctx.actor !== 'human' && ctx.actor !== 'agent') return err(403, 'human_required');
    const f = focus.latestFocus(ctx.orgId);
    const row = f && store.getContactRow(ctx.orgId, f.contact_id);
    if (!f || !row || row.status === 'erased') return { status: 200, json: { focus: null } };
    return { status: 200, json: { focus: { contact: toCard(ctx.orgId, row), set_by: f.user_id, age_seconds: f.age_seconds } } };
  });

  // ---- P5: import, merge, duplicates, facts, context lease (lib/contactsq/p5.js; same service, same evidence) ----
  const p5 = createP5({ emit, wrap, err });
  // ---- P7: one-way CardDAV pull sync (lib/contactsq/sync.js; human org admin only, evidence through the same emitter) ----
  const p7 = createSyncService({ emit, wrap, err, deps: syncDeps || {} });

  /**
   * P8a morning brief: counts and ids only, assembled from the existing compliance bands, duplicates
   * finder, store stats and sync sources. Open to humans, agents and services (nothing personal in it).
   */
  const brief = wrap((ctx) => {
    const bands = compliance.buildBands(ctx.orgId);
    const dupes = merge.findDuplicates(ctx.orgId, { limit: 100 });
    const st = store.stats(ctx.orgId);
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const dnc = store.getDb().prepare("SELECT COUNT(*) AS n FROM contact_suppressions WHERE org_id = ? AND reason = 'dnc' AND created_at >= ?").get(ctx.orgId, since).n;
    const sources = p7._sync.listSources(ctx.orgId).map((s) => ({ source_id: s.id, label: s.label || null, last_status: s.last_status, last_run_at: s.last_run_at, retired: Boolean(s.retired_at) }));
    const out = {
      candidates_to_review: st.candidates, consents_expiring_30d: bands.consents_expiring_30d.count, notices_overdue: bands.notice_overdue.count,
      duplicates: dupes.length, sync: sources, dnc_added_7d: dnc, generated_at: new Date().toISOString(),
    };
    emit('quox.contacts.brief', ctx, { counts: { candidates: out.candidates_to_review, consents_expiring: out.consents_expiring_30d, notices_overdue: out.notices_overdue, duplicates: out.duplicates, sync_sources: sources.length, dnc_added_7d: dnc }, outcome: 'ok' });
    return { status: 200, json: out };
  });

  /** Scheduler entry for LUCID awareness (server-side only, no HTTP route, no timer of its own). */
  const aware = createContactsqAware({ store, compliance, merge, listSources: (orgId) => p7._sync.listSources(orgId), retentionStatus: (orgId) => retention.status(orgId) });
  const awareTick = () => aware.tick();

  return { ...p6, ...p5, ...p7, brief, awareTick, handoff, handoffs, eraseContact, getCertificate, dsar, getCompliance, noticeSent, processingRecord, retentionStatus, retentionRun, retentionTick, reportTick, listReports,
    search, mintLease, redeemLease, revokeLease, listLeases, dialQueue, listGrants, createGrant, revokeGrant, queueDial, sendLease, setFocus, getFocus,
    createContact, listContacts, getContact, addIdentifier, archive, resolve, addSuppression, checkSuppression, getSettings, putSettings,
    updateContact, listConsents, addConsent, policyCheck, listPolicyDecisions, stats, bestChannel, recordObjection, rewrap,
    logTouchpoint, postTouchpoint, timeline, listEdges, addEdge, deleteEdge, getHistory, putPhoto, getPhoto, deletePhoto };
}

function registerContactsqRoutes(app, deps) {
  for (const k of REQUIRED) {
    if (!deps || typeof deps[k] !== 'function') throw new Error(`registerContactsqRoutes requires deps.${k}`);
  }
  const { requireAuth, resolveOrgId, deriveActorType, isHumanAdmin, audit } = deps;
  const svc = deps.service || createContactsqService({ audit, readEnvelopes: deps.readEnvelopes, deliverReport: deps.deliverReport, recordOutcome: deps.recordOutcome, sync: deps.sync });

  const ctxOf = (req) => {
    const orgId = resolveOrgId(req);
    if (!orgId) return null;
    // An agent-operated user session (SVC-AUTH #447 agent_ops) is authored as agent.
    const actor = req.user?.agent_ops ? 'agent' : deriveActorType(req);
    return { orgId, userId: req.user?.id || req.auth?.userId || null, actor, isAdmin: isHumanAdmin(req), agentId: req.user?.agent_id || null };
  };
  const h = (fn, input) => async (req, res) => {
    try {
      const ctx = ctxOf(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      const out = await fn(ctx, input(req));
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[contactsq] route error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  };

  const B = '/api/v1/contactsq';
  app.post(`${B}/contacts`, requireAuth, h(svc.createContact, (r) => r.body));
  app.get(`${B}/contacts`, requireAuth, h(svc.listContacts, (r) => r.query));
  app.get(`${B}/contacts/:id`, requireAuth, h(svc.getContact, (r) => ({ id: r.params.id, projection: r.query.projection })));
  app.post(`${B}/contacts/:id/identifiers`, requireAuth, h(svc.addIdentifier, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.put(`${B}/contacts/:id`, requireAuth, h(svc.updateContact, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.get(`${B}/contacts/:id/consents`, requireAuth, h(svc.listConsents, (r) => ({ id: r.params.id })));
  app.post(`${B}/contacts/:id/consents`, requireAuth, h(svc.addConsent, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.post(`${B}/contacts/:id/policy`, requireAuth, h(svc.policyCheck, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.get(`${B}/contacts/:id/policy-decisions`, requireAuth, h(svc.listPolicyDecisions, (r) => ({ id: r.params.id, limit: r.query.limit })));
  app.post(`${B}/contacts/:id/touchpoints`, requireAuth, h(svc.postTouchpoint, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.get(`${B}/contacts/:id/handoffs`, requireAuth, h(svc.handoffs, (r) => ({ id: r.params.id, limit: r.query.limit })));
  // Same service fn as the contacts_handoff tool (one boundary): agents and humans may leave a note; the general touchpoint route stays human only.
  app.post(`${B}/contacts/:id/handoffs`, requireAuth, h(async (ctx, i) => { const out = await svc.handoff(ctx, i); return out.status === 200 ? { ...out, status: 201 } : out; }, (r) => ({ contact_id: r.params.id, note: (r.body || {}).note })));
  app.get(`${B}/brief`, requireAuth, h(svc.brief, () => ({})));
  app.get(`${B}/contacts/:id/timeline`, requireAuth, h(svc.timeline, (r) => ({ id: r.params.id, limit: r.query.limit })));
  app.get(`${B}/contacts/:id/edges`, requireAuth, h(svc.listEdges, (r) => ({ id: r.params.id })));
  app.post(`${B}/contacts/:id/edges`, requireAuth, h(svc.addEdge, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.delete(`${B}/contacts/:id/edges/:edgeId`, requireAuth, h(svc.deleteEdge, (r) => ({ id: r.params.id, edge_id: r.params.edgeId })));
  app.post(`${B}/contacts/:id/erase`, requireAuth, h(svc.eraseContact, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.get(`${B}/contacts/:id/dsar`, requireAuth, h(svc.dsar, (r) => ({ id: r.params.id })));
  app.post(`${B}/contacts/:id/notice-sent`, requireAuth, h(svc.noticeSent, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.get(`${B}/erasures/:id/certificate`, requireAuth, h(svc.getCertificate, (r) => ({ id: r.params.id })));
  app.get(`${B}/retention/status`, requireAuth, h(svc.retentionStatus, () => ({})));
  app.post(`${B}/retention/run`, requireAuth, h(svc.retentionRun, (r) => r.body || {}));
  app.get(`${B}/compliance`, requireAuth, h(svc.getCompliance, () => ({})));
  app.get(`${B}/processing-record`, requireAuth, h(svc.processingRecord, () => ({})));
  app.get(`${B}/history`, requireAuth, h(svc.getHistory, (r) => r.query));
  app.get(`${B}/reports`, requireAuth, h(svc.listReports, (r) => r.query));
  // Photos (human only, encrypted at rest). Upload is multipart field `file`, png/jpeg/webp up to 2 MB, re-validated by magic bytes.
  const multerPhoto = require('multer');
  const photoUpload = multerPhoto({ storage: multerPhoto.memoryStorage(), limits: { fileSize: photos.MAX_BYTES, files: 1 } });
  app.put(`${B}/contacts/:id/photo`, requireAuth, (req, res, next) => photoUpload.single('file')(req, res, (e) => {
    if (!e) return next();
    return e.code === 'LIMIT_FILE_SIZE' ? res.status(413).json({ error: 'file_too_large', max_bytes: photos.MAX_BYTES }) : res.status(400).json({ error: 'invalid_upload' });
  }), async (req, res) => {
    try {
      const ctx = ctxOf(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      const out = await svc.putPhoto(ctx, { id: req.params.id, buffer: req.file ? req.file.buffer : null });
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[contactsq] photo upload route error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.get(`${B}/contacts/:id/photo`, requireAuth, async (req, res) => {
    try {
      const ctx = ctxOf(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      const out = await svc.getPhoto(ctx, { id: req.params.id });
      if (!out.binary) return res.status(out.status).json(out.json);
      res.set({
        'Content-Type': out.binary.mime, 'Content-Length': String(out.binary.buffer.length), 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300',
      });
      return res.status(200).end(out.binary.buffer);
    } catch (e) {
      console.error('[contactsq] photo read route error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.delete(`${B}/contacts/:id/photo`, requireAuth, h(svc.deletePhoto, (r) => ({ id: r.params.id })));
  app.get(`${B}/stats`, requireAuth, h(svc.stats, () => ({})));
  app.delete(`${B}/contacts/:id`, requireAuth, h(svc.archive, (r) => ({ id: r.params.id })));
  app.post(`${B}/resolve`, requireAuth, h(svc.resolve, (r) => r.body));
  app.post(`${B}/suppressions/check`, requireAuth, h(svc.checkSuppression, (r) => r.body));
  app.post(`${B}/suppressions`, requireAuth, h(svc.addSuppression, (r) => r.body));
  app.get(`${B}/search`, requireAuth, h(svc.search, (r) => r.query));
  app.post(`${B}/leases`, requireAuth, h(svc.mintLease, (r) => r.body || {}));
  // Registered BEFORE /leases/:id/* so 'dial-queue' is never read as an id.
  app.get(`${B}/leases/dial-queue`, requireAuth, async (req, res) => {
    try {
      // Service-only and org-agnostic: no resolveOrgId here. Actor comes from the credential class.
      const actor = deriveActorType(req);
      let aborted = false;
      req.on('close', () => { aborted = true; });
      const wait = req.query.wait === undefined ? 0 : Number(req.query.wait);
      if (!Number.isFinite(wait) || wait < 0 || wait > 25) return actor === 'service' ? res.status(400).json({ error: 'invalid_wait' }) : res.status(403).json({ error: 'service_required' });
      const out = await svc.dialQueue({ actor }, { wait, isAborted: () => aborted });
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[contactsq] dial-queue error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.get(`${B}/leases`, requireAuth, h(svc.listLeases, (r) => r.query));
  app.post(`${B}/leases/:id/redeem`, requireAuth, h(svc.redeemLease, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.post(`${B}/leases/:id/revoke`, requireAuth, h(svc.revokeLease, (r) => ({ id: r.params.id })));
  app.post(`${B}/admin/rewrap`, requireAuth, h(svc.rewrap, () => ({})));
  app.post(`${B}/admin/reindex`, requireAuth, h(svc.reindex, () => ({})));
  app.post(`${B}/admin/strict-names/apply`, requireAuth, h(svc.strictNamesApply, () => ({})));
  app.post(`${B}/suppressions/tombstones/lift`, requireAuth, h(svc.tombstoneLift, (r) => r.body || {}));
  app.get(`${B}/grants`, requireAuth, h(svc.listGrants, () => ({})));
  app.post(`${B}/grants`, requireAuth, h(svc.createGrant, (r) => r.body || {}));
  app.delete(`${B}/grants/:id`, requireAuth, h(svc.revokeGrant, (r) => ({ id: r.params.id })));
  // ---- P5: import, merge, duplicates, facts ----
  const multer = require('multer');
  const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } });
  app.post(`${B}/import`, requireAuth, (req, res, next) => importUpload.single('file')(req, res, (e) => {
    if (!e) return next();
    return e.code === 'LIMIT_FILE_SIZE' ? res.status(413).json({ error: 'file_too_large', max_bytes: IMPORT_MAX_BYTES }) : res.status(400).json({ error: 'invalid_upload' });
  }), async (req, res) => {
    try {
      const ctx = ctxOf(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      if (!req.file) return res.status(400).json({ error: 'file_required' });
      const f = (k) => (req.body && req.body[k] !== undefined ? req.body[k] : req.query[k]);
      // dry_run defaults to TRUE: a commit must be asked for in words.
      const dry = f('dry_run');
      if (dry !== undefined && !['true', '1', 'false', '0'].includes(String(dry))) return res.status(400).json({ error: 'invalid_dry_run' });
      let mapping;
      if (f('mapping') !== undefined && f('mapping') !== '') {
        try { mapping = typeof f('mapping') === 'string' ? JSON.parse(f('mapping')) : f('mapping'); } catch { return res.status(400).json({ error: 'invalid_mapping' }); }
      }
      const out = await svc.importContacts(ctx, {
        buffer: req.file.buffer, filename: req.file.originalname, format: f('format') ? String(f('format')) : undefined, mapping,
        dry_run: dry === undefined ? true : ['true', '1'].includes(String(dry)),
      });
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[contactsq] import route error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.get(`${B}/imports`, requireAuth, h(svc.listImports, () => ({})));
  app.get(`${B}/duplicates`, requireAuth, h(svc.duplicates, (r) => r.query));
  app.get(`${B}/merges`, requireAuth, h(svc.listMerges, (r) => r.query));
  app.post(`${B}/contacts/:id/merge`, requireAuth, h(svc.mergeContacts, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.post(`${B}/merges/:id/undo`, requireAuth, h(svc.undoMerge, (r) => ({ id: r.params.id })));
  app.get(`${B}/contacts/:id/facts`, requireAuth, h(svc.listFacts, (r) => ({ id: r.params.id })));
  app.post(`${B}/contacts/:id/facts`, requireAuth, h(svc.addFact, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.put(`${B}/contacts/:id/facts/:factId`, requireAuth, h(svc.updateFact, (r) => ({ id: r.params.id, fact_id: r.params.factId, body: r.body || {} })));
  // ---- P7: CardDAV pull sync ----
  app.get(`${B}/sync/sources`, requireAuth, h(svc.listSyncSources, () => ({})));
  app.post(`${B}/sync/sources`, requireAuth, h(svc.addSyncSource, (r) => r.body || {}));
  app.patch(`${B}/sync/sources/:id`, requireAuth, h(svc.updateSyncSource, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.post(`${B}/sync/sources/:id/run`, requireAuth, h(svc.runSyncSource, (r) => ({ id: r.params.id, body: r.body || {} })));
  app.delete(`${B}/sync/sources/:id`, requireAuth, h(svc.removeSyncSource, (r) => ({ id: r.params.id })));
  app.post(`${B}/focus`, requireAuth, h(svc.setFocus, (r) => r.body || {}));
  app.get(`${B}/focus`, requireAuth, h(svc.getFocus, () => ({})));
  app.get(`${B}/settings`, requireAuth, h(svc.getSettings, () => ({})));
  app.put(`${B}/settings`, requireAuth, h(svc.putSettings, (r) => r.body));
  return svc;
}

module.exports = { registerContactsqRoutes, createContactsqService };
