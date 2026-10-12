'use strict';

/**
 * devSlotWait.js — DEVSUITE-SLOTS wait verb: server-side long-poll behind
 * GET /api/v1/slots/:name/wait (CLI: quox slot wait <name>).
 *
 * Why this exists (2026-08-22 incident, quoxperticus-126 day one): slot
 * read-back is pull, so a holding session that never polls is deaf to its
 * own channel — the owner's Discord replies sat unread. The fleet answer
 * was a hand-rolled per-session watcher script; the PRODUCT answer is one
 * governed call that blocks until a message lands, heartbeating the hold
 * while it waits, so a single background `quox slot wait` keeps a resident
 * both held-fresh and wake-on-message.
 *
 * Same DI shape as devSlotMessagesStore.js: bound to its deps via
 * createDevSlotWait so tests drive the loop with fake stores and a fake
 * clock. The route stays a thin wrapper.
 */

// Route ceiling: stay under typical proxy idle timeouts (nginx 60s).
const MAX_WAIT_MS = 55 * 1000;
const DEFAULT_WAIT_MS = 50 * 1000;
// Heartbeat the hold at most this often while waiting (the slot TTL is
// minutes, so once per wait window is plenty; re-armed across calls by the
// CLI loop).
const HEARTBEAT_EVERY_MS = 45 * 1000;
// How far back a wait with no `since` looks for unread mail.
const BACKLOG_MAX_MS = 24 * 60 * 60 * 1000;

function createDevSlotWait({
  devSlots,
  devSlotMessages,
  now = () => new Date().toISOString(),
  // Cancellable timer: sleep(ms, signal) clears its timeout when the signal
  // aborts, so a woken waiter leaves no timer behind.
  sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }),
} = {}) {
  if (!devSlots || !devSlotMessages) {
    throw new Error('createDevSlotWait: devSlots and devSlotMessages stores are required');
  }

  /**
   * Block until a message newer than `since` (exclusive, ISO-8601) lands in
   * the slot, excluding messages whose `from` equals `excludeFrom` (the
   * caller's own says). Resolves at latest after the clamped timeout.
   *
   * Returns:
   *   { ok:false, code:'not_found' }                          unknown slot
   *   { ok:true, slot, messages, timedOut, cursor, held }     otherwise
   * `cursor` is the created_at high-water mark the caller should pass back
   * as `since` on its next call (also set on timeout, so filtered self-says
   * are never re-scanned). `held` is null when no holderSession was given.
   */
  async function waitForMessages({
    orgId, name, since, timeoutMs, excludeFrom, holderSession, memberKey, signal,
  } = {}) {
    if (!orgId || !name) throw new Error('waitForMessages: orgId and name are required');

    const slot = devSlots.getSlot({ orgId, name });
    if (!slot) return { ok: false, code: 'not_found' };

    const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);
    const startedAt = Date.parse(now());
    const deadline = startedAt + budget;

    // Default cursor (slots audit 2026-10-03, owner: "seer reattached and it
    // didnt reply"): starting at NOW skipped everything that landed before the
    // listener was armed, i.e. a reply sent between checkout and the first
    // wait, while a session was answering and re-arming, or just before a
    // re-attach. Start from the slot's last read instead, capped at 24h, and
    // let that pre-arm backlog carry only human-sourced lines (a previous
    // holder's `say` milestones are not mail for whoever holds it now).
    let backlogUntil = null;
    let cursor = since;
    if (!cursor) {
      const floor = new Date(startedAt - BACKLOG_MAX_MS).toISOString();
      const lastRead = slot.last_read_at || null;
      cursor = lastRead && lastRead > floor ? lastRead : floor;
      backlogUntil = new Date(startedAt).toISOString();
    }
    let held = null;
    let lastHeartbeatAt = -Infinity;

    const heartbeat = () => {
      if (!holderSession) return;
      const t = Date.parse(now());
      if (t - lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
      lastHeartbeatAt = t;
      try {
        const r = devSlots.heartbeatSlot({ orgId, name, holderSession, memberKey });
        held = !!(r && r.ok);
      } catch {
        held = false; // a lapsed or contested hold must never break the wait
      }
    };

    // Event-driven (2026-10-11 loop-stall incident): a waiter used to poll
    // SQLite synchronously every tick, so N long-polls saturated the single
    // event loop. Now it subscribes to appendMessage notifications for this
    // slot, reads once up front and once per wake-up, and otherwise parks on
    // a single timer (next heartbeat or deadline). Every slot write goes
    // through devSlotMessages.appendMessage in this process (the only INSERT
    // into dev_slot_messages), so no cross-process fallback poll is needed.
    let dirty = false;
    let wake = null;
    const unsubscribe = typeof devSlotMessages.subscribe === 'function'
      ? devSlotMessages.subscribe({ orgId, slotId: slot.id }, () => { dirty = true; if (wake) wake(); })
      : null;

    const park = (ms) => new Promise((resolve) => {
      const ac = new AbortController();
      const done = () => {
        wake = null;
        ac.abort();
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      };
      wake = done;
      if (signal) signal.addEventListener('abort', done, { once: true });
      Promise.resolve(sleep(ms, ac.signal)).then(done);
    });

    try {
      for (;;) {
        heartbeat();
        dirty = false;

        const batch = devSlotMessages.listMessages({ orgId, slotId: slot.id, since: cursor, limit: 100 });
        if (batch.length) {
          // Advance past everything seen, INCLUDING filtered self-says, so the
          // next read (or the next call resuming from `cursor`) never re-reads.
          cursor = batch[batch.length - 1].created_at;
          const inbound = batch.filter((m) => (!excludeFrom || m.from !== excludeFrom)
            && !(backlogUntil && m.created_at <= backlogUntil && m.source === 'say'));
          if (inbound.length) {
            return { ok: true, slot, messages: inbound, timedOut: false, cursor, held };
          }
        }

        const t = Date.parse(now());
        if (t >= deadline) return { ok: true, slot, messages: [], timedOut: true, cursor, held };
        if (signal && signal.aborted) return { ok: true, slot, messages: [], timedOut: true, aborted: true, cursor, held };
        if (dirty) continue; // a write landed while we were reading
        const untilHeartbeat = holderSession ? Math.max(lastHeartbeatAt + HEARTBEAT_EVERY_MS - t, 1) : Infinity;
        await park(Math.max(Math.min(deadline - t, untilHeartbeat), 1));
      }
    } finally {
      if (unsubscribe) unsubscribe();
    }
  }

  return { waitForMessages };
}

module.exports = { createDevSlotWait };
