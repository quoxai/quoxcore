/**
 * QuoxSEO weekly report scheduler (QUOXSEO P-H, codex audit 2026-09-23).
 *
 * A server-side, durable scheduler that delivers the witnessed SEO report on a
 * schedule. NEVER a browser timer (hard rule): it runs in the collector process
 * against a durable better-sqlite3 store and survives restarts.
 *
 * It implements the loop TRIAD the estate's incident rules require, which the
 * existing compliance job runner lacks:
 *
 *  1. FAILURE ACCOUNTING distinct from empty results. Every attempt is a run row
 *     with a typed outcome (delivered | partial | empty | unchanged |
 *     transient_failure | permanent_failure | delivery_unknown). A missing
 *     warehouse ("empty") is NOT counted as a delivery, and an HTTP 200 alone is
 *     never "success": a channel counts delivered only on an acknowledged result.
 *
 *  2. BACKOFF on zero progress. Failed attempts retry on a capped ladder
 *     (5m, 15m, 1h, 6h, 24h + jitter). Progress (a newly acknowledged channel,
 *     or a new report_id) resets the failure counter. A successful channel is
 *     never re-sent to retry a failed one (outstanding-channel tracking).
 *
 *  3. DURABLE RETIREMENT. A cycle whose retries are exhausted is retired
 *     (permanent_failure) and the schedule advances to the next interval; a
 *     schedule that produces no data for too many cycles is PAUSED for review.
 *     Status (active|paused|retired) is persisted, so a restart never resurrects
 *     a retired/paused schedule. Reactivation is explicit.
 *
 * Claiming is transactional: the run id is `${scheduleId}~${cycleFor}~${attempt}`
 * and is the PRIMARY KEY, so two racing ticks cannot both run the same attempt
 * (the second INSERT throws and is skipped). Delivery attempts are keyed
 * (run_id, channel, recipient) so a re-run cannot double-count a channel.
 *
 * All effectful inputs (db, now, deliver, rand) are injected so the triad is
 * unit-tested with an in-memory db and a mocked deliver.
 */

'use strict';

const BACKOFF_MINUTES = [5, 15, 60, 360, 1440]; // capped ladder
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1; // attempts before a cycle is retired
const MAX_NOPROGRESS_CYCLES = 4; // consecutive no-data/stale cycles before pause
const DEFAULT_CHANNELS = ['email', 'inbox'];

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quoxseo_report_schedules (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      site_id TEXT,
      recipient_email TEXT,
      channels TEXT NOT NULL DEFAULT '["email","inbox"]',
      interval TEXT NOT NULL DEFAULT 'weekly',
      day_of_week INTEGER NOT NULL DEFAULT 1,
      hour INTEGER NOT NULL DEFAULT 8,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      report_type TEXT NOT NULL DEFAULT 'full',
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      config_version INTEGER NOT NULL DEFAULT 1,
      cycle_for TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      last_report_id TEXT,
      outstanding_channels TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      noprogress_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qsched_due ON quoxseo_report_schedules (status, next_run_at);
    CREATE TABLE IF NOT EXISTS quoxseo_report_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      cycle_for TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      report_id TEXT,
      outcome TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qrun_sched ON quoxseo_report_runs (schedule_id, cycle_for);
    CREATE TABLE IF NOT EXISTS quoxseo_delivery_attempts (
      run_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL,
      UNIQUE (run_id, channel, recipient)
    );
  `);
  return db;
}

// --- time helpers ---------------------------------------------------------
// Convert a wall-clock (y, m, d, h) in an IANA timezone to a UTC epoch ms.
// One offset correction handles all but the sub-hour DST discontinuity, which
// does not matter for a weekly report slot.
function zonedWallclockToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0);
  let offset = 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    offset = asIfUtc - guess;
  } catch { offset = 0; } // unknown tz -> treat as UTC
  return guess - offset;
}

function partsInTz(ms, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
    const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: dowMap[p.weekday], hour: Number(p.hour) % 24 };
  } catch {
    const dt = new Date(ms);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay(), hour: dt.getUTCHours() };
  }
}

// Next interval slot strictly after fromMs, at the configured day/hour in tz.
function computeNextRun({ interval = 'weekly', dayOfWeek = 1, hour = 8, timezone = 'UTC' }, fromMs) {
  const step = 24 * 60 * 60 * 1000;
  for (let i = 0; i <= 400; i++) {
    const probe = fromMs + i * step;
    const p = partsInTz(probe, timezone);
    const dowOk = interval === 'daily' ? true : interval === 'monthly' ? true : p.dow === dayOfWeek;
    const dayOk = interval === 'monthly' ? p.d === 1 : true;
    if (dowOk && dayOk) {
      const slot = zonedWallclockToUtc(p.y, p.m, p.d, hour, timezone);
      if (slot > fromMs) return new Date(slot).toISOString();
    }
  }
  return new Date(fromMs + 7 * step).toISOString(); // safety fallback
}

function backoffMs(failCount, rand) {
  const idx = Math.min(Math.max(0, failCount - 1), BACKOFF_MINUTES.length - 1);
  const base = BACKOFF_MINUTES[idx] * 60 * 1000;
  const jitter = Math.floor((rand ? rand() : Math.random()) * Math.min(base * 0.2, 120000));
  return base + jitter;
}

// --- schedule CRUD --------------------------------------------------------
function createSchedule(db, opts, nowMs, rand) {
  initSchema(db);
  const now = new Date(nowMs).toISOString();
  const id = opts.id || `qsched_${nowMs}_${Math.floor((rand ? rand() : Math.random()) * 1e6).toString(36)}`;
  const channels = Array.isArray(opts.channels) && opts.channels.length ? opts.channels : DEFAULT_CHANNELS;
  const cfg = { interval: opts.interval || 'weekly', dayOfWeek: opts.dayOfWeek ?? 1, hour: opts.hour ?? 8, timezone: opts.timezone || 'UTC' };
  const nextRun = computeNextRun(cfg, nowMs);
  db.prepare(`INSERT INTO quoxseo_report_schedules
    (id, org_id, site_id, recipient_email, channels, interval, day_of_week, hour, timezone, report_type,
     status, config_version, cycle_for, next_run_at, outstanding_channels, fail_count, noprogress_count, created_at, updated_at)
    VALUES (@id,@org_id,@site_id,@recipient_email,@channels,@interval,@day_of_week,@hour,@timezone,@report_type,
     'active',1,@cycle_for,@next_run_at,@outstanding,0,0,@now,@now)`)
    .run({
      id, org_id: opts.orgId, site_id: opts.siteId ?? null, recipient_email: opts.recipientEmail ?? null,
      channels: JSON.stringify(channels), interval: cfg.interval, day_of_week: cfg.dayOfWeek, hour: cfg.hour,
      timezone: cfg.timezone, report_type: opts.reportType || 'full', cycle_for: nextRun, next_run_at: nextRun,
      outstanding: JSON.stringify(channels), now,
    });
  return getSchedule(db, id, opts.orgId);
}

function getSchedule(db, id, orgId) {
  const row = orgId
    ? db.prepare('SELECT * FROM quoxseo_report_schedules WHERE id = ? AND org_id = ?').get(id, orgId)
    : db.prepare('SELECT * FROM quoxseo_report_schedules WHERE id = ?').get(id);
  return row || null;
}
function listSchedules(db, orgId) {
  initSchema(db);
  return db.prepare('SELECT * FROM quoxseo_report_schedules WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
}
function setStatus(db, id, orgId, status, reason, nowMs) {
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const sched = getSchedule(db, id, orgId);
  if (!sched) return null;
  // Reactivating a paused/retired schedule resets its cycle to the next slot.
  const extra = status === 'active'
    ? { fail_count: 0, cycle_for: computeNextRun(cfgOf(sched), Date.parse(now)), next_run_at: computeNextRun(cfgOf(sched), Date.parse(now)), outstanding_channels: sched.channels }
    : {};
  db.prepare('UPDATE quoxseo_report_schedules SET status=@status, status_reason=@reason, updated_at=@now' +
    (status === 'active' ? ', fail_count=@fail_count, cycle_for=@cycle_for, next_run_at=@next_run_at, outstanding_channels=@outstanding_channels' : '') +
    ' WHERE id=@id AND org_id=@org_id')
    .run({ id, org_id: orgId, status, reason: reason ?? null, now, ...extra });
  return getSchedule(db, id, orgId);
}
const cfgOf = (s) => ({ interval: s.interval, dayOfWeek: s.day_of_week, hour: s.hour, timezone: s.timezone });

// --- the tick: run all due schedules, applying the triad ------------------
async function runDueSchedules({ db, nowMs, deliver, rand, log }) {
  initSchema(db);
  const now = new Date(nowMs).toISOString();
  const due = db.prepare("SELECT * FROM quoxseo_report_schedules WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now);
  const results = [];
  for (const s of due) {
    const attempt = (s.fail_count || 0) + 1;
    const runId = `${s.id}~${s.cycle_for}~${attempt}`;
    // Transactional claim: PK insert fences concurrent ticks.
    try {
      db.prepare('INSERT INTO quoxseo_report_runs (id, schedule_id, org_id, cycle_for, attempt, started_at) VALUES (?,?,?,?,?,?)')
        .run(runId, s.id, s.org_id, s.cycle_for, attempt, now);
    } catch { continue; } // already claimed by another tick

    const outstanding = safeJson(s.outstanding_channels) || safeJson(s.channels) || DEFAULT_CHANNELS;
    let outcome, detail = {}, reportId = null, acknowledged = [];
    try {
      const r = await deliver({ orgId: s.org_id, siteId: s.site_id, recipientEmail: s.recipient_email, channels: outstanding, requireData: true });
      reportId = r.report_id ?? r.report?.report_id ?? null;
      if (r.skipped === 'no_data' || r.unavailable) {
        outcome = 'empty';
        detail = { reason: 'no_data', report: r.report };
      } else {
        // A channel counts delivered ONLY on an acknowledged result, never on
        // a bare 200. inbox with a null id is 'unknown', not delivered.
        const ack = {};
        if (outstanding.includes('email')) ack.email = r.email && r.email.success === true ? 'delivered' : (r.email && r.email.error ? 'failed' : 'unknown');
        if (outstanding.includes('inbox')) ack.inbox = r.inbox && r.inbox.id != null ? 'delivered' : (r.inbox && r.inbox.error ? 'failed' : 'unknown');
        for (const [ch, oc] of Object.entries(ack)) {
          recordAttempt(db, runId, ch, s.recipient_email || '', oc, now);
          if (oc === 'delivered') acknowledged.push(ch);
        }
        const stillOut = outstanding.filter((c) => !acknowledged.includes(c));
        detail = { channels: ack, report: r.report, pdf_attached: r.pdf_attached === true };
        if (stillOut.length === 0) outcome = 'delivered';
        else if (acknowledged.length > 0) outcome = 'partial';
        else if (Object.values(ack).includes('unknown')) outcome = 'delivery_unknown';
        else outcome = 'transient_failure';
        detail.outstanding = stillOut;
      }
    } catch (err) {
      // Exception AFTER a possible partial send: ambiguous. Never claim exactly
      // once, never blindly assume it went; record delivery_unknown and retry.
      outcome = outstanding.includes('email') ? 'delivery_unknown' : 'transient_failure';
      detail = { error: String(err && err.message || err) };
    }

    const newReport = reportId && reportId !== s.last_report_id;
    const progressed = acknowledged.length > 0 || (outcome === 'delivered' && newReport);
    applyOutcome(db, s, { attempt, runId, outcome, detail, reportId, acknowledged, progressed, nowMs, rand });
    results.push({ scheduleId: s.id, runId, attempt, outcome, acknowledged, reportId });
    if (log) log(`[QuoxSEO sched] ${s.id} cycle ${s.cycle_for} attempt ${attempt} -> ${outcome}`);
  }
  return results;
}

function applyOutcome(db, s, { attempt, runId, outcome, detail, reportId, acknowledged, progressed, nowMs, rand }) {
  const now = new Date(nowMs).toISOString();
  const cfg = cfgOf(s);
  const finishRun = db.prepare('UPDATE quoxseo_report_runs SET finished_at=?, report_id=?, outcome=?, detail=? WHERE id=?');
  const upd = db.prepare(`UPDATE quoxseo_report_schedules SET status=@status, status_reason=@status_reason,
     cycle_for=@cycle_for, next_run_at=@next_run_at, last_run_at=@last_run_at, last_report_id=@last_report_id,
     outstanding_channels=@outstanding, fail_count=@fail_count, noprogress_count=@noprogress_count, updated_at=@now
     WHERE id=@id`);
  const tx = db.transaction(() => {
    finishRun.run(now, reportId, outcome, JSON.stringify(detail), runId);

    let status = 'active', status_reason = s.status_reason, cycleFor = s.cycle_for, nextRun, lastReport = s.last_report_id;
    let outstanding = detail.outstanding || safeJson(s.outstanding_channels) || safeJson(s.channels);
    let failCount = s.fail_count || 0, noprog = s.noprogress_count || 0;

    const advanceCycle = () => {
      cycleFor = computeNextRun(cfg, Date.parse(now));
      nextRun = cycleFor;
      outstanding = safeJson(s.channels);
      failCount = 0;
    };

    if (outcome === 'delivered') {
      if (reportId) lastReport = reportId;
      noprog = progressed ? 0 : (newCycleUnchanged(reportId, s) ? noprog + 1 : 0);
      advanceCycle();
      // Repeated unchanged data across cycles is a product signal, not an error:
      // we still deliver, but flag if it stays flat a long time (no pause).
    } else if (outcome === 'empty') {
      // No warehouse data. Retry on backoff a few times (data may land), then
      // give up on THIS cycle and count a no-progress cycle; pause if chronic.
      if (attempt >= MAX_ATTEMPTS) {
        noprog += 1;
        if (noprog >= MAX_NOPROGRESS_CYCLES) { status = 'paused'; status_reason = 'repeated no-data cycles; check the site connection'; }
        advanceCycle();
      } else {
        failCount = attempt;
        nextRun = new Date(nowMs + backoffMs(failCount, rand)).toISOString();
      }
    } else {
      // partial | transient_failure | delivery_unknown -> retry the OUTSTANDING
      // channels only, on backoff, until the ladder is exhausted; then retire
      // this cycle as a permanent failure and move on to the next interval.
      if (reportId) lastReport = reportId; // a report WAS produced; remember it
      if (progressed) failCount = 0; // a channel was newly acknowledged this attempt
      if (attempt >= MAX_ATTEMPTS) {
        // retire this cycle's outstanding channels
        db.prepare('UPDATE quoxseo_report_runs SET outcome=? WHERE id=?').run('permanent_failure', runId);
        noprog = progressed ? 0 : noprog + 1;
        if (noprog >= MAX_NOPROGRESS_CYCLES) { status = 'paused'; status_reason = 'delivery failing across cycles; review recipient/channels'; }
        advanceCycle();
      } else {
        failCount = progressed ? 1 : attempt;
        nextRun = new Date(nowMs + backoffMs(failCount, rand)).toISOString();
      }
    }

    upd.run({
      id: s.id, status, status_reason, cycle_for: cycleFor, next_run_at: nextRun,
      last_run_at: now, last_report_id: lastReport, outstanding: JSON.stringify(outstanding),
      fail_count: failCount, noprogress_count: noprog, now,
    });
  });
  tx();
}

function newCycleUnchanged(reportId, s) {
  return reportId && s.last_report_id && reportId === s.last_report_id;
}
function recordAttempt(db, runId, channel, recipient, outcome, at) {
  try {
    db.prepare('INSERT OR IGNORE INTO quoxseo_delivery_attempts (run_id, channel, recipient, outcome, at) VALUES (?,?,?,?,?)')
      .run(runId, channel, recipient || '', outcome, at);
  } catch { /* accounting is best-effort; the run row is the source of truth */ }
}
function safeJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }

module.exports = {
  initSchema, createSchedule, getSchedule, listSchedules, setStatus,
  computeNextRun, backoffMs, runDueSchedules,
  BACKOFF_MINUTES, MAX_ATTEMPTS, MAX_NOPROGRESS_CYCLES,
};
