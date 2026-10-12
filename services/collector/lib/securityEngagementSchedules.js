'use strict';

/**
 * QUOX-SECURITY-SCHED Phase 1: recurring scan schedule storage. A schedule
 * is a standing instruction to re-run a given tool against a given target
 * on a fixed cadence, owned by an engagement. Pure CRUD + the due-query
 * here; the actual scheduler loop that reads listDueSchedules and fires
 * jobs (writing schedule_id back onto security_scan_jobs) is a later
 * phase, same storage/execution split as securityScanJobs.js and
 * securityFindings.js.
 *
 * Schema: migrations/security/004-engagement-schedules.sql.
 */

const { generateUlid } = require('./imageStore.js');
const securityEngagement = require('./securityEngagement.js');
const securityCron = require('./securityCron.js');

// Reject cadences faster than this to stop a misconfigured schedule from
// hammering a target.
const MIN_INTERVAL_SECONDS = 300;

function defaultNow() {
  return new Date().toISOString();
}

function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

/**
 * Compute the next_run_at for a schedule from a reference instant. A cron
 * schedule advances to the next UTC cron fire strictly after fromIso; an
 * interval schedule advances by interval_seconds. This is the single
 * next-run computation for both cadence kinds.
 *
 * @param {{schedule_kind?:string, interval_seconds?:number, cron_expression?:string}} schedule
 * @param {string} fromIso
 * @returns {string} ISO-8601 UTC
 */
function computeNextRun(schedule, fromIso) {
  if (schedule && schedule.schedule_kind === 'cron') {
    return securityCron.nextCronTime(schedule.cron_expression, fromIso);
  }
  return addSeconds(fromIso, schedule.interval_seconds);
}

function parseScheduleRow(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled };
}

/**
 * @param {{engagement_id:string, org_id:string, target_value:string, tool:string, interval_seconds:number, created_by?:string}} input
 * @param {object} deps - { db, now? } - now is a () => ISO-8601 string clock, test override
 */
function createSchedule(input, deps) {
  const { db } = deps;
  const now = deps.now || defaultNow;
  const {
    engagement_id, org_id, target_value, tool, interval_seconds, created_by,
    schedule_kind, cron_expression, timezone,
  } = input || {};

  const kind = schedule_kind || 'interval';
  if (kind !== 'interval' && kind !== 'cron') {
    throw new Error(`schedule_kind must be "interval" or "cron", got "${kind}"`);
  }

  if (!org_id) throw new Error('org_id is required');
  const engagement = securityEngagement.getEngagement(engagement_id, org_id, { db });
  if (!engagement) throw new Error(`Engagement "${engagement_id}" not found or not authorized for org "${org_id}"`);
  if (!target_value || !String(target_value).trim()) throw new Error('target_value is required');
  if (!tool || !String(tool).trim()) throw new Error('tool is required');

  // Cron rows store interval_seconds = 0 (a sentinel never read for cron
  // cadence): the column is NOT NULL and SQLite cannot drop that without a
  // table rebuild. Interval rows keep the enforced floor.
  let storedInterval = interval_seconds;
  if (kind === 'cron') {
    if (!cron_expression || !String(cron_expression).trim()) {
      throw new Error('cron_expression is required for a cron schedule');
    }
    securityCron.parseCron(cron_expression); // throws on malformed input
    securityCron.assertCronNotTooFrequent(cron_expression); // mirror the interval floor
    storedInterval = 0;
  } else if (!Number.isInteger(interval_seconds) || interval_seconds < MIN_INTERVAL_SECONDS) {
    throw new Error(`interval_seconds must be an integer of at least ${MIN_INTERVAL_SECONDS} (the enforced floor)`);
  }

  const nowIso = now();
  const id = `SCH_${generateUlid()}`;
  const nextRunAt = computeNextRun({ schedule_kind: kind, interval_seconds: storedInterval, cron_expression }, nowIso);
  db.prepare(`
    INSERT INTO security_engagement_schedules (
      id, engagement_id, org_id, target_value, tool, interval_seconds, enabled,
      next_run_at, created_by, created_at, updated_at,
      schedule_kind, cron_expression, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, engagement_id, org_id, target_value, tool, storedInterval,
    nextRunAt, created_by || null, nowIso, nowIso,
    kind, kind === 'cron' ? cron_expression : null, timezone || null
  );

  return getSchedule(id, org_id, deps);
}

function getSchedule(id, orgId, deps) {
  const row = deps.db.prepare(
    'SELECT * FROM security_engagement_schedules WHERE id = ? AND org_id = ?'
  ).get(id, orgId);
  return parseScheduleRow(row);
}

function listSchedules(engagementId, orgId, deps) {
  const rows = deps.db.prepare(
    'SELECT * FROM security_engagement_schedules WHERE engagement_id = ? AND org_id = ? ORDER BY created_at DESC, rowid DESC'
  ).all(engagementId, orgId);
  return rows.map(parseScheduleRow);
}

/**
 * Deliberately NOT org-scoped: this is the internal scheduler's
 * system-wide due-query, meant to be called from a server-side loop that
 * fires jobs across every org's engagements, not from any org-facing
 * route. Callers exposing this to a user-facing API must add org scoping
 * themselves; this function must not.
 *
 * @param {object} deps - { db }
 * @param {string} [nowIso] - defaults to deps.now() or the real clock
 */
function listDueSchedules(deps, nowIso) {
  const now = deps.now || defaultNow;
  const cutoff = nowIso || now();
  const rows = deps.db.prepare(`
    SELECT * FROM security_engagement_schedules
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `).all(cutoff);
  return rows.map(parseScheduleRow);
}

/**
 * Records the outcome of a fired run and advances next_run_at, whether the
 * run succeeded or failed. A failing scan must not wedge the schedule.
 *
 * @param {string} id
 * @param {{job_id:string, status:string, ran_at:string}} args
 * @param {object} deps - { db, now? }
 */
function recordRun(id, { job_id, status, ran_at } = {}, deps) {
  const { db } = deps;
  const now = deps.now || defaultNow;
  const schedule = db.prepare('SELECT * FROM security_engagement_schedules WHERE id = ?').get(id);
  if (!schedule) throw new Error(`Schedule "${id}" not found`);

  const nextRunAt = computeNextRun(schedule, ran_at);
  db.prepare(`
    UPDATE security_engagement_schedules
    SET last_run_at = ?, last_job_id = ?, last_status = ?, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(ran_at, job_id || null, status || null, nextRunAt, now(), id);

  const row = db.prepare('SELECT * FROM security_engagement_schedules WHERE id = ?').get(id);
  return parseScheduleRow(row);
}

/**
 * @param {string} id
 * @param {string} orgId
 * @param {boolean|0|1} enabled
 * @param {object} deps - { db, now? }
 */
function setEnabled(id, orgId, enabled, deps) {
  const { db } = deps;
  const now = deps.now || defaultNow;
  const schedule = getSchedule(id, orgId, deps);
  if (!schedule) throw new Error(`Schedule "${id}" not found or not authorized for org "${orgId}"`);

  const enabledInt = enabled ? 1 : 0;
  const nowIso = now();
  let nextRunAt = schedule.next_run_at;
  if (enabledInt && (!nextRunAt || nextRunAt <= nowIso)) {
    // Re-arm into the future rather than firing an immediate backlog burst
    // for time that passed while the schedule was disabled.
    nextRunAt = computeNextRun(schedule, nowIso);
  }

  db.prepare(`
    UPDATE security_engagement_schedules
    SET enabled = ?, next_run_at = ?, updated_at = ?
    WHERE id = ? AND org_id = ?
  `).run(enabledInt, nextRunAt, nowIso, id, orgId);

  return getSchedule(id, orgId, deps);
}

function deleteSchedule(id, orgId, deps) {
  const result = deps.db.prepare(
    'DELETE FROM security_engagement_schedules WHERE id = ? AND org_id = ?'
  ).run(id, orgId);
  return result.changes > 0;
}

/**
 * Apply a partial update to a schedule. Only the fields present in `patch`
 * are changed; everything else is carried over from the stored row. The
 * result is re-validated exactly as createSchedule validates: an interval
 * schedule enforces the MIN_INTERVAL_SECONDS floor, a cron schedule requires
 * a valid, not-too-frequent cron_expression and stores interval_seconds = 0.
 * When the cadence changes (kind flips, interval value changes, or cron
 * expression changes) next_run_at is recomputed from now so the new cadence
 * takes effect on the next fire rather than honouring the stale next_run_at.
 *
 * @param {string} scheduleId
 * @param {string} orgId
 * @param {{target_value?:string, tool?:string, interval_seconds?:number, schedule_kind?:string, cron_expression?:string, timezone?:string, enabled?:boolean|0|1}} patch
 * @param {object} deps - { db, now? }
 */
function updateSchedule(scheduleId, orgId, patch, deps) {
  const { db } = deps;
  const now = deps.now || defaultNow;
  const existing = getSchedule(scheduleId, orgId, deps);
  if (!existing) throw new Error(`Schedule "${scheduleId}" not found or not authorized for org "${orgId}"`);

  const p = patch || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);

  // Resolve the resulting field values, patch overriding the stored row.
  const target_value = has('target_value') ? p.target_value : existing.target_value;
  const tool = has('tool') ? p.tool : existing.tool;
  const kind = has('schedule_kind') ? p.schedule_kind : (existing.schedule_kind || 'interval');
  const cronExpr = has('cron_expression') ? p.cron_expression : existing.cron_expression;
  const timezone = has('timezone') ? p.timezone : existing.timezone;
  const enabledInt = has('enabled') ? (p.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);

  if (kind !== 'interval' && kind !== 'cron') {
    throw new Error(`schedule_kind must be "interval" or "cron", got "${kind}"`);
  }
  if (!target_value || !String(target_value).trim()) throw new Error('target_value is required');
  if (!tool || !String(tool).trim()) throw new Error('tool is required');

  let storedInterval;
  let storedCron;
  if (kind === 'cron') {
    if (!cronExpr || !String(cronExpr).trim()) {
      throw new Error('cron_expression is required for a cron schedule');
    }
    securityCron.parseCron(cronExpr); // throws on malformed input
    securityCron.assertCronNotTooFrequent(cronExpr); // mirror the interval floor
    storedInterval = 0;
    storedCron = cronExpr;
  } else {
    const intervalSeconds = has('interval_seconds') ? p.interval_seconds : existing.interval_seconds;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
      throw new Error(`interval_seconds must be an integer of at least ${MIN_INTERVAL_SECONDS} (the enforced floor)`);
    }
    storedInterval = intervalSeconds;
    storedCron = null;
  }

  const cadenceChanged =
    kind !== existing.schedule_kind ||
    (kind === 'interval' && storedInterval !== existing.interval_seconds) ||
    (kind === 'cron' && storedCron !== existing.cron_expression);

  const nowIso = now();
  let nextRunAt = existing.next_run_at;
  if (cadenceChanged) {
    nextRunAt = computeNextRun({ schedule_kind: kind, interval_seconds: storedInterval, cron_expression: storedCron }, nowIso);
  }

  db.prepare(`
    UPDATE security_engagement_schedules
    SET target_value = ?, tool = ?, interval_seconds = ?, enabled = ?,
        next_run_at = ?, updated_at = ?,
        schedule_kind = ?, cron_expression = ?, timezone = ?
    WHERE id = ? AND org_id = ?
  `).run(
    target_value, tool, storedInterval, enabledInt,
    nextRunAt, nowIso,
    kind, storedCron, timezone || null,
    scheduleId, orgId
  );

  return getSchedule(scheduleId, orgId, deps);
}

/**
 * QUOX-SECURITY-SCHED Phase 3: records the outcome of diffing a completed
 * run against the schedule's prior successful run. Stores a COMPACT
 * summary — counts plus the newHighSeverity items — not the full
 * unchanged/removed sets, to keep last_diff_json bounded regardless of how
 * large a single scan's output is (see migrations/security/005-schedule-diff.sql).
 *
 * @param {string} id
 * @param {{added:Array, removed:Array, unchanged:Array, newHighSeverity:Array}} diffSummary
 * @param {object} deps - { db, now? }
 */
function recordDiff(id, diffSummary, deps) {
  const { db } = deps;
  const now = deps.now || defaultNow;
  const summary = {
    addedCount: diffSummary.added.length,
    removedCount: diffSummary.removed.length,
    unchangedCount: diffSummary.unchanged.length,
    newHighSeverity: diffSummary.newHighSeverity,
  };

  const nowIso = now();
  db.prepare(`
    UPDATE security_engagement_schedules
    SET last_diff_json = ?, last_diff_at = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(summary), nowIso, nowIso, id);

  const row = db.prepare('SELECT * FROM security_engagement_schedules WHERE id = ?').get(id);
  return parseScheduleRow(row);
}

module.exports = {
  MIN_INTERVAL_SECONDS,
  computeNextRun,
  createSchedule,
  getSchedule,
  listSchedules,
  listDueSchedules,
  recordRun,
  setEnabled,
  deleteSchedule,
  updateSchedule,
  recordDiff,
};
