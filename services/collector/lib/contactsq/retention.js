'use strict';

/**
 * ContactsQ retention reaper (P4). Candidates past retain_until are FULLY erased
 * (crypto-shred + tombstone) unless legal_hold is set.
 *
 * Loop hygiene (the triad):
 *  - failure accounting is DISTINCT from empty ticks: a run that found nothing
 *    records status 'ok' with zero counts; a run with failures records
 *    'partial_failure'/'error', bumps consecutive_failures and logs the codes.
 *  - capped backoff on failure: next_attempt_at = now + min(15m * 2^(n-1), 60m),
 *    and a failing day is retried only inside the run window.
 *  - durable retirement: an erased contact leaves status 'candidate' for good; a
 *    contact that fails MAX_ITEM_ATTEMPTS times is retired (retention_fail_count)
 *    and counted as retired_failed, never retried forever.
 *  - NOT boot-triggered: the scheduler (scheduler.js) only wakes on a wall-clock
 *    interval and acts inside [run_time_utc, +WINDOW_MIN); a restart outside the
 *    window does nothing.
 *  - kill switch is the org setting retention_reaper_enabled (dashboard + CLI).
 */

const store = require('./store.js');
const erasure = require('./erasure.js');
const policy = require('./policy.js');

const MAX_ITEM_ATTEMPTS = 5;
const RUN_CAP = 500;
const WINDOW_MIN = 120;
const BACKOFF_BASE_MIN = 15;
const BACKOFF_CAP_MIN = 60;
const DEFAULT_RUN_TIME = '03:15';
// json_each (not a leading-wildcard LIKE): exact flag match, guarded so a malformed value can never throw the whole query.
const LEGAL_HOLD_SQL = "(CASE WHEN json_valid(flags_json) THEN EXISTS (SELECT 1 FROM json_each(contacts.flags_json) WHERE json_each.value = 'legal_hold') ELSE 0 END)";

const scheduler = { armed: false, since: null };
function setSchedulerArmed(armed) { scheduler.armed = Boolean(armed); scheduler.since = armed ? new Date().toISOString() : null; }

function runStart(nowMs, runTime) {
  const hm = policy.parseHm(runTime || DEFAULT_RUN_TIME);
  const m = hm === null ? policy.parseHm(DEFAULT_RUN_TIME) : hm;
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(m / 60), m % 60);
}

/** The window anchor (UTC date key of the run START) containing now, or null when now is outside every window. */
function windowDay(nowMs, runTime) {
  for (const offsetDays of [0, -1]) {
    const start = runStart(nowMs, runTime) + offsetDays * 86400000;
    if (nowMs >= start && nowMs < start + WINDOW_MIN * 60000) return new Date(start).toISOString().slice(0, 10);
  }
  return null;
}

function getState(orgId) {
  return store.getDb().prepare('SELECT * FROM contactsq_retention_state WHERE org_id = ?').get(orgId) || null;
}

function saveState(orgId, patch) {
  const cur = getState(orgId) || {};
  const next = { last_run_at: null, last_run_day: null, last_status: null, consecutive_failures: 0, next_attempt_at: null, last_counts_json: null, ...cur, ...patch };
  store.getDb().prepare(`
    INSERT INTO contactsq_retention_state (org_id, last_run_at, last_run_day, last_status, consecutive_failures, next_attempt_at, last_counts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_day = excluded.last_run_day, last_status = excluded.last_status,
      consecutive_failures = excluded.consecutive_failures, next_attempt_at = excluded.next_attempt_at, last_counts_json = excluded.last_counts_json
  `).run(orgId, next.last_run_at, next.last_run_day, next.last_status, next.consecutive_failures, next.next_attempt_at, next.last_counts_json);
}

const backoffMs = (n) => Math.min(BACKOFF_BASE_MIN * 2 ** Math.max(n - 1, 0), BACKOFF_CAP_MIN) * 60000;

function pendingCounts(orgId, nowMs) {
  const db = store.getDb();
  const now = new Date(nowMs).toISOString();
  const n = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
  const expired = "status = 'candidate' AND retain_until IS NOT NULL AND retain_until <= ?";
  return {
    expired: n(`SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND ${expired} AND NOT ${LEGAL_HOLD_SQL} AND retention_fail_count < ${MAX_ITEM_ATTEMPTS}`, now),
    legal_hold: n(`SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND ${expired} AND ${LEGAL_HOLD_SQL}`, now),
    retired_failed: n(`SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND ${expired} AND NOT ${LEGAL_HOLD_SQL} AND retention_fail_count >= ${MAX_ITEM_ATTEMPTS}`, now),
  };
}

function createRetention({ emit }) {
  /** Reap one org. dryRun reports ids it WOULD erase and changes nothing. Never throws for one bad item. */
  function reapOrg(orgId, { dryRun = false, nowMs = Date.now() } = {}) {
    const db = store.getDb();
    const now = new Date(nowMs).toISOString();
    const pending = pendingCounts(orgId, nowMs);
    const rows = db.prepare(
      `SELECT id FROM contacts WHERE org_id = ? AND status = 'candidate' AND retain_until IS NOT NULL AND retain_until <= ?
         AND NOT ${LEGAL_HOLD_SQL} AND retention_fail_count < ${MAX_ITEM_ATTEMPTS} ORDER BY retain_until ASC LIMIT ?`
    ).all(orgId, now, RUN_CAP);
    const res = {
      dry_run: dryRun, considered: rows.length, erased: 0, failed: 0, skipped_legal_hold: pending.legal_hold, retired_failed: pending.retired_failed,
      remaining: Math.max(pending.expired - rows.length, 0), failed_ids: [],
    };
    if (dryRun) { res.would_erase_ids = rows.map((r) => r.id); return res; }
    const ctx = { orgId, actor: 'service', agentId: 'retention-reaper' };
    for (const r of rows) {
      try {
        const out = erasure.eraseContact(orgId, r.id, { scope: 'full', reasonCode: 'retention_expired', requestedBy: 'system:retention', nowMs });
        res.erased += 1;
        emit('quox.contacts.erased', ctx, { contact_id: r.id, scope: 'full', reason: 'retention_expired', counts: out.erasure.counts, outcome: 'erased' });
      } catch (e) {
        if (e instanceof store.ContactsqError && e.code === 'legal_hold') { res.skipped_legal_hold += 1; continue; }
        if (e instanceof store.ContactsqError && e.code === 'already_erased') continue;
        res.failed += 1;
        res.failed_ids.push(r.id);
        db.prepare('UPDATE contacts SET retention_fail_count = retention_fail_count + 1 WHERE id = ? AND org_id = ?').run(r.id, orgId);
        console.error(`[contactsq] retention erase failed contact=${r.id} code=${(e && e.code) || 'error'}`);
      }
    }
    return res;
  }

  /** Run one org and durably record the outcome (success clears the failure streak; failure arms the capped backoff). */
  function runOrg(orgId, { dryRun = false, nowMs = Date.now() } = {}) {
    let res;
    let status;
    try {
      res = reapOrg(orgId, { dryRun, nowMs });
      status = res.failed > 0 ? 'partial_failure' : 'ok';
    } catch (e) {
      console.error(`[contactsq] retention run errored org=${orgId} code=${(e && e.code) || 'error'}`);
      res = { dry_run: dryRun, considered: 0, erased: 0, failed: 1, skipped_legal_hold: 0, retired_failed: 0, remaining: 0, failed_ids: [] };
      status = 'error';
    }
    if (dryRun) return { status, ...res };
    const prev = getState(orgId);
    const failures = status === 'ok' ? 0 : (prev ? prev.consecutive_failures : 0) + 1;
    const counts = { considered: res.considered, erased: res.erased, failed: res.failed, skipped_legal_hold: res.skipped_legal_hold, retired_failed: res.retired_failed, remaining: res.remaining };
    saveState(orgId, {
      last_run_at: new Date(nowMs).toISOString(),
      // A day is only marked done when it finished clean; a failing day stays retryable inside the window.
      last_run_day: status === 'ok' ? (windowDay(nowMs, store.getSettings(orgId).retention_run_time_utc) || new Date(nowMs).toISOString().slice(0, 10)) : (prev ? prev.last_run_day : null),
      last_status: status, consecutive_failures: failures,
      next_attempt_at: status === 'ok' ? null : new Date(nowMs + backoffMs(failures)).toISOString(),
      last_counts_json: JSON.stringify(counts),
    });
    emit('quox.contacts.retention_run', { orgId, actor: 'service', agentId: 'retention-reaper' }, { count: res.erased, counts, outcome: status });
    return { status, ...res };
  }

  /**
   * Scheduler entry. Walks every org with candidates; acts only on orgs that are enabled, inside their run
   * window, not already done today and not in backoff. Logs ONE summary line when any org was attempted.
   */
  function tick({ nowMs = Date.now(), log = (m) => console.log(m) } = {}) {
    const db = store.getDb();
    const orgs = db.prepare("SELECT DISTINCT org_id FROM contacts WHERE status = 'candidate' AND retain_until IS NOT NULL").all().map((r) => r.org_id);
    const sum = { orgs: orgs.length, ran: 0, erased: 0, failed: 0, skipped_legal_hold: 0, disabled: 0, not_due: 0, backing_off: 0, errors: 0 };
    for (const orgId of orgs) {
      const settings = store.getSettings(orgId);
      if (!settings.retention_reaper_enabled) { sum.disabled += 1; continue; }
      const day = windowDay(nowMs, settings.retention_run_time_utc);
      if (!day) { sum.not_due += 1; continue; }
      const st = getState(orgId);
      if (st && st.last_run_day === day) { sum.not_due += 1; continue; }
      if (st && st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs) { sum.backing_off += 1; continue; }
      const r = runOrg(orgId, { nowMs });
      sum.ran += 1;
      sum.erased += r.erased;
      sum.failed += r.failed;
      sum.skipped_legal_hold += r.skipped_legal_hold;
      if (r.status === 'error') sum.errors += 1;
    }
    if (sum.ran > 0 || sum.backing_off > 0) {
      log(`[contactsq] retention tick orgs=${sum.orgs} ran=${sum.ran} erased=${sum.erased} failed=${sum.failed} errors=${sum.errors} skipped_legal_hold=${sum.skipped_legal_hold} backing_off=${sum.backing_off} disabled=${sum.disabled}`);
    }
    return sum;
  }

  function nextTickAt(orgId, nowMs, settings, st) {
    let start = runStart(nowMs, settings.retention_run_time_utc);
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    if (nowMs >= start + WINDOW_MIN * 60000 || (st && st.last_run_day === day(start))) start += 86400000;
    let next = Math.max(start, nowMs);
    if (st && st.next_attempt_at && windowDay(nowMs, settings.retention_run_time_utc) && Date.parse(st.next_attempt_at) > next) next = Date.parse(st.next_attempt_at);
    return new Date(next).toISOString();
  }

  function status(orgId, nowMs = Date.now()) {
    const settings = store.getSettings(orgId);
    const st = getState(orgId);
    return {
      enabled: settings.retention_reaper_enabled,
      scheduler_armed: scheduler.armed,
      run_time_utc: settings.retention_run_time_utc,
      last_run_at: st ? st.last_run_at : null,
      last_status: st ? st.last_status : null,
      last_counts: st && st.last_counts_json ? store.parseJson(st.last_counts_json, null) : null,
      consecutive_failures: st ? st.consecutive_failures : 0,
      backoff_until: st && st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs ? st.next_attempt_at : null,
      next_tick_at: settings.retention_reaper_enabled ? nextTickAt(orgId, nowMs, settings, st) : null,
      pending: pendingCounts(orgId, nowMs),
    };
  }

  return { reapOrg, runOrg, tick, status };
}

module.exports = { createRetention, setSchedulerArmed, windowDay, MAX_ITEM_ATTEMPTS, WINDOW_MIN, RUN_CAP, backoffMs };
