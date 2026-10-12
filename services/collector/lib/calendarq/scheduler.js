'use strict';

/**
 * Calendar-Q background sync scheduler (L2-C1).
 *
 * Same shape as lib/inboxq/scheduler.js: DARK by default (no timer unless
 * CALENDARQ_SYNC_ENABLED='1', an operator kill-switch), warmup setTimeout
 * before the first tick, and a cadence read from CALENDARQ_SYNC_TICK_MS
 * (default 5 minutes, registered in services/shared/envRegistry.cjs). The
 * triad (failure accounting, backoff, retirement) lives entirely in
 * runSync/store — this module only decides WHEN to call it, and fans the
 * tick out across every active connection, in every org. Timers are
 * .unref()'d so they never hold the process open; a container restart
 * cannot re-arm a wedge because nothing runs until CALENDARQ_SYNC_ENABLED
 * is explicitly set.
 */

const { runSync } = require('./syncWorker');
const store = require('./store');
const { sweepStuckAttempted } = require('./reconcile');

const DEFAULT_WARMUP_MS = 60 * 1000;
const DEFAULT_TICK_MS = 5 * 60 * 1000;

function resolveTickMs() {
  const n = Number(process.env.CALENDARQ_SYNC_TICK_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICK_MS;
}

/**
 * @param {object} deps
 * @param {Function} [deps.fetchImpl] injectable fetch (tests only — the real
 *   collector process never overrides this)
 * @param {Function} [deps.now] () -> ms, injectable clock for tests
 * @param {Function} [deps.logger]
 */
function createCalendarqScheduler(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => Date.now());
  const log = deps.logger || ((m) => console.log(m));
  let warmup = null;
  let timer = null;

  async function tick() {
    let connections = [];
    try {
      connections = store.listAllActiveConnections();
    } catch (e) {
      // AQ-9B audit fix 6: a store read failure must not crash the loop, but
      // silently returning the SAME shape an idle org produces hides a real
      // outage behind "nothing to do" — log it first.
      log(`[calendarq] tick store read failed: ${e.message}`);
      return { connections: 0, synced: 0 };
    }
    let synced = 0;
    for (const conn of connections) {
      try {
        const r = await runSync(conn.orgId, conn.id, { fetchImpl, nowMs: now() });
        if (r && r.complete) synced += 1;
      } catch {
        // runSync's own triad already recorded this failure against the
        // connection — a tick must never crash on one bad connection.
      }
    }
    return { connections: connections.length, synced };
  }

  function start() {
    if (process.env.CALENDARQ_SYNC_ENABLED !== '1') {
      log('[calendarq] scheduler DARK (CALENDARQ_SYNC_ENABLED != 1); manual sync only');
      return;
    }
    const tickMs = resolveTickMs();
    warmup = setTimeout(() => {
      // L2-C2: a restart sweep for anything left stuck 'attempted' by a
      // crash mid-create — durable (reconcile.js's own backoff bookkeeping
      // applies per-op) and capped, never a second unbounded loop.
      sweepStuckAttempted({ fetchImpl, nowMs: now() }).catch(() => {});
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      if (timer.unref) timer.unref();
    }, DEFAULT_WARMUP_MS);
    if (warmup.unref) warmup.unref();
    log(`[calendarq] scheduler armed (tick ${tickMs}ms)`);
  }

  function stop() {
    if (warmup) clearTimeout(warmup);
    if (timer) clearInterval(timer);
    warmup = null;
    timer = null;
  }

  return { start, stop, tick };
}

module.exports = { createCalendarqScheduler, DEFAULT_TICK_MS, resolveTickMs };
