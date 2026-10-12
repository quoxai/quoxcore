'use strict';

/**
 * ContactsQ recurring compliance report (opt-in, per-org setting `compliance_report`).
 *
 * When due, the reaper scheduler tick computes the /compliance bands + /stats and delivers
 * them to the org's Approvals inbox (the auth internal inbox endpoint, the same one the
 * QuoxSEO report uses; with no assignee it reaches every org owner/admin). Counts and ids
 * only: no names, no identifier values, no free text.
 *
 * Loop hygiene (the triad), same shape as retention.js:
 *  - failure accounting is DISTINCT from "not due": a failed run records status 'failed',
 *    bumps consecutive_failures, stores a failed report row with a stable error code.
 *  - capped backoff: next_attempt_at = now + min(15m * 2^(n-1), 60m); a failing period is
 *    retried only inside its window.
 *  - durable retirement: after MAX_PERIOD_ATTEMPTS the period is marked done (retired) and
 *    never retried; the next period starts clean.
 *  - NOT boot-triggered: scheduler.js only wakes on a wall-clock interval and this module
 *    acts only inside [time_utc, +WINDOW_MIN) on a qualifying day.
 */

const store = require('./store.js');
const compliance = require('./compliance.js');
const policy = require('./policy.js');

const WINDOW_MIN = 120;
const MAX_PERIOD_ATTEMPTS = 5;
const BACKOFF_BASE_MIN = 15;
const BACKOFF_CAP_MIN = 60;
const CADENCES = ['weekly', 'monthly'];
const REPORT_IDS_SHOWN = 10;
const LIST_MAX = 50;

const backoffMs = (n) => Math.min(BACKOFF_BASE_MIN * 2 ** Math.max(n - 1, 0), BACKOFF_CAP_MIN) * 60000;

/** Validate a (merged) compliance_report setting. Returns an error code or null. */
function validateConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'invalid_compliance_report';
  if (typeof c.enabled !== 'boolean') return 'invalid_compliance_report_enabled';
  if (!CADENCES.includes(c.cadence)) return 'invalid_compliance_report_cadence';
  const max = c.cadence === 'weekly' ? 7 : 28;
  if (!Number.isInteger(c.day) || c.day < 1 || c.day > max) return 'invalid_compliance_report_day';
  if (typeof c.time_utc !== 'string' || policy.parseHm(c.time_utc) === null) return 'invalid_compliance_report_time_utc';
  return null;
}

/**
 * The period whose delivery window contains nowMs, or null. weekly: day is ISO weekday (Mon=1..Sun=7),
 * period key is the run date; monthly: day is day-of-month (1..28), period key is YYYY-MM.
 */
function dueWindow(nowMs, cfg) {
  const hm = policy.parseHm(cfg.time_utc);
  if (hm === null) return null;
  for (const offsetDays of [0, -1]) {
    const d = new Date(nowMs + offsetDays * 86400000);
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const matches = cfg.cadence === 'weekly' ? iso === cfg.day : d.getUTCDate() === cfg.day;
    if (!matches) continue;
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(hm / 60), hm % 60);
    if (nowMs >= start && nowMs < start + WINDOW_MIN * 60000) {
      const key = cfg.cadence === 'weekly' ? new Date(start).toISOString().slice(0, 10) : new Date(start).toISOString().slice(0, 7);
      return { periodKey: key, startMs: start };
    }
  }
  return null;
}

function getState(orgId) {
  return store.getDb().prepare('SELECT * FROM contactsq_report_state WHERE org_id = ?').get(orgId) || null;
}
function saveState(orgId, patch) {
  const next = { done_period_key: null, attempt_period_key: null, attempts: 0, last_run_at: null, last_status: null, consecutive_failures: 0, next_attempt_at: null, ...(getState(orgId) || {}), ...patch };
  store.getDb().prepare(`
    INSERT INTO contactsq_report_state (org_id, done_period_key, attempt_period_key, attempts, last_run_at, last_status, consecutive_failures, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET done_period_key = excluded.done_period_key, attempt_period_key = excluded.attempt_period_key, attempts = excluded.attempts,
      last_run_at = excluded.last_run_at, last_status = excluded.last_status, consecutive_failures = excluded.consecutive_failures, next_attempt_at = excluded.next_attempt_at
  `).run(orgId, next.done_period_key, next.attempt_period_key, next.attempts, next.last_run_at, next.last_status, next.consecutive_failures, next.next_attempt_at);
}

/** Counts and capped id lists only. */
function buildSummary(orgId, nowMs) {
  const bands = compliance.buildBands(orgId, nowMs);
  const out = {};
  for (const [k, b] of Object.entries(bands)) out[k] = { count: b.count, ids: (b.ids || []).slice(0, REPORT_IDS_SHOWN) };
  return { bands: out, stats: store.stats(orgId) };
}

function renderMarkdown(summary, { cadence, periodKey }) {
  const lines = [`ContactsQ ${cadence} compliance report for ${periodKey}.`, '', '**Posture bands** (count, first ids)'];
  for (const [k, b] of Object.entries(summary.bands)) lines.push(`- ${k}: ${b.count}${b.ids.length ? ` (${b.ids.join(', ')})` : ''}`);
  const s = summary.stats;
  lines.push('', '**Stats**', `- total contacts: ${s.total}`, `- candidates: ${s.candidates}`, `- active suppressions: ${s.suppressions}`,
    `- active standing grants: ${s.active_grants}`, `- leases last 7d: ${s.leases_last_7d}`, `- denied last 7d: ${s.denied_last_7d}`);
  return lines.join('\n');
}

/** Default delivery: the auth internal inbox (Approvals inbox), org owners/admins. Throws on any non-2xx. */
async function defaultDeliver({ orgId, title, body_md: bodyMd, payload }) {
  const key = process.env.INTERNAL_SERVICE_KEY || '';
  if (!key) throw Object.assign(new Error('no_service_key'), { code: 'no_service_key' });
  const base = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
  const res = await fetch(`${base}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
    body: JSON.stringify({ kind: 'info', priority: 'normal', title, body_md: bodyMd, payload }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw Object.assign(new Error(`inbox_http_${res.status}`), { code: `inbox_http_${res.status}` });
  const body = await res.json().catch(() => ({}));
  return { id: (body.item && body.item.id) || body.existing_item_id || body.id || null };
}

const errCode = (e) => (e && typeof e.code === 'string' && /^[a-z0-9_.:-]{1,48}$/.test(e.code) ? e.code : 'deliver_failed');

function createReports({ emit, deliver = defaultDeliver }) {
  let inFlight = false;

  function insertReport(orgId, { periodKey, cadence, nowMs, status, deliveryRef, errorCode, summary }) {
    const id = `rpt_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    store.getDb().prepare(`INSERT INTO contactsq_reports (id, org_id, period_key, cadence, generated_at, status, delivery_ref, error_code, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, periodKey, cadence, new Date(nowMs).toISOString(), status, deliveryRef || null, errorCode || null, JSON.stringify(summary || {}));
    return id;
  }

  /** Generate + deliver one org's report for a period and durably record the outcome. Never throws. */
  async function runOrg(orgId, { periodKey, cadence, nowMs }) {
    const prev = getState(orgId);
    const attempts = (prev && prev.attempt_period_key === periodKey ? prev.attempts : 0) + 1;
    let status = 'delivered';
    let code = null;
    let summary = null;
    let ref = null;
    try {
      summary = buildSummary(orgId, nowMs);
      const out = await deliver({
        orgId,
        title: `ContactsQ ${cadence} compliance report ${periodKey}`,
        body_md: renderMarkdown(summary, { cadence, periodKey }),
        payload: { source: 'contactsq', action: 'compliance_report', period_key: periodKey, cadence },
      });
      ref = (out && out.id) || null;
    } catch (e) {
      status = 'failed';
      code = errCode(e);
      console.error(`[contactsq] compliance report failed org=${orgId} period=${periodKey} code=${code}`);
    }
    const reportId = insertReport(orgId, { periodKey, cadence, nowMs, status, deliveryRef: ref, errorCode: code, summary });
    const failures = status === 'delivered' ? 0 : (prev ? prev.consecutive_failures : 0) + 1;
    const retired = status === 'failed' && attempts >= MAX_PERIOD_ATTEMPTS;
    saveState(orgId, {
      attempt_period_key: periodKey, attempts, last_run_at: new Date(nowMs).toISOString(),
      last_status: retired ? 'retired_failed' : status, consecutive_failures: failures,
      // A period is only done when delivered or retired; a failing period stays retryable inside the window.
      done_period_key: status === 'delivered' || retired ? periodKey : (prev ? prev.done_period_key : null),
      next_attempt_at: status === 'delivered' || retired ? null : new Date(nowMs + backoffMs(failures)).toISOString(),
    });
    emit('quox.contacts.compliance_report', { orgId, actor: 'service', agentId: 'report-scheduler' }, {
      report_id: reportId, outcome: retired ? 'retired_failed' : status, reason: code || undefined,
      counts: summary ? { notice_overdue: summary.bands.notice_overdue.count, no_lawful_basis: summary.bands.no_lawful_basis.count, total: summary.stats.total } : { attempts },
    });
    return { status: retired ? 'retired_failed' : status, report_id: reportId };
  }

  /**
   * Scheduler entry. Walks orgs with the report enabled; acts only inside the window, once per period,
   * outside backoff. Async; a second overlapping call is skipped (counted as `overlap`).
   */
  async function tick({ nowMs = Date.now(), log = (m) => console.log(m) } = {}) {
    const sum = { orgs: 0, ran: 0, delivered: 0, failed: 0, retired: 0, not_due: 0, backing_off: 0, overlap: 0 };
    if (inFlight) { sum.overlap = 1; return sum; }
    inFlight = true;
    try {
      const rows = store.getDb().prepare('SELECT org_id FROM contactsq_settings WHERE compliance_report_json IS NOT NULL').all();
      for (const { org_id: orgId } of rows) {
        const cfg = store.getSettings(orgId).compliance_report;
        if (!cfg.enabled || validateConfig(cfg)) continue;
        sum.orgs += 1;
        const win = dueWindow(nowMs, cfg);
        if (!win) { sum.not_due += 1; continue; }
        const st = getState(orgId);
        if (st && st.done_period_key === win.periodKey) { sum.not_due += 1; continue; }
        if (st && st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs) { sum.backing_off += 1; continue; }
        const r = await runOrg(orgId, { periodKey: win.periodKey, cadence: cfg.cadence, nowMs });
        sum.ran += 1;
        if (r.status === 'delivered') sum.delivered += 1;
        else { sum.failed += 1; if (r.status === 'retired_failed') sum.retired += 1; }
      }
    } finally { inFlight = false; }
    if (sum.ran > 0 || sum.backing_off > 0) {
      log(`[contactsq] report tick orgs=${sum.orgs} ran=${sum.ran} delivered=${sum.delivered} failed=${sum.failed} retired=${sum.retired} backing_off=${sum.backing_off}`);
    }
    return sum;
  }

  function list(orgId, limit = 10) {
    const n = Math.min(Math.max(Number(limit) || 10, 1), LIST_MAX);
    return store.getDb().prepare('SELECT * FROM contactsq_reports WHERE org_id = ? ORDER BY generated_at DESC, rowid DESC LIMIT ?').all(orgId, n).map((r) => ({
      id: r.id, period_key: r.period_key, cadence: r.cadence, generated_at: r.generated_at, status: r.status,
      delivery_ref: r.delivery_ref || null, error_code: r.error_code || null, summary: store.parseJson(r.summary_json, {}),
    }));
  }

  return { tick, runOrg, list };
}

module.exports = { createReports, validateConfig, dueWindow, renderMarkdown, defaultDeliver, WINDOW_MIN, MAX_PERIOD_ATTEMPTS, LIST_MAX };
