'use strict';

/**
 * devSlotStream.js — QUOXON-MESH: GET /api/v1/slots/:name/stream.
 *
 * Owner, 2026-10-14: "it would be cool if session to session messaging was
 * faster, more responsive... instant... like chat". The wait long-poll wakes
 * on a message but then closes, so a window that keeps listening pays a
 * reconnect (and a read) per message. This is the push form: one long-lived
 * Server-Sent Events response per listening window, fed by the SAME
 * in-process notify bus the long-poll uses (devSlotMessages.subscribe; every
 * slot write goes through appendMessage in this process, and the record rides
 * the event).
 *
 * Built against the 2026-10-10/11 slot-wait CPU incident:
 *  - zero DB work per pushed message (the record arrives on the event)
 *  - one replay read at connect, and only when the caller passes `since`
 *  - no polling at all; a ping comment keeps proxies from idling it out
 *  - connection caps per org and in total (429), so a reconnect storm or a
 *    leaked client cannot pile up listeners
 *  - a max lifetime: the server ends the stream and the client reconnects
 *    with its cursor, so no response lives forever
 *  - every exit path (client close, lifetime, write error) unsubscribes and
 *    clears timers exactly once
 * No AEE envelope: like wait, the messages themselves are witnessed at
 * say/inbound; a subscription has no evidentiary value.
 */

const { cursorOf, isAfterCursor } = require('./devSlotMessagesStore.js');

const DEFAULTS = {
  pingMs: 25 * 1000,               // under nginx's 60s idle timeout
  maxLifetimeMs: 30 * 60 * 1000,   // client reconnects with its cursor
  maxPerOrg: 50,
  maxTotal: 500,
  replayLimit: 100,
};

function createSlotStreamHandler({
  devSlots, devSlotMessages, resolveOrgId, roomMembers = null,
  pingMs = DEFAULTS.pingMs, maxLifetimeMs = DEFAULTS.maxLifetimeMs,
  maxPerOrg = DEFAULTS.maxPerOrg, maxTotal = DEFAULTS.maxTotal, replayLimit = DEFAULTS.replayLimit,
  corsOrigin = () => null, now = () => new Date().toISOString(),
} = {}) {
  if (!devSlots || !devSlotMessages || typeof devSlotMessages.subscribe !== 'function') {
    throw new Error('createSlotStreamHandler: devSlots and devSlotMessages (with subscribe) are required');
  }
  const perOrg = new Map();
  let total = 0;

  function handler(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    let slot;
    try { slot = devSlots.getSlot({ orgId, name: req.params.name }); } catch (err) {
      return res.status(500).json({ error: 'stream failed' });
    }
    if (!slot) return res.status(404).json({ error: 'unknown slot' });
    // QUOXON-ROOMS: the stream is for the holder or a room member of THIS org's slot. The caller
    // names its session; a non-member is refused (403), never silently given the room.
    const sess = typeof (req.query || {}).session === 'string' ? req.query.session : '';
    // Back-compat: callers that predate rooms (dashboard, Discord daemon, older CLIs) send no session and keep
    // their old access. The holder-or-member rule applies only when a session is named.
    if (roomMembers && sess) {
      const ok = slot.holder_session === sess || roomMembers.isMember({ orgId, slotId: slot.id, session: sess });
      if (!ok) return res.status(403).json({ error: 'not a room member', message: `join ${slot.name} first: quox slot join ${slot.name} --session <you>` });
    } else if (roomMembers) {
      console.warn('[SlotStream] legacy stream without session');
    }
    if (total >= maxTotal || (perOrg.get(orgId) || 0) >= maxPerOrg) {
      return res.status(429).json({ error: 'too many slot streams', message: 'Too many open slot streams; retry shortly.' });
    }
    total += 1; perOrg.set(orgId, (perOrg.get(orgId) || 0) + 1);

    const q = req.query || {};
    const excludeFrom = typeof q.exclude_from === 'string' && q.exclude_from ? q.exclude_from : null;
    const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
    const origin = corsOrigin(req);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    res.writeHead(200, headers);

    let done = false;
    const replayFrom = typeof q.since === 'string' && q.since ? q.since : null;
    // With no `since` the client gets the SERVER's now as its cursor, so a reconnect resumes
    // from here without trusting the client clock and without missing the gap.
    let cursor = replayFrom || now();
    const sentIds = new Set(); // a replayed row the bus also delivers goes out once
    let unsubscribe = () => {};
    let ping = null; let life = null;

    const end = () => {
      if (done) return;
      done = true;
      clearInterval(ping); clearTimeout(life);
      try { unsubscribe(); } catch { /* already gone */ }
      total -= 1;
      const n = (perOrg.get(orgId) || 1) - 1;
      if (n > 0) perOrg.set(orgId, n); else perOrg.delete(orgId);
      if (!res.writableEnded) { try { res.end(); } catch { /* socket gone */ } }
    };
    const write = (s) => {
      if (done || res.writableEnded) return;
      try { res.write(s); } catch { end(); }
    };
    const send = (m) => {
      if (!m || done) return;
      if (m.id && sentIds.has(m.id)) return;
      if (m.id) { sentIds.add(m.id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); }
      // The cursor names the message (created_at|seq), so a reconnect never skips a same-millisecond sibling.
      if (m.created_at && isAfterCursor(m, cursor, { inclusive: true })) cursor = cursorOf(m);
      if (excludeFrom && (m.from === excludeFrom || String(m.from || '').startsWith(`${excludeFrom} (`))) return;
      write(`id: ${cursorOf(m) || ''}\ndata: ${JSON.stringify({ type: 'slot.message', slot: slot.name, message: m })}\n\n`);
    };

    // Subscribe BEFORE the replay read, in the same tick: nothing appended in
    // between can be missed, and a duplicate is dropped by id.
    unsubscribe = devSlotMessages.subscribe({ orgId, slotId: slot.id, session: sess || null }, (rec) => {
      if (rec && typeof rec === 'object') send(rec);
    });
    write(`retry: 2000\ndata: ${JSON.stringify({ type: 'connected', slot: slot.name, cursor })}\n\n`);
    if (replayFrom) {
      try {
        for (const m of devSlotMessages.listMessages({ orgId, slotId: slot.id, since: replayFrom, limit: replayLimit })) send(m);
      } catch (err) {
        write(`data: ${JSON.stringify({ type: 'error', error: 'replay failed' })}\n\n`);
      }
    }
    ping = setInterval(() => write(': ping\n\n'), pingMs);
    if (ping.unref) ping.unref();
    life = setTimeout(() => { write(`data: ${JSON.stringify({ type: 'reconnect', cursor })}\n\n`); end(); }, maxLifetimeMs);
    if (life.unref) life.unref();
    res.on('close', end);
    res.on('error', end);
    return undefined;
  }
  handler.stats = () => ({ open: total, orgs: perOrg.size });
  return handler;
}

module.exports = { createSlotStreamHandler, DEFAULTS };
