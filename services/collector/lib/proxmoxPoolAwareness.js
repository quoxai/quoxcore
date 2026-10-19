'use strict';

/**
 * LUCID awareness for the Proxmox VM pool (DEVFLEET-B4). Called by the pool scheduler after
 * every per-org tick. It makes the pool legible without anyone asking:
 *
 *   - a heartbeat on feed `proxmox.pool` per enabled org per tick (silence stays detectable;
 *     the feed is declared expected so a stalled scheduler reads as silent, not absent);
 *   - one `ask` subject per condition that needs a person, retracted the tick it clears:
 *       vmpool:<org>:exhausted            no ready VM for 2 ticks while warming or leases are wanted
 *       vmpool:<org>:build-failing:<node> 3 consecutive failed builds in a lane
 *       vmpool:<org>:stuck:<vmid>         lease past expiry that the reaper could not destroy
 *       vmpool:<org>:grant                warming paused on a pending approval (lane grant missing or expired)
 *
 * Rules kept: subjects are stable ids; summaries are plain and carry NO volatile numbers (those live
 * in state, so an unchanged condition is a no-op write, not per-tick noise); asks are refreshed while
 * the condition holds and retracted when it clears; open asks are re-adopted from the journal after a
 * collector restart so a restart cannot orphan one. Nothing here throws into the scheduler.
 */

const FEED = 'proxmox.pool';
const EXHAUSTED_TICKS = 2;
const BUILD_FAIL_TICKS = 3;

function realLucid() {
  const emit = require('./lucid/emit.js');
  const journal = require('./lucid/journal.js');
  return {
    emit: emit.emit,
    isReady: () => journal.isReady(),
    declareExpected: (org, feeds) => journal.declareExpected(org, feeds),
    listOpen: (org) => journal.listOpenSubjects(org),
  };
}

function createPoolAwareness({ pool, lucid, now = () => Date.now(), tickMs = 5 * 60 * 1000, inBackupWindow, logger } = {}) {
  if (!pool || typeof pool.status !== 'function') throw new Error('createPoolAwareness requires pool.status');
  const L = lucid || realLucid();
  const winFn = inBackupWindow || require('./proxmoxPool.js').inBackupWindow;
  const log = logger || ((m) => console.log(m));
  const orgs = new Map(); // org -> { declared, adopted, raised:Set, exhaustedTicks, laneFails:Map, seen:Map }
  const stats = { beats: 0, asks: 0, retracts: 0, failures: 0 };

  function orgState(org) {
    let s = orgs.get(org);
    if (!s) { s = { declared: false, adopted: false, raised: new Set(), exhaustedTicks: 0, laneFails: new Map(), seen: new Map() }; orgs.set(org, s); }
    return s;
  }

  const send = (ev) => {
    try { return L.emit(ev); } catch (e) { stats.failures += 1; log(`[ProxmoxPool] LUCID emit failed for ${ev.subject || ev.kind}: ${e && e.message}`); return null; }
  };

  function ask(org, s, subject, summary, state) {
    send({ org_id: org, ledger: 'operational', subject, kind: 'ask', source: { surface: 'collector', feed: FEED },
      state: { status: state.status, ...state }, summary, salience: { needs: 'owner', gates: [] } });
    s.raised.add(subject); stats.asks += 1;
  }

  function observe(orgId, tickResult) {
    const s = orgState(orgId);
    let st = null; let readError = null;
    try { if (L.isReady && !L.isReady()) return { skipped: 'lucid not ready' }; } catch { return { skipped: 'lucid not ready' }; }
    try {
      if (!s.declared) { L.declareExpected(orgId, [FEED]); s.declared = true; }
      if (!s.adopted) {
        for (const o of L.listOpen(orgId) || []) if (String(o.subject).startsWith(`vmpool:${orgId}:`)) s.raised.add(o.subject);
        s.adopted = true;
      }
    } catch (e) { stats.failures += 1; log(`[ProxmoxPool] LUCID setup failed org=${orgId}: ${e && e.message}`); }
    try { st = pool.status(orgId); } catch (e) { readError = `could not read pool status: ${e && e.message}`; stats.failures += 1; }

    // Heartbeat first: the pool scheduler is alive even when the pool itself is unwell.
    send({ org_id: orgId, kind: 'heartbeat', ttl_s: Math.round(tickMs / 1000) * 2 + 300, source: { surface: 'collector', feed: FEED }, ...(readError ? { error: readError } : {}) });
    stats.beats += 1;
    if (!st) return { heartbeat: true, error: readError };

    const cfg = st.config || {};
    const vms = st.vms || [];
    const t = now();
    const active = new Map(); // subject -> () => ask
    const ready = vms.filter((v) => v.state === 'ready').length;
    const waiting = vms.filter((v) => v.state === 'building' && v.lessee).length;
    const lanes = Array.isArray(cfg.lanes) ? cfg.lanes : [];
    const paused = !!st.paused || vms.some((v) => v.state === 'failed' && String(v.last_error || '').startsWith('needs approval'));
    const approval = (st.paused && st.paused.approval_id)
      || ((vms.find((v) => v.state === 'failed' && String(v.last_error || '').startsWith('needs approval')) || {}).last_error || '').replace('needs approval ', '') || null;

    // 1. exhausted
    const want = (cfg.warm_target || 0) > 0 || waiting > 0;
    if (ready === 0 && want && lanes.length > 0 && !paused && !winFn(cfg.backup_window, t)) s.exhaustedTicks += 1; else s.exhaustedTicks = 0;
    if (s.exhaustedTicks >= EXHAUSTED_TICKS) {
      active.set(`vmpool:${orgId}:exhausted`, () => ask(orgId, s, `vmpool:${orgId}:exhausted`, 'The VM pool has no ready VM',
        { status: 'exhausted', condition: 'exhausted', ready_count: ready, waiting_count: waiting, warm_target: cfg.warm_target || 0 }));
    }

    // 2. consecutive failed builds per lane (observed as new failed rows; a build reaching ready/leased resets)
    const seenNow = new Map();
    for (const v of vms) {
      seenNow.set(v.vmid, v.state);
      const prev = s.seen.get(v.vmid);
      const needsApproval = String(v.last_error || '').startsWith('needs approval');
      if (v.state === 'failed' && prev !== 'failed' && !needsApproval && v.node) {
        s.laneFails.set(v.node, (s.laneFails.get(v.node) || 0) + 1);
      } else if ((v.state === 'ready' || v.state === 'leased') && prev === 'building' && v.node) {
        s.laneFails.set(v.node, 0);
      }
    }
    s.seen = seenNow;
    for (const [node, n] of s.laneFails) {
      if (n >= BUILD_FAIL_TICKS && lanes.some((l) => l.node === node)) {
        const last = vms.filter((v) => v.node === node && v.state === 'failed' && v.last_error).slice(-1)[0];
        active.set(`vmpool:${orgId}:build-failing:${node}`, () => ask(orgId, s, `vmpool:${orgId}:build-failing:${node}`, `VM builds keep failing on ${node}`,
          { status: 'failing', condition: 'build_failing', lane: node, consecutive_failures: n, last_error: last ? String(last.last_error).slice(0, 160) : null }));
      }
    }
    for (const node of [...s.laneFails.keys()]) if (!lanes.some((l) => l.node === node)) s.laneFails.delete(node);

    // 3. expired lease the reaper could not remove (it has had at least one full tick)
    for (const v of vms) {
      const exp = v.lease_expires_at ? Date.parse(v.lease_expires_at) : NaN;
      if (v.state === 'leased' && Number.isFinite(exp) && exp + tickMs < t) {
        active.set(`vmpool:${orgId}:stuck:${v.vmid}`, () => ask(orgId, s, `vmpool:${orgId}:stuck:${v.vmid}`, `VM ${v.vmid} is past its lease and could not be removed`,
          { status: 'stuck', condition: 'lease_stuck', vmid: v.vmid, node: v.node || null, lessee: v.lessee || null, expired_at: v.lease_expires_at }));
      }
    }

    // 4. warming paused on an approval (the lane's standing grant is missing or expired)
    if (paused) {
      active.set(`vmpool:${orgId}:grant`, () => ask(orgId, s, `vmpool:${orgId}:grant`, 'The VM pool is paused, waiting on an approval',
        { status: 'paused', condition: 'grant_paused', approval_id: approval }));
    }

    for (const fire of active.values()) fire();
    for (const subject of [...s.raised]) {
      if (active.has(subject)) continue;
      send({ org_id: orgId, ledger: 'operational', subject, kind: 'retract', source: { surface: 'collector', feed: FEED }, state: { status: 'resolved' } });
      s.raised.delete(subject); stats.retracts += 1;
    }
    return { heartbeat: true, raised: [...s.raised] };
  }

  return { observe, stats, orgs };
}

module.exports = { createPoolAwareness, FEED, EXHAUSTED_TICKS, BUILD_FAIL_TICKS };
