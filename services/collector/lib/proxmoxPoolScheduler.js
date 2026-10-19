'use strict';

/**
 * Proxmox VM pool scheduler (DEVFLEET-P10). One tick per 5 minutes for every org
 * with the pool enabled: reap expired leases, then warm to target.
 *
 * Loop hygiene (the triad, house reference: quoxbrain embeddingBackfillScheduler):
 *   1. Failures are counted DISTINCTLY from no-op ticks. "Nothing to do" is a noop;
 *      a failed build/reap is a failure and is logged as such.
 *   2. A tick that did work-needing-failures with zero progress backs that org off for
 *      a growing, CAPPED number of ticks (1, 2, 4 ... MAX_BACKOFF_TICKS).
 *   3. A VM that fails to build is marked failed inside the pool (retired, destroyed
 *      best effort) and never retried; a pending approval pauses the org's warming.
 * Not boot-triggered: start() only arms the interval, with no startup timer, so a
 * restart never re-arms a wedge. The interval is unref()'d.
 */

const TICK_MS = 5 * 60 * 1000;
const MAX_BACKOFF_TICKS = 12; // 1h at the default cadence

function createProxmoxPoolScheduler({ pool, store, tickMs = TICK_MS, logger, maxBackoffTicks = MAX_BACKOFF_TICKS, awareness } = {}) {
  if (!pool || typeof pool.maintain !== 'function') throw new Error('createProxmoxPoolScheduler requires pool.maintain');
  const log = logger || ((m) => console.log(m));
  const st = store || pool.store;
  const orgState = new Map(); // org -> { streak, backoff }
  // LUCID awareness (DEVFLEET-B4). Optional: a pool without status() (old test doubles) simply has none.
  let aware = awareness || null;
  if (!aware && typeof pool.status === 'function') {
    try { aware = require('./proxmoxPoolAwareness.js').createPoolAwareness({ pool, tickMs, logger: log }); } catch (e) { log(`[ProxmoxPool] LUCID awareness unavailable: ${e && e.message}`); }
  }
  function observe(orgId, result) {
    if (!aware) return;
    try { aware.observe(orgId, result); } catch (e) { log(`[ProxmoxPool] LUCID observe failed org=${orgId}: ${e && e.message}`); }
  }
  const totals = { ticks: 0, noop: 0, progress: 0, failed_ticks: 0, failures: 0, skipped_backoff: 0 };
  let timer = null;
  let running = false;

  async function tickOrg(orgId) {
    const s = orgState.get(orgId) || { streak: 0, backoff: 0 };
    orgState.set(orgId, s);
    if (s.backoff > 0) {
      s.backoff -= 1;
      totals.skipped_backoff += 1;
      log(`[ProxmoxPool] org=${orgId} tick skipped: backing off after ${s.streak} consecutive failing tick(s), ${s.backoff} tick(s) remaining`);
      return { orgId, outcome: 'backoff' };
    }
    let r;
    try {
      r = await pool.maintain(orgId);
    } catch (e) {
      r = { reaped: 0, built: 0, failed: 1, errors: [e && e.message ? e.message : String(e)], noop: false };
    }
    const progress = (r.reaped || 0) + (r.built || 0);
    if (r.failed > 0) {
      totals.failures += r.failed;
      if (progress === 0) {
        s.streak += 1;
        s.backoff = Math.min(2 ** (s.streak - 1), maxBackoffTicks);
        totals.failed_ticks += 1;
        log(`[ProxmoxPool] org=${orgId} tick FAILED: ${r.failed} failure(s), no progress (streak ${s.streak}, backing off ${s.backoff} tick(s)): ${(r.errors || []).join('; ')}`);
        return { orgId, outcome: 'failed', ...r };
      }
      s.streak = 0; s.backoff = 0;
      totals.progress += 1;
      log(`[ProxmoxPool] org=${orgId} tick partial: reaped ${r.reaped}, built ${r.built}, ${r.failed} failure(s): ${(r.errors || []).join('; ')}`);
      return { orgId, outcome: 'partial', ...r };
    }
    s.streak = 0; s.backoff = 0;
    if (progress > 0) {
      totals.progress += 1;
      log(`[ProxmoxPool] org=${orgId} tick ok: reaped ${r.reaped}, built ${r.built}`);
      return { orgId, outcome: 'progress', ...r };
    }
    totals.noop += 1;
    if (r.skipped) log(`[ProxmoxPool] org=${orgId} tick noop (${r.skipped})`);
    return { orgId, outcome: 'noop', ...r };
  }

  /** Run one tick over every enabled org. Single-flight: an overlapping tick is skipped. */
  async function tick() {
    if (running) { log('[ProxmoxPool] tick skipped: previous tick still running'); return []; }
    running = true;
    totals.ticks += 1;
    const results = [];
    try {
      let orgs = [];
      try { orgs = st.listEnabledOrgs(); } catch (e) { totals.failures += 1; log(`[ProxmoxPool] tick FAILED: could not list enabled orgs: ${e.message}`); return results; }
      for (const orgId of orgs) { const r = await tickOrg(orgId); observe(orgId, r); results.push(r); }
    } finally { running = false; }
    return results;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log(`[ProxmoxPool] tick crashed: ${e && e.message}`)); }, tickMs);
    if (timer.unref) timer.unref();
    log(`[ProxmoxPool] scheduler armed (every ${Math.round(tickMs / 1000)}s, orgs with the pool enabled only, no boot-time tick)`);
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick, tickOrg, totals, orgState };
}

module.exports = { createProxmoxPoolScheduler, TICK_MS, MAX_BACKOFF_TICKS };
