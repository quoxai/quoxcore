'use strict';

/**
 * devSlotRoomTracker.js — QUOXON-MESH. A slot's Matrix room is provisioned asynchronously after create (auth
 * mints it, the collector writes the id back). Live 2026-10-14: "make a slot called quoxtest3" then "say hello
 * to the quoxtest3 slot" failed with "slot has no Matrix room yet". This makes provisioning:
 *  - deduped per slot (one in-flight provision, every caller shares it)
 *  - observable (waitForRoom: bounded wait for create/checkout to return with a room)
 *  - a delivery point: a say that landed before the room exists queues its ROOM RELAY here and is relayed, in
 *    order, the moment the room lands. The say itself never waits: the cache row and the stream push happen at
 *    say time, so windows and bridges see it at once; only the Matrix room copy is late.
 * In memory and bounded (per-slot cap, TTL), so a collector restart drops queued relays; the witnessed record
 * (cache row + envelope) is unaffected.
 */

function createSlotRoomTracker({
  provision, relay, maxQueue = 50, ttlMs = 10 * 60 * 1000, maxSlots = 1000, now = Date.now, log = console,
} = {}) {
  if (typeof provision !== 'function' || typeof relay !== 'function') {
    throw new Error('createSlotRoomTracker: provision and relay are required');
  }
  const inflightBySlot = new Map();
  const queues = new Map();
  const st = { relayed: 0, dropped: 0, failed: 0 };

  async function flush(slotId, roomId) {
    const q = queues.get(slotId);
    if (!q || !roomId) return 0;
    queues.delete(slotId);
    let n = 0;
    for (const item of q) {
      if (now() - item.at > ttlMs) { st.dropped += 1; continue; }
      try { await relay({ ...item.msg, roomId }); n += 1; st.relayed += 1; } catch (err) {
        st.failed += 1;
        log.warn && log.warn(`[DevSlots] queued relay for ${item.msg.slotName || slotId} failed (non-fatal): ${err.message}`);
      }
    }
    return n;
  }

  function trackedProvision(args) {
    const slotId = args && args.slotId;
    if (!slotId) return provision(args);
    if (inflightBySlot.has(slotId)) return inflightBySlot.get(slotId);
    let started;
    try { started = Promise.resolve(provision(args)); } catch (err) { started = Promise.reject(err); }
    const p = started
      .then((roomId) => { if (roomId) flush(slotId, roomId).catch(() => {}); return roomId; })
      .finally(() => { inflightBySlot.delete(slotId); });
    inflightBySlot.set(slotId, p);
    return p;
  }

  function enqueue(slotId, msg) {
    if (!slotId) return { queued: false, reason: 'no_slot' };
    let q = queues.get(slotId);
    if (!q) {
      if (queues.size >= maxSlots) return { queued: false, reason: 'too_many_slots' };
      q = []; queues.set(slotId, q);
    }
    if (q.length >= maxQueue) return { queued: false, reason: 'queue_full' };
    q.push({ msg, at: now() });
    return { queued: true, position: q.length };
  }

  /** The room id once the in-flight provision lands, or null (nothing in flight, failed, or past `ms`). */
  function waitForRoom(slotId, ms = 10000) {
    const p = inflightBySlot.get(slotId);
    if (!p) return Promise.resolve(null);
    let t;
    return Promise.race([
      p.then((r) => r || null, () => null),
      new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); if (t.unref) t.unref(); }),
    ]).finally(() => clearTimeout(t));
  }

  return {
    provision: trackedProvision,
    enqueue,
    flush,
    waitForRoom,
    inflight: (slotId) => inflightBySlot.has(slotId),
    pending: (slotId) => (queues.get(slotId) || []).length,
    stats: () => ({ ...st, queuedSlots: queues.size, inflight: inflightBySlot.size }),
  };
}

module.exports = { createSlotRoomTracker };
