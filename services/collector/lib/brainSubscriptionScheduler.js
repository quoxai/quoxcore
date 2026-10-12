'use strict';

/**
 * brainSubscriptionScheduler.js - ONE-BRAIN CX6 "tell my slot when new notes
 * about X land".
 *
 * Each tick: list active topic subscriptions (quoxbrain, service key), search
 * each topic AS THE SUBSCRIBING USER (X-User-Id = the subscriber, so the
 * visibility is theirs, never the service's), drop insufficient results and
 * notes already announced, and post ONE concise message per subscription to
 * its slot through the governed slot say route.
 *
 * Loop hygiene triad (CLAUDE.md "Loop & Restart Hygiene"):
 *  - failure accounting is DISTINCT from "no new notes": an error is reported
 *    to quoxbrain as ok=false (consecutive_failures++), an empty result is a
 *    success that advances the window;
 *  - capped backoff per subscription: after f consecutive failures it is
 *    skipped min(2^(f-1)-1, MAX_BACKOFF_TICKS) ticks (in memory; a restart
 *    only costs one early retry);
 *  - durable retirement: quoxbrain disables a subscription after 10 failures
 *    with a reason, and it leaves the active list; we log that loudly.
 * No work at process start: the first tick is scheduled at +interval.
 * A subscription's first tick only sets last_checked_at = now and sends
 * nothing, so creating one never floods the slot with history.
 *
 * Interval: QUOX_BRAIN_SUBSCRIPTION_INTERVAL_MS (default 30 min, floor 60 s).
 * There is no platform-settings resolver for scheduler intervals, so the env
 * is the documented knob (registered in services/shared/envRegistry.cjs).
 */

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_TICKS = 8;
const SEARCH_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 30000;

function resolveIntervalMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(n, MIN_INTERVAL_MS);
}

function backoffTicks(failures) {
  return Math.min(Math.pow(2, Math.max(failures, 1) - 1) - 1, MAX_BACKOFF_TICKS);
}

function formatMessage(query, hits) {
  const n = hits.length;
  const lines = hits.map((h) => `- ${String(h.title || h.relPath || 'untitled').slice(0, 120)} (${h.noteId})`);
  return `Brain: ${n} new note${n === 1 ? '' : 's'} about "${query.slice(0, 80)}"\n${lines.join('\n')}`;
}

function createBrainSubscriptionScheduler({
  brainUrl,
  collectorUrl,
  serviceKey,
  fetchFn = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console.log,
  logError = console.error,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const skipTicks = new Map(); // subscription id -> ticks still to skip
  let timer = null;
  let running = false;

  const svcHeaders = (orgId, userId) => ({
    'Content-Type': 'application/json',
    'X-Service-Key': serviceKey || '',
    ...(orgId ? { 'X-Org-Id': orgId } : {}),
    ...(userId ? { 'X-User-Id': userId } : {}),
  });

  async function call(method, url, headers, body) {
    const res = await fetchFn(url, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, '')} -> ${res.status}${json && json.error ? ` ${json.error}` : ''}`);
    return json;
  }

  async function report(sub, payload) {
    return call('POST', `${brainUrl}/internal/subscriptions/${encodeURIComponent(sub.id)}/result`, svcHeaders(sub.orgId), payload);
  }

  async function processOne(sub, tickStartIso) {
    // First run: establish the baseline, announce nothing.
    if (!sub.lastCheckedAt) {
      await report(sub, { ok: true, checkedAt: tickStartIso, noteIds: [] });
      return { kind: 'baseline' };
    }
    const data = await call('POST', `${brainUrl}/brain/search`, svcHeaders(sub.orgId, sub.userId),
      { query: sub.query, since: sub.lastCheckedAt, limit: SEARCH_LIMIT });
    const seen = new Set(sub.lastNotifiedNoteIds || []);
    const hits = [];
    if (data && !data.insufficient) {
      for (const r of Array.isArray(data.results) ? data.results : []) {
        if (!r || !r.noteId || seen.has(r.noteId) || hits.some((h) => h.noteId === r.noteId)) continue;
        hits.push(r);
      }
    }
    if (!hits.length) {
      await report(sub, { ok: true, checkedAt: tickStartIso, noteIds: [] });
      return { kind: 'none' };
    }
    await call('POST', `${collectorUrl}/api/v1/slots/${encodeURIComponent(sub.slot)}/say?org_id=${encodeURIComponent(sub.orgId)}`,
      svcHeaders(), { text: formatMessage(sub.query, hits), from: 'brain' });
    await report(sub, { ok: true, checkedAt: tickStartIso, noteIds: hits.map((h) => h.noteId) });
    return { kind: 'posted', count: hits.length };
  }

  async function tick() {
    if (running) return { skippedOverlap: true };
    running = true;
    const stats = { subscriptions: 0, posted: 0, baselines: 0, noHits: 0, failures: 0, backedOff: 0, disabled: 0, listFailed: false };
    try {
      const tickStartIso = new Date(now()).toISOString();
      let subs;
      try {
        const data = await call('GET', `${brainUrl}/internal/subscriptions/active`, svcHeaders());
        subs = Array.isArray(data && data.subscriptions) ? data.subscriptions : [];
      } catch (err) {
        // Brain unreachable is a tick failure, never "0 subscriptions".
        stats.listFailed = true;
        logError(`[BrainSubs] tick FAILED to list subscriptions: ${err.message}`);
        return stats;
      }
      stats.subscriptions = subs.length;
      const live = new Set(subs.map((s) => s.id));
      for (const id of [...skipTicks.keys()]) if (!live.has(id)) skipTicks.delete(id);
      for (const sub of subs) {
        const left = skipTicks.get(sub.id) || 0;
        if (left > 0) { skipTicks.set(sub.id, left - 1); stats.backedOff++; continue; }
        try {
          const r = await processOne(sub, tickStartIso);
          skipTicks.delete(sub.id);
          if (r.kind === 'posted') stats.posted++;
          else if (r.kind === 'baseline') stats.baselines++;
          else stats.noHits++;
        } catch (err) {
          stats.failures++;
          let row = null;
          try {
            const out = await report(sub, { ok: false, error: err.message });
            row = out && out.subscription;
          } catch (e2) {
            logError(`[BrainSubs] could not record failure for ${sub.id}: ${e2.message}`);
          }
          const failures = row ? row.consecutiveFailures : (sub.consecutiveFailures || 0) + 1;
          skipTicks.set(sub.id, backoffTicks(failures));
          if (row && row.disabledAt) {
            stats.disabled++;
            logError(`[BrainSubs] RETIRED subscription ${sub.id} ("${sub.query}" -> slot ${sub.slot}): ${row.disabledReason}`);
          } else {
            logError(`[BrainSubs] subscription ${sub.id} failed (${failures} consecutive): ${err.message}`);
          }
        }
      }
      if (stats.posted || stats.failures || stats.baselines) {
        log(`[BrainSubs] tick: ${stats.subscriptions} active, ${stats.posted} posted, ${stats.noHits} no new notes, ${stats.baselines} baselined, ${stats.failures} failed, ${stats.backedOff} backed off, ${stats.disabled} retired`);
      }
      return stats;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    // First tick at +interval, never at boot.
    timer = setIntervalFn(() => { tick().catch((e) => logError(`[BrainSubs] tick crashed: ${e.message}`)); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer) { clearIntervalFn(timer); timer = null; } }

  return { tick, start, stop, intervalMs };
}

module.exports = { createBrainSubscriptionScheduler, resolveIntervalMs, backoffTicks, formatMessage, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_BACKOFF_TICKS };
