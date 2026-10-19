'use strict';

/**
 * devSlotBroadcast.js, QUOXON-BROADCAST: one call fans a message out to the org's held slots.
 *
 * Org scoping is structural: recipients come ONLY from devSlots.listSlots/getSlot with the
 * caller's orgId, so a broadcast can never reach a slot in an org the sender cannot post to.
 * Delivery status per slot:
 *   delivered  the line is stored in the slot; listening sessions get it from the slot stream at once
 *   failed     the line could not be stored
 *   unknown    (--slots only) no such slot in this org
 * The chat-room copy (Matrix/Discord bridge) is a separate `room` field: sent | sending | failed.
 * A slow or failed room copy never downgrades `delivered`. GET status reflects the bridge as it finishes.
 * Receipt (status) and acknowledgement (acked_at) are tracked separately. Execution tracking
 * is v2. Bridges to Telegram/Discord are deliberately not fanned out in v1.
 */
const crypto = require('crypto');

const PRIORITIES = ['normal', 'urgent'];
const MAX_TEXT = 4000;

function newBroadcastId() { return `bc_${crypto.randomBytes(5).toString('hex')}`; }

/** The text a recipient sees. Stable, parseable by the TUI (cli/lib/quoxon/slash/broadcast.js). */
function formatBroadcast({ id, text, sender, priority, ack }) {
  const head = priority === 'urgent' ? '\u{1F6A8} URGENT BROADCAST' : '\u{1F4E3} BROADCAST';
  return `${head} from ${sender || 'someone'}: ${text}${ack ? `\n(ack with /ack ${id})` : ''}`;
}

function createDevSlotBroadcast({ getDb, devSlots, devSlotMessages, relay = null, relayBudgetMs = 1500, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function' || !devSlots || !devSlotMessages) throw new Error('createDevSlotBroadcast: getDb, devSlots, devSlotMessages required');
  const db = () => { const h = getDb(); if (!h) throw new Error('devSlotBroadcast: db not available'); return h; };

  /** Start the room copy. -> { room, detail?, settle? } ; settle (a promise) resolves once a pending copy finishes. */
  async function roomCopy(slot, text, from) {
    if (!slot.matrix_room_id) return { room: 'sending', detail: 'room pending' };
    if (typeof relay !== 'function') return { room: 'sent' };
    let timer;
    const p = Promise.resolve().then(() => relay({ slot, text, from })).then(() => ({ room: 'sent' }), (e) => ({ room: 'failed', detail: `room copy failed: ${e && e.message ? e.message : 'relay failed'}` }));
    try {
      const r = await Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(null), relayBudgetMs); })]);
      if (r) return r;
      return { room: 'sending', detail: 'bridge still sending', settle: p };
    } finally { clearTimeout(timer); }
  }

  async function broadcast({ orgId, text, from, identity, slots = null, priority = 'normal', ack = false } = {}) {
    if (!orgId) throw new Error('broadcast: orgId is required');
    const body = String(text || '').trim();
    if (!body) return { ok: false, status: 400, error: 'text is required' };
    if (body.length > MAX_TEXT) return { ok: false, status: 400, error: `text is over ${MAX_TEXT} characters` };
    if (!PRIORITIES.includes(priority)) return { ok: false, status: 400, error: `priority must be one of ${PRIORITIES.join(', ')}` };
    let targets; const unknown = [];
    if (Array.isArray(slots) && slots.length) {
      targets = [];
      for (const n of [...new Set(slots.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]) {
        const s = devSlots.getSlot({ orgId, name: n });
        if (!s) unknown.push(n); else targets.push(s);
      }
    } else {
      targets = devSlots.listSlots({ orgId }).filter((s) => s.state === 'held' && s.holder_session);
    }
    const id = newBroadcastId();
    const t = now();
    const wire = formatBroadcast({ id, text: body, sender: from, priority, ack: !!ack });
    db().prepare('INSERT INTO dev_slot_broadcasts (id, org_id, text, sender, sender_identity, priority, ack_required, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, orgId, body, from || null, identity || null, priority, ack ? 1 : 0, t);
    const ins = db().prepare('INSERT INTO dev_slot_broadcast_deliveries (broadcast_id, org_id, slot_id, slot_name, status, message_id, detail, room) VALUES (?,?,?,?,?,?,?,?)');
    const rows = await Promise.all(targets.map(async (slot) => {
      let rec;
      try {
        rec = devSlotMessages.appendMessage({ orgId, slotId: slot.id, slotName: slot.name, from, authorIdentity: identity, text: wire, source: 'broadcast' });
      } catch (e) {
        ins.run(id, orgId, slot.id, slot.name, 'failed', null, e.message, null);
        return { slot: slot.name, status: 'failed', detail: e.message };
      }
      let rc;
      try { rc = await roomCopy(slot, wire, from); } catch (e) { rc = { room: 'failed', detail: `room copy failed: ${e.message}` }; }
      ins.run(id, orgId, slot.id, slot.name, 'delivered', rec.id, rc.detail || null, rc.room);
      if (rc.settle) {
        rc.settle.then((f) => {
          try {
            db().prepare('UPDATE dev_slot_broadcast_deliveries SET room = ?, detail = ? WHERE broadcast_id = ? AND org_id = ? AND slot_name = ?')
              .run(f.room, f.detail || null, id, orgId, slot.name);
          } catch { /* db closed: the slot already has the message; only the room flag is lost */ }
        });
      }
      return { slot: slot.name, status: 'delivered', room: rc.room, ...(rc.detail ? { detail: rc.detail } : {}) };
    }));
    for (const n of unknown) {
      ins.run(id, orgId, null, n, 'unknown', null, 'no such slot in this org', null);
      rows.push({ slot: n, status: 'unknown', detail: 'no such slot in this org' });
    }
    return { ok: true, id, priority, ack: !!ack, created_at: t, deliveries: rows, counts: counts(rows, ack ? 0 : null) };
  }

  function counts(rows, acked) {
    const sent = rows.filter((r) => r.status === 'delivered');
    const out = {
      delivered: sent.length,
      failed: rows.filter((r) => r.status === 'failed' || r.status === 'unknown').length,
      total: rows.length,
      room: {
        sent: sent.filter((r) => r.room === 'sent').length,
        sending: sent.filter((r) => r.room === 'sending').length,
        failed: sent.filter((r) => r.room === 'failed').length,
      },
    };
    if (acked !== null && acked !== undefined) { out.acknowledged = acked; out.awaiting = sent.length - acked; }
    return out;
  }

  function status({ orgId, id } = {}) {
    const b = db().prepare('SELECT * FROM dev_slot_broadcasts WHERE id = ? AND org_id = ?').get(id, orgId);
    if (!b) return null;
    const del = db().prepare('SELECT * FROM dev_slot_broadcast_deliveries WHERE broadcast_id = ? AND org_id = ? ORDER BY slot_name').all(id, orgId);
    const deliveries = del.map((d) => ({ slot: d.slot_name, status: d.status === 'queued' ? 'delivered' : d.status, ...(d.status === 'failed' || d.status === 'unknown' ? {} : { room: d.room || 'sent' }), acked: !!d.acked_at, ...(d.acked_at ? { acked_at: d.acked_at, acked_by: d.acked_by } : {}), ...(d.detail ? { detail: d.detail } : {}) }));
    const acked = del.filter((d) => d.acked_at).length;
    const c = counts(deliveries.map((d) => ({ status: d.status, room: d.room })), b.ack_required ? acked : null);
    return { id: b.id, text: b.text, sender: b.sender, priority: b.priority, ack_required: !!b.ack_required, created_at: b.created_at, deliveries, counts: c };
  }

  function ack({ orgId, id, slot, by } = {}) {
    if (!orgId || !id || !slot) return { ok: false, status: 400, error: 'id and slot are required' };
    const b = db().prepare('SELECT ack_required FROM dev_slot_broadcasts WHERE id = ? AND org_id = ?').get(id, orgId);
    if (!b) return { ok: false, status: 404, error: 'unknown broadcast' };
    const name = String(slot).trim().toLowerCase();
    const info = db().prepare(`UPDATE dev_slot_broadcast_deliveries SET acked_at = COALESCE(acked_at, ?), acked_by = COALESCE(acked_by, ?)
      WHERE broadcast_id = ? AND org_id = ? AND slot_name = ? AND status IN ('delivered','queued')`).run(now(), by || null, id, orgId, name);
    if (!info.changes) return { ok: false, status: 404, error: 'that slot was not a recipient of this broadcast' };
    return { ok: true, status: 200, broadcast: status({ orgId, id }) };
  }

  return { broadcast, status, ack };
}

module.exports = { createDevSlotBroadcast, formatBroadcast, PRIORITIES };
