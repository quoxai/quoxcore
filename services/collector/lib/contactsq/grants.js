'use strict';

/**
 * ContactsQ standing grants (P1). A grant lets ONE named agent mint leases for
 * a projection/channel/purpose set without a per-call human approval, up to
 * max_uses_per_day (UTC day). It is consulted ONLY by the approval gate
 * (approvalGate.checkApproval), which records the decision with reserve().
 * The reservation lives in a module-private WeakMap keyed by the tool INPUT
 * OBJECT: nothing a caller puts inside the input (a field, a nested object, a
 * JSON string) can name a grant, because the lookup is by object identity.
 */

const store = require('./store.js');

const PROJECTIONS = ['dial', 'send', 'context'];
const CHANNELS_BY_PROJECTION = { dial: ['voice'], send: ['sms', 'email'], context: ['any'] };
const PURPOSES = ['service', 'transactional', 'marketing', 'research'];

const reservations = new WeakMap();
// P8B: batch inputs the tool already narrowed (an item was refused by policy). Such a batch
// is never grant-covered: a mixed batch always goes to a human. Keyed by object identity,
// set only by trusted tool code, so no input field can reach it.
const noGrantBatches = new WeakSet();
const BATCH_TOOLS = { contacts_dial_batch: 'dial', contacts_send_batch: 'send' };
const markNoGrant = (input) => { if (input && typeof input === 'object') noGrantBatches.add(input); };

const normSubject = (v) => String(v == null ? '' : v).trim().toLowerCase();

function rowToGrant(r) {
  return {
    id: r.id, org_id: r.org_id, subject_id: r.subject_id, projection: r.projection,
    channels: JSON.parse(r.channels_json), purposes: JSON.parse(r.purposes_json),
    max_uses_per_day: r.max_uses_per_day, granted_by: r.granted_by, created_at: r.created_at, revoked_at: r.revoked_at,
  };
}

function utcDayStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function usedToday(orgId, grantId, now) {
  return store.getDb().prepare(
    "SELECT COUNT(*) AS n FROM contact_leases WHERE org_id = ? AND decided_by = ? AND status != 'denied' AND requested_at >= ?"
  ).get(orgId, `policy:${grantId}`, utcDayStart(now)).n;
}

/** Map a gated tool call to the {projection, channel, purpose} it would mint. */
function leaseShapeOfTool(toolName, input) {
  const purpose = typeof input?.purpose === 'string' && input.purpose ? input.purpose : 'service';
  if (toolName === 'contacts_dial') return { projection: 'dial', channel: 'voice', purpose };
  if (toolName === 'contacts_context') return { projection: 'context', channel: 'any', purpose };
  if (toolName === 'contacts_send') return { projection: 'send', channel: typeof input?.channel === 'string' ? input.channel : '', purpose };
  return null;
}

/** covers(orgId, agentId, {projection, channel, purpose}) -> grant | null (null also when at/over cap). */
function covers(orgId, agentId, shape, now = Date.now()) {
  const subject = normSubject(agentId);
  if (!orgId || !subject || subject === '*' || !shape) return null;
  const rows = store.getDb().prepare(
    'SELECT * FROM contact_standing_grants WHERE org_id = ? AND subject_id = ? AND projection = ? AND revoked_at IS NULL ORDER BY created_at ASC'
  ).all(orgId, subject, shape.projection);
  for (const r of rows) {
    const g = rowToGrant(r);
    if (!g.channels.includes(shape.channel) || !g.purposes.includes(shape.purpose)) continue;
    if (usedToday(orgId, g.id, now) >= g.max_uses_per_day) continue;
    return g;
  }
  return null;
}

/** Gate-side entry: derive the shape from the tool call. */
function coversToolCall(toolName, orgId, agentId, input) {
  if (BATCH_TOOLS[toolName]) return coversBatch(toolName, orgId, agentId, input);
  const shape = leaseShapeOfTool(toolName, input);
  const g = covers(orgId, agentId, shape);
  if (!g) return null;
  // P2: a standing grant only skips the gate when policy says 'allow'. approval_required
  // (quiet hours, minor, ...) or deny falls through to the normal proposal, and no grant
  // use is consumed (the reservation is made only after this returns a grant).
  try {
    const store = require('./store.js');
    const policy = require('./policy.js');
    const contact = store.getContactRow(orgId, input && input.contact_id);
    if (!contact) return null;
    // P5: a context lease has no channel to evaluate; its own policy (human_only / deceased / minor / complainant) decides.
    if (shape.projection === 'context') return require('./p5.js').contextAllowed(orgId, contact.id) ? g : null;
    const res = policy.evaluate(orgId, contact, { purpose: shape.purpose, channel: shape.channel, subject: { type: 'agent' } });
    return res.decision === 'allow' ? g : null;
  } catch (e) {
    console.warn('[contactsq] grant policy check failed (falling back to a proposal):', e && e.message);
    return null;
  }
}

/**
 * P8B: a grant covers a batch only if ONE grant covers every item's shape, EVERY item is
 * policy 'allow', and the whole batch fits under today's cap (all items counted at once).
 * Anything else returns null and the batch goes to a human.
 */
function coversBatch(toolName, orgId, agentId, input, now = Date.now()) {
  const projection = BATCH_TOOLS[toolName];
  const items = input && Array.isArray(input.items) ? input.items : null;
  if (!projection || !items || !items.length || noGrantBatches.has(input)) return null;
  const subject = normSubject(agentId);
  if (!orgId || !subject || subject === '*') return null;
  const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose : 'service';
  const shapes = items.map((it) => ({ projection, channel: projection === 'dial' ? 'voice' : (it && typeof it.channel === 'string' ? it.channel : ''), purpose }));
  try {
    const policy = require('./policy.js');
    for (const it of items) {
      const contact = store.getContactRow(orgId, it && it.contact_id);
      if (!contact) return null;
      const ch = projection === 'dial' ? 'voice' : it.channel;
      if (policy.evaluate(orgId, contact, { purpose, channel: ch, subject: { type: 'agent' } }).decision !== 'allow') return null;
    }
  } catch (e) {
    console.warn('[contactsq] batch grant policy check failed (falling back to a proposal):', e && e.message);
    return null;
  }
  const rows = store.getDb().prepare(
    'SELECT * FROM contact_standing_grants WHERE org_id = ? AND subject_id = ? AND projection = ? AND revoked_at IS NULL ORDER BY created_at ASC'
  ).all(orgId, subject, projection);
  for (const r of rows) {
    const g = rowToGrant(r);
    if (!shapes.every((s) => g.channels.includes(s.channel) && g.purposes.includes(s.purpose))) continue;
    if (usedToday(orgId, g.id, now) + items.length > g.max_uses_per_day) continue;
    return g;
  }
  return null;
}

/** Only the approval gate calls this. */
function reserve(input, grant, orgId, agentId) {
  if (!input || typeof input !== 'object') return;
  reservations.set(input, { grantId: grant.id, orgId, agentId: normSubject(agentId) });
}

/** Tool-side: consume the reservation for THIS input object, org and agent only. */
function takeReservation(input, orgId, agentId) {
  const r = input && typeof input === 'object' ? reservations.get(input) : null;
  if (!r) return null;
  reservations.delete(input);
  if (r.orgId !== orgId || r.agentId !== normSubject(agentId)) return null;
  return r.grantId;
}

function validateGrant(b) {
  const subject = normSubject(b.subject_id);
  if (!subject || subject === '*' || subject.length > 64 || /[*\s]/.test(subject)) return { error: 'invalid_subject_id' };
  if (!PROJECTIONS.includes(b.projection)) return { error: 'invalid_projection' };
  const allowed = CHANNELS_BY_PROJECTION[b.projection];
  if (!Array.isArray(b.channels) || !b.channels.length || b.channels.some((c) => !allowed.includes(c))) return { error: 'invalid_channels' };
  if (!Array.isArray(b.purposes) || !b.purposes.length || b.purposes.some((p) => !PURPOSES.includes(p))) return { error: 'invalid_purposes' };
  if (!Number.isInteger(b.max_uses_per_day) || b.max_uses_per_day < 1 || b.max_uses_per_day > 500) return { error: 'invalid_max_uses_per_day' };
  return { ok: { subject_id: subject, projection: b.projection, channels: [...new Set(b.channels)], purposes: [...new Set(b.purposes)], max_uses_per_day: b.max_uses_per_day } };
}

/** CLI convenience preset: receptionist = dial, voice, service, 20/day. */
function applyPreset(b) {
  if (b.preset === undefined) return { body: b };
  if (b.preset !== 'receptionist') return { error: 'invalid_preset' };
  return { body: { subject_id: b.subject_id, projection: 'dial', channels: ['voice'], purposes: ['service'], max_uses_per_day: 20 } };
}

function createGrant(orgId, g, grantedBy) {
  const id = store.gid('sg');
  store.getDb().prepare(`
    INSERT INTO contact_standing_grants (id, org_id, subject_id, projection, channels_json, purposes_json, max_uses_per_day, granted_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, g.subject_id, g.projection, JSON.stringify(g.channels), JSON.stringify(g.purposes), g.max_uses_per_day, grantedBy || null, new Date().toISOString());
  return getGrant(orgId, id);
}

function getGrant(orgId, id) {
  const r = store.getDb().prepare('SELECT * FROM contact_standing_grants WHERE org_id = ? AND id = ?').get(orgId, String(id));
  return r ? rowToGrant(r) : null;
}

function listGrants(orgId) {
  return store.getDb().prepare('SELECT * FROM contact_standing_grants WHERE org_id = ? ORDER BY created_at DESC').all(orgId).map(rowToGrant);
}

function revokeGrant(orgId, id) {
  const info = store.getDb().prepare('UPDATE contact_standing_grants SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), orgId, String(id));
  return info.changes ? getGrant(orgId, id) : null;
}

module.exports = {
  covers, coversToolCall, coversBatch, markNoGrant, reserve, takeReservation, usedToday, leaseShapeOfTool,
  validateGrant, applyPreset, createGrant, getGrant, listGrants, revokeGrant,
  PROJECTIONS, PURPOSES, CHANNELS_BY_PROJECTION,
};
