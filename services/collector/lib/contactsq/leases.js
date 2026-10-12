'use strict';

/**
 * ContactsQ leases (P1): a short-lived, single-use right to ONE identifier of
 * ONE contact for ONE purpose. The value is released only by redeem(), only to
 * a SERVICE caller (or in-process by the governed send path), only in the
 * response body. It is never logged and never in evidence.
 */

const nodeCrypto = require('node:crypto');
const store = require('./store.js');
const cx = require('./crypto.js');
const grants = require('./grants.js');
const policy = require('./policy.js');

const LEASE_TTL_MS = 300000;
const PROJECTION_CHANNELS = { dial: ['voice'], send: ['sms', 'email'] };
const PURPOSES = grants.PURPOSES;
const err = (status, error, extra) => ({ status, json: { error, ...(extra || {}) } });
const sha256 = (s) => nodeCrypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

function leaseJson(r) {
  return {
    id: r.id, contact_id: r.contact_id, projection: r.projection, channel: r.channel, purpose: r.purpose,
    status: r.status, decided_by: r.decided_by, expires_at: r.expires_at, use_count: r.use_count, max_uses: r.max_uses,
  };
}

function getLeaseRow(orgId, id) {
  return store.getDb().prepare('SELECT * FROM contact_leases WHERE org_id = ? AND id = ?').get(orgId, String(id)) || null;
}

function subjectOf(ctx) {
  if (ctx.actor === 'agent') return { type: 'agent', id: String(ctx.agentId || 'unknown').trim().toLowerCase() };
  if (ctx.actor === 'human') return { type: 'user', id: String(ctx.userId || 'unknown') };
  return { type: 'service', id: String(ctx.userId || ctx.agentId || 'service') };
}

function createLeases({ emit }) {
  /**
   * mint(ctx, {contact_id, projection, channel, purpose, reason}, {decidedBy, grantId, queueDial})
   * -> {status, json:{lease}}. decidedBy is set by trusted code paths only (never from input).
   */
  function mint(ctx, input, opts = {}) {
    const { contact_id, projection, channel } = input;
    const purpose = input.purpose === undefined ? 'service' : input.purpose;
    if (!PROJECTION_CHANNELS[projection]) return err(400, 'invalid_projection');
    if (!PROJECTION_CHANNELS[projection].includes(channel)) return err(400, 'invalid_channel');
    if (!PURPOSES.includes(purpose)) return err(400, 'invalid_purpose');
    const reason = typeof input.reason === 'string' ? input.reason : '';
    if (reason.length > 500) return err(400, 'invalid_reason');
    const contact = store.getContactRow(ctx.orgId, contact_id);
    if (!contact || contact.status === 'erased') return err(404, 'not_found');
    const ident = policy.pickIdentifier(ctx.orgId, contact.id, channel);
    if (!ident) return err(409, 'no_identifier');
    const subject = subjectOf(ctx);
    const id = store.gid('cl');
    const base = {
      id, org_id: ctx.orgId, subject_type: subject.type, subject_id: subject.id, contact_id: contact.id, projection, channel, purpose,
      decided_by: opts.decidedBy || 'approval_gate', identifier_id: ident.id, requested_at: nowIso(),
      reason_text_hash: reason ? sha256(reason) : null,
    };
    const insert = store.getDb().prepare(`
      INSERT INTO contact_leases (id, org_id, subject_type, subject_id, contact_id, projection, channel, purpose, kind, status, decided_by,
        identifier_id, requested_at, expires_at, max_uses, use_count, reason_text_hash, reason_ciphertext, dial_state)
      VALUES (@id, @org_id, @subject_type, @subject_id, @contact_id, @projection, @channel, @purpose, 'inject', @status, @decided_by,
        @identifier_id, @requested_at, @expires_at, 1, 0, @reason_text_hash, @reason_ciphertext, @dial_state)
    `);

    // P2: ONE policy engine decides every mint (suppressions, flags, consent, quiet hours).
    const pSubject = { type: subject.type === 'agent' ? 'agent' : 'user' };
    const pol = policy.evaluate(ctx.orgId, contact, { purpose, channel, subject: pSubject, identifier: ident });
    policy.record(emit, ctx, contact.id, { subjectId: subject.id, purpose, channel, result: pol });
    if (pol.decision === 'deny') {
      insert.run({ ...base, status: 'denied', expires_at: base.requested_at, reason_ciphertext: null, dial_state: null });
      emit('quox.contacts.lease.denied', ctx, { contact_id: contact.id, channel, lease_id: id, purpose, reason: pol.reasons.join(',') });
      return err(403, policy.denialErrorCode(pol.reasons), { reasons: pol.reasons });
    }
    // approval_required: a standing grant never stands in for a human who has not looked.
    // (A human, or the approval gate after a human decision, may proceed.)
    if (pol.decision === 'approval_required' && (opts.grantId || String(opts.decidedBy || '').startsWith('policy:'))) {
      return err(409, 'approval_required', { reasons: pol.reasons });
    }

    const dek = store.dekFor(contact);
    if (opts.queueDial && !dek) return err(409, 'contact_shredded');
    const row = {
      ...base, status: 'active', expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      reason_ciphertext: opts.queueDial && reason ? cx.encryptField(dek, reason, store.bindOf(ctx.orgId, contact.id, `reason:${id}`)) : null,
      dial_state: opts.queueDial ? 'queued' : null,
    };
    // A standing-grant mint re-counts the cap inside the write transaction: the
    // gate's check and this insert are separated by awaits, so concurrent calls
    // must not all slip under the cap.
    const tx = store.getDb().transaction(() => {
      if (opts.grantId) {
        const g = grants.getGrant(ctx.orgId, opts.grantId);
        if (!g || g.revoked_at) return err(409, 'grant_unavailable');
        if (grants.usedToday(ctx.orgId, g.id) >= g.max_uses_per_day) return err(429, 'grant_cap_reached');
      }
      insert.run(row);
      return null;
    });
    const refused = tx();
    if (refused) return refused;
    if (row.dial_state === 'queued') wakeDialWaiters();
    emit('quox.contacts.lease.minted', ctx, { contact_id: contact.id, channel, lease_id: id, purpose, outcome: 'active' });
    return { status: 201, json: { lease: leaseJson(getLeaseRow(ctx.orgId, id)) } };
  }

  /** redeem. `internal` is passed ONLY by the governed in-process send path, never from HTTP. */
  function redeem(ctx, leaseId, { transport } = {}, { internal = false } = {}) {
    if (!internal && ctx.actor !== 'service') return err(403, 'service_required');
    const row = getLeaseRow(ctx.orgId, leaseId);
    if (!row) return err(410, 'lease_unusable');
    const db = store.getDb();
    if (row.status === 'active' && row.expires_at <= nowIso()) {
      db.prepare("UPDATE contact_leases SET status = 'expired' WHERE id = ? AND org_id = ? AND status = 'active'").run(row.id, ctx.orgId);
      return err(410, 'lease_unusable');
    }
    if (row.status !== 'active' || row.use_count >= row.max_uses) return err(410, 'lease_unusable');
    const contact = store.getContactRow(ctx.orgId, row.contact_id);
    if (!contact || contact.status === 'erased') return err(410, 'lease_unusable');
    const ident = db.prepare('SELECT * FROM contact_identifiers WHERE org_id = ? AND id = ? AND retired_at IS NULL').get(ctx.orgId, row.identifier_id);
    if (!ident) return err(410, 'lease_unusable');
    // State can change between mint and redeem: re-run the engine as the lease's original subject.
    const pol = policy.evaluate(ctx.orgId, contact, {
      purpose: row.purpose, channel: row.channel, subject: { type: row.subject_type === 'agent' ? 'agent' : 'user' }, identifier: ident,
    });
    policy.record(emit, ctx, contact.id, { subjectId: row.subject_id, purpose: row.purpose, channel: row.channel, result: pol });
    const lateApproval = pol.decision === 'approval_required' && String(row.decided_by || '').startsWith('policy:');
    if (pol.decision === 'deny' || lateApproval) {
      db.prepare("UPDATE contact_leases SET status = 'revoked', revoked_at = ? WHERE id = ? AND org_id = ? AND status = 'active'").run(nowIso(), row.id, ctx.orgId);
      emit('quox.contacts.lease.denied', ctx, { contact_id: contact.id, channel: row.channel, lease_id: row.id, purpose: row.purpose, reason: pol.reasons.join(',') });
      return lateApproval ? err(409, 'approval_required', { reasons: pol.reasons }) : err(403, policy.denialErrorCode(pol.reasons), { reasons: pol.reasons });
    }
    const dek = store.dekFor(contact);
    let value = null;
    try { value = dek ? cx.decryptField(dek, ident.ciphertext, store.bindOf(ctx.orgId, contact.id, `identifier:${ident.id}`)) : null; } catch { value = null; }
    if (!value) return err(409, 'contact_shredded');
    let tpId = null;
    const claimed = db.transaction(() => {
      const info = db.prepare(
        "UPDATE contact_leases SET use_count = use_count + 1, status = CASE WHEN use_count + 1 >= max_uses THEN 'used' ELSE status END WHERE id = ? AND org_id = ? AND status = 'active' AND use_count < max_uses"
      ).run(row.id, ctx.orgId);
      if (info.changes !== 1) return false;
      db.prepare('INSERT INTO contact_lease_uses (id, org_id, lease_id, used_at, transport, outcome) VALUES (?, ?, ?, ?, ?, ?)')
        .run(store.gid('cu'), ctx.orgId, row.id, nowIso(), String(transport || 'unspecified').slice(0, 64), 'released');
      // P3: every released lease is a touchpoint (ref = lease id, no content), atomic with the use.
      tpId = store.addTouchpoint(ctx.orgId, contact, {
        surface: 'contactsq', direction: 'outbound', ref: row.id, outcome: row.projection === 'dial' ? 'dial_released' : 'send_released',
        agent_id: row.subject_type === 'agent' ? row.subject_id : null, user_id: row.subject_type === 'user' ? row.subject_id : null,
      }).id;
      return true;
    })();
    if (!claimed) return err(410, 'lease_unusable');
    emit('quox.contacts.lease.redeemed', ctx, { contact_id: contact.id, channel: row.channel, bi_ref: cx.biRef(ident.blind_index), lease_id: row.id });
    emit('quox.contacts.touchpoint', ctx, { contact_id: contact.id, surface: 'contactsq', direction: 'outbound', touchpoint_id: tpId, outcome: row.projection === 'dial' ? 'dial_released' : 'send_released', lease_id: row.id });
    return { status: 200, json: { value, channel: row.channel } };
  }

  function revoke(ctx, leaseId) {
    const row = getLeaseRow(ctx.orgId, leaseId);
    if (!row) return err(404, 'not_found');
    const s = subjectOf(ctx);
    const own = ctx.actor === 'agent' && row.subject_type === 'agent' && row.subject_id === s.id;
    if (ctx.actor !== 'human' && !own) return err(403, 'forbidden');
    const info = store.getDb().prepare("UPDATE contact_leases SET status = 'revoked', revoked_at = ? WHERE id = ? AND org_id = ? AND status = 'active'")
      .run(nowIso(), row.id, ctx.orgId);
    if (!info.changes) return err(409, 'lease_not_active');
    emit('quox.contacts.lease.revoked', ctx, { contact_id: row.contact_id, channel: row.channel, lease_id: row.id, outcome: 'revoked' });
    return { status: 200, json: { lease: leaseJson(getLeaseRow(ctx.orgId, row.id)) } };
  }

  function list(ctx, { contact_id } = {}) {
    if (ctx.actor !== 'human') return err(403, 'human_required');
    const db = store.getDb();
    const rows = contact_id
      ? db.prepare('SELECT * FROM contact_leases WHERE org_id = ? AND contact_id = ? ORDER BY requested_at DESC LIMIT 200').all(ctx.orgId, String(contact_id))
      : db.prepare('SELECT * FROM contact_leases WHERE org_id = ? ORDER BY requested_at DESC LIMIT 200').all(ctx.orgId);
    const uses = db.prepare('SELECT lease_id, used_at, transport, outcome FROM contact_lease_uses WHERE org_id = ? AND lease_id = ? ORDER BY used_at ASC');
    return { status: 200, json: { leases: rows.map((r) => ({ ...leaseJson(r), uses: uses.all(ctx.orgId, r.id) })) } };
  }

  /** Atomically claim queued dial jobs (org-agnostic; the bridge serves several orgs). SERVICE only (caller enforces). */
  function claimDialJobs(limit = 20) {
    const db = store.getDb();
    return db.transaction(() => {
      const now = nowIso();
      const rows = db.prepare(
        "SELECT * FROM contact_leases WHERE projection = 'dial' AND status = 'active' AND dial_state = 'queued' AND expires_at > ? ORDER BY requested_at ASC LIMIT ?"
      ).all(now, limit);
      const jobs = [];
      for (const r of rows) {
        const info = db.prepare("UPDATE contact_leases SET dial_state = 'claimed', claimed_at = ? WHERE id = ? AND dial_state = 'queued'").run(now, r.id);
        if (info.changes !== 1) continue;
        const contact = store.getContactRow(r.org_id, r.contact_id);
        const dek = contact ? store.dekFor(contact) : null;
        let reason = '';
        if (dek && r.reason_ciphertext) { try { reason = cx.decryptField(dek, r.reason_ciphertext, store.bindOf(r.org_id, r.contact_id, `reason:${r.id}`)); } catch { reason = ''; } }
        jobs.push({ lease_id: r.id, org_id: r.org_id, contact_id: r.contact_id, reason });
      }
      return jobs;
    })();
  }

  // Long-poll waiters for the bridge's dial queue. A queued dial wakes them at once, so an idle wait does no
  // database work at all (it used to check every 500ms, which made the route look guilty in LoopWatchdog lines
  // as an always-in-flight request). A slow safety recheck covers a dial queued by another process.
  const dialWaiters = new Set();
  function wakeDialWaiters() { for (const w of [...dialWaiters]) w(); }

  async function dialQueue({ wait = 0, isAborted = () => false, recheckMs = 5000 } = {}) {
    const deadline = Date.now() + Math.min(Math.max(Number(wait) || 0, 0), 25) * 1000;
    for (;;) {
      const jobs = claimDialJobs();
      if (jobs.length) {
        for (const j of jobs) emit('quox.contacts.lease.claimed', { orgId: j.org_id, actor: 'service', agentId: 'dial-bridge' }, { contact_id: j.contact_id, lease_id: j.lease_id });
        return jobs.map(({ lease_id, org_id, reason }) => ({ lease_id, org_id, reason }));
      }
      const left = deadline - Date.now();
      if (left <= 0 || isAborted()) return [];
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); dialWaiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(left, recheckMs));
        dialWaiters.add(done);
      });
    }
  }

  return { mint, redeem, revoke, list, dialQueue, claimDialJobs, getLeaseRow, leaseJson };
}

module.exports = { createLeases, leaseJson, LEASE_TTL_MS };
